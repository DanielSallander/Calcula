//! FILENAME: app/src/api/scriptHost/__tests__/workbookSaveExecutor.test.ts
// PURPOSE: The RUNTIME half of G1 — what actually happens when a script saves
//          the workbook or asks the user for a file. Four properties, each of
//          which is a way the feature could silently become unsafe:
//            1. a Before-Save VETO stops a script-initiated save, exactly as it
//               stops Ctrl+S, and comes back as { saved: false } rather than as
//               a silent success;
//            2. a cancelled picker RESOLVES (null / saved:false) — never hangs,
//               never rejects, never reports success;
//            3. size caps are enforced, and an oversized import is REFUSED
//               rather than truncated (a half-read CSV is corrupt data that
//               looks like good data);
//            4. the rate limit and the onBeforeSave re-entrancy guard hold.
// CONTEXT: Everything is driven through the REAL code paths — the real
//          lifecycleGuards registry, the real core/lib/file-api save, the real
//          filesystem picker wrappers — with only Tauri (the dialog plugin and
//          the invoke bridge) replaced. A test that re-implemented the save path
//          would prove nothing about the one that ships.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ---- Tauri seams -------------------------------------------------------------

const saveDialog = vi.fn();
const openDialog = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: (...a: unknown[]) => saveDialog(...a),
  open: (...a: unknown[]) => openDialog(...a),
}));

const tracedInvoke = vi.fn();
vi.mock("../../../utils/bridge", () => ({
  tracedInvoke: (...a: unknown[]) => tracedInvoke(...a),
  tracedInvokeSilent: (...a: unknown[]) => tracedInvoke(...a),
}));

const invokeBackend = vi.fn();
vi.mock("../../backend", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, invokeBackend: (...a: unknown[]) => invokeBackend(...a) };
});

import {
  registerLifecycleGuard,
  resetLifecycleGuards,
} from "../../../core/lib/lifecycleGuards";
import {
  exportTextViaPicker,
  importTextViaPicker,
  fileNameOf,
} from "../../filesystem";
import { brokerCall, buildHandleFromDefinition } from "../broker";
import { recordCapabilityGrant, resetAllGrants } from "../capabilities";
import {
  assertScriptSaveAllowed,
  executeWorkbookSave,
  isCollectingLifecycleVerdict,
  recordScriptSave,
  resetScriptSaveLimits,
  withLifecycleVerdictDepth,
  SCRIPT_SAVE_MIN_INTERVAL_MS,
} from "../host";

const SCRIPT = "g1-runtime-script";

beforeEach(() => {
  saveDialog.mockReset();
  openDialog.mockReset();
  tracedInvoke.mockReset();
  invokeBackend.mockReset();
  // The broker's audit write-through is fire-and-forget (`void invoke(...)
  // .catch(...)`), so the seam must return a promise or the audit path throws
  // for reasons that have nothing to do with the code under test.
  invokeBackend.mockResolvedValue(undefined);
  resetLifecycleGuards();
  resetScriptSaveLimits();
  resetAllGrants();
});

afterEach(() => {
  resetLifecycleGuards();
  resetScriptSaveLimits();
});

/** Wire the backend commands core/lib/file-api calls during a save. */
function stubBackendForSave(currentPath: string | null): void {
  tracedInvoke.mockImplementation(async (cmd: string) => {
    switch (cmd) {
      case "get_current_file_path":
        return currentPath;
      case "is_file_modified":
        return true;
      case "save_file":
        return undefined;
      case "xlsx_save_loss_report":
        return [];
      default:
        return undefined;
    }
  });
}

/** Which backend commands were invoked, in order. */
function invokedCommands(): string[] {
  return tracedInvoke.mock.calls.map((c) => c[0] as string);
}

// ============================================================================
// 1. A Before-Save veto stops a SCRIPT save, exactly as it stops Ctrl+S
// ============================================================================

describe("a script-initiated save is vetoable", () => {
  it("does not write the file when a guard objects, and reports saved:false", async () => {
    stubBackendForSave("C:/work/Budget.cala");
    const objections: string[] = [];
    registerLifecycleGuard(async (action) => {
      objections.push(action);
      return { by: "Month-end checks", reason: "D21 is empty" };
    });

    const result = await executeWorkbookSave(SCRIPT, "save");

    expect(result).toEqual({ saved: false, name: null });
    expect(objections).toEqual(["save"]);
    // THE point of the test: the veto happened BEFORE any write.
    expect(invokedCommands()).not.toContain("save_file");
  });

  it("writes the file, and hands back only the NAME, when every guard allows", async () => {
    stubBackendForSave("C:/Users/someone/Consulting/ClientX/Budget.cala");
    registerLifecycleGuard(async () => null);

    const result = await executeWorkbookSave(SCRIPT, "save");

    expect(result).toEqual({ saved: true, name: "Budget.cala" });
    expect(invokedCommands()).toContain("save_file");
    // The directory is never handed to a script: it is useless to a sandboxed
    // caller and revealing about the user.
    expect(JSON.stringify(result)).not.toContain("Consulting");
    expect(JSON.stringify(result)).not.toContain("Users");
  });

  it("refuses — rather than silently opening a picker — when there is no file yet", async () => {
    stubBackendForSave(null);
    await expect(executeWorkbookSave(SCRIPT, "save")).rejects.toThrow(/never been saved/);
    // No picker was opened, and nothing was written.
    expect(saveDialog).not.toHaveBeenCalled();
    expect(invokedCommands()).not.toContain("save_file");
  });
});

// ============================================================================
// 2. Cancellation resolves cleanly — it never hangs and never lies
// ============================================================================

describe("cancellation is a normal outcome everywhere", () => {
  it("saveAs resolves saved:false when the user dismisses the picker", async () => {
    stubBackendForSave("C:/work/Budget.cala");
    saveDialog.mockResolvedValue(null);

    const result = await executeWorkbookSave(SCRIPT, "saveAs");

    expect(result).toEqual({ saved: false, name: null });
    expect(invokedCommands()).not.toContain("save_file");
  });

  it("saveAs resolves saved:false when a Before-Save guard vetoes after the picker", async () => {
    stubBackendForSave("C:/work/Budget.cala");
    saveDialog.mockResolvedValue("C:/work/Copy.cala");
    registerLifecycleGuard(async () => ({ by: "Month-end checks" }));

    const result = await executeWorkbookSave(SCRIPT, "saveAs");

    expect(result).toEqual({ saved: false, name: null });
    expect(invokedCommands()).not.toContain("save_file");
  });

  it("exportText resolves null when the user dismisses the save picker", async () => {
    saveDialog.mockResolvedValue(null);

    const result = await exportTextViaPicker({
      suggestedName: "report.csv",
      content: "a,b\n1,2",
      filterName: "CSV file",
      filterExtensions: ["csv"],
      title: "Script — save a file",
    });

    expect(result).toBeNull();
    // Nothing was written on the way out.
    expect(invokeBackend).not.toHaveBeenCalled();
  });

  it("importText resolves null when the user dismisses the open picker", async () => {
    openDialog.mockResolvedValue(null);

    const result = await importTextViaPicker({
      filterName: "CSV file",
      filterExtensions: ["csv"],
      title: "Script — open a file",
      maxChars: 1000,
    });

    expect(result).toBeNull();
    expect(invokeBackend).not.toHaveBeenCalled();
  });
});

// ============================================================================
// 3. The picker chooses the path; the caller only suggests a NAME
// ============================================================================

describe("the picker owns the path in both directions", () => {
  it("passes the suggestion as a NAME and returns only the chosen name", async () => {
    saveDialog.mockResolvedValue("D:/Reports/2026/q3-final.csv");
    invokeBackend.mockResolvedValue(undefined);

    const result = await exportTextViaPicker({
      suggestedName: "report.csv",
      content: "a,b\n1,2",
      filterName: "CSV file",
      filterExtensions: ["csv"],
      encoding: "utf-8-bom",
      title: "Script — save a file",
    });

    // The suggestion is a bare name in the dialog's name box...
    expect(saveDialog).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: "report.csv" }),
    );
    // ...the write goes to the path the USER chose...
    expect(invokeBackend).toHaveBeenCalledWith("write_text_file", {
      path: "D:/Reports/2026/q3-final.csv",
      content: "a,b\n1,2",
      encoding: "utf-8-bom",
    });
    // ...and only the name comes back.
    expect(result).toBe("q3-final.csv");
  });

  it("returns the file NAME and contents on import, never the folder", async () => {
    openDialog.mockResolvedValue("C:/Users/someone/Downloads/rates.csv");
    invokeBackend.mockResolvedValue("usd,1.09\neur,1.00");

    const result = await importTextViaPicker({
      filterName: "CSV file",
      filterExtensions: ["csv"],
      title: "Script — open a file",
      maxChars: 1000,
    });

    expect(result).toEqual({ name: "rates.csv", content: "usd,1.09\neur,1.00" });
    expect(JSON.stringify(result)).not.toContain("Downloads");
  });

  it("always offers an All Files row so a script's filter cannot trap the user", async () => {
    saveDialog.mockResolvedValue(null);
    await exportTextViaPicker({
      suggestedName: "report.csv",
      content: "x",
      filterName: "CSV file",
      filterExtensions: ["csv"],
      title: "t",
    });
    const filters = saveDialog.mock.calls[0][0].filters as Array<{ name: string }>;
    expect(filters.map((f) => f.name)).toContain("All Files");
  });

  it("fileNameOf strips both separators (the one implementation of the rule)", () => {
    expect(fileNameOf("C:\\Users\\me\\a.csv")).toBe("a.csv");
    expect(fileNameOf("/home/me/a.csv")).toBe("a.csv");
    expect(fileNameOf("a.csv")).toBe("a.csv");
  });
});

// ============================================================================
// 4. Size caps — refuse, never truncate
// ============================================================================

describe("size caps", () => {
  it("REFUSES an oversized import instead of handing back a truncated file", async () => {
    openDialog.mockResolvedValue("C:/data/huge.csv");
    invokeBackend.mockResolvedValue("x".repeat(5_000));

    await expect(
      importTextViaPicker({
        filterName: "CSV file",
        filterExtensions: ["csv"],
        title: "t",
        maxChars: 1_000,
      }),
    ).rejects.toThrow(/5000 characters.*limit is 1000/);
  });

  it("accepts a file exactly at the cap", async () => {
    openDialog.mockResolvedValue("C:/data/ok.csv");
    invokeBackend.mockResolvedValue("x".repeat(1_000));

    const result = await importTextViaPicker({
      filterName: "CSV file",
      filterExtensions: ["csv"],
      title: "t",
      maxChars: 1_000,
    });
    expect(result?.content.length).toBe(1_000);
  });
});

// ============================================================================
// 5. Rate limit + onBeforeSave re-entrancy
// ============================================================================

describe("a save loop cannot thrash the disk", () => {
  it("refuses a second save inside the minimum interval, then allows it after", () => {
    const t0 = 1_000_000;
    expect(() => assertScriptSaveAllowed(SCRIPT, t0)).not.toThrow();
    recordScriptSave(SCRIPT, t0);
    expect(() => assertScriptSaveAllowed(SCRIPT, t0 + 10)).toThrow(/too often/);
    expect(() =>
      assertScriptSaveAllowed(SCRIPT, t0 + SCRIPT_SAVE_MIN_INTERVAL_MS),
    ).not.toThrow();
  });

  it("meters each script separately — one busy script cannot lock out another", () => {
    const t0 = 2_000_000;
    recordScriptSave("script-a", t0);
    expect(() => assertScriptSaveAllowed("script-b", t0)).not.toThrow();
    expect(() => assertScriptSaveAllowed("script-a", t0 + 1)).toThrow(/too often/);
  });

  it("does NOT spend the budget on a save that refused for want of a file", async () => {
    // The natural pattern is `save()` and, on failure, `saveAs()`. A refused
    // save that consumed the bucket would make that second line fail too, with
    // a message about saving too often.
    stubBackendForSave(null);
    await expect(executeWorkbookSave(SCRIPT, "save")).rejects.toThrow(/never been saved/);
    saveDialog.mockResolvedValue("C:/work/New.cala");
    await expect(executeWorkbookSave(SCRIPT, "saveAs")).resolves.toEqual({
      saved: true,
      name: "New.cala",
    });
  });

  it("does spend the budget on a save the user then cancelled", async () => {
    stubBackendForSave("C:/work/Budget.cala");
    registerLifecycleGuard(async () => ({ by: "Month-end checks" }));
    await expect(executeWorkbookSave(SCRIPT, "save")).resolves.toEqual({
      saved: false,
      name: null,
    });
    // The guards really ran; retrying in a tight loop is exactly the thrash the
    // limit exists to stop.
    await expect(executeWorkbookSave(SCRIPT, "save")).rejects.toThrow(/too often/);
  });

  it("refuses a save started while a Before-Save verdict is being collected", async () => {
    stubBackendForSave("C:/work/Budget.cala");
    expect(isCollectingLifecycleVerdict()).toBe(false);

    // withLifecycleVerdictDepth is exactly what wireLifecycleGuardForwarder
    // wraps a script's onBeforeSave in, so this is the production rule — the
    // recursion it prevents (handler saves -> guards run -> handler saves...)
    // would otherwise need a live worker to reproduce.
    await withLifecycleVerdictDepth(async () => {
      expect(isCollectingLifecycleVerdict()).toBe(true);
      // A DIFFERENT script id, so this is not the rate limiter talking.
      await expect(executeWorkbookSave("some-other-script", "save")).rejects.toThrow(
        /onBeforeSave/,
      );
      // Nothing was written, and no picker appeared.
      expect(invokedCommands()).not.toContain("save_file");
      expect(saveDialog).not.toHaveBeenCalled();
    });

    expect(isCollectingLifecycleVerdict()).toBe(false);
    // ...and once the verdict is done, saving works again.
    registerLifecycleGuard(async () => null);
    await expect(executeWorkbookSave("some-other-script", "save")).resolves.toEqual({
      saved: true,
      name: "Budget.cala",
    });
  });

  it("does not spend the budget on a lifecycle-verdict refusal either", async () => {
    stubBackendForSave("C:/work/Budget.cala");
    await withLifecycleVerdictDepth(async () => {
      await expect(executeWorkbookSave(SCRIPT, "save")).rejects.toThrow(/onBeforeSave/);
    });
    registerLifecycleGuard(async () => null);
    await expect(executeWorkbookSave(SCRIPT, "save")).resolves.toEqual({
      saved: true,
      name: "Budget.cala",
    });
  });

  it("restores the depth even when the verdict throws", async () => {
    await expect(
      withLifecycleVerdictDepth(async () => {
        throw new Error("handler exploded");
      }),
    ).rejects.toThrow("handler exploded");
    expect(isCollectingLifecycleVerdict()).toBe(false);
  });
});

// ============================================================================
// 6. Every file.picker call reaches the workbook audit log
// ============================================================================
//
// The broker audits automatically, but "automatically" is only true for
// capability-BEARING methods that are not already recorded server-side. This
// pins that file.picker really lands in both directions — the transparency
// promise is that a user can discover, after the fact, that a script wrote a
// file, and an unaudited capability call would break exactly that.

describe("file.picker calls are audited", () => {
  it("persists a successful call, with the capability named", async () => {
    resetAllGrants();
    const h = buildHandleFromDefinition({
      id: "audit-script",
      name: "Audit test",
      objectType: "workbook",
      instanceId: null,
      accessLevel: "restricted",
      declaredCapabilities: ["file.picker"],
    });
    recordCapabilityGrant("audit-script", "file.picker");

    await brokerCall(h, "cap.fileExportText", ["a.csv", "x"], async () => "chosen.csv");

    expect(invokeBackend).toHaveBeenCalledWith(
      "audit_record_capability",
      expect.objectContaining({
        scriptId: "audit-script",
        capability: "file.picker",
        ok: true,
      }),
    );
  });

  it("persists a DENIAL too — an attempt is as interesting as a success", async () => {
    resetAllGrants();
    const h = buildHandleFromDefinition({
      id: "audit-denied",
      name: "Audit test",
      objectType: "workbook",
      instanceId: null,
      accessLevel: "restricted",
      declaredCapabilities: ["file.picker"],
    });

    await expect(
      brokerCall(h, "cap.fileImportText", [undefined], async () => null),
    ).rejects.toMatchObject({ code: "CapabilityRequired" });

    expect(invokeBackend).toHaveBeenCalledWith(
      "audit_record_capability",
      expect.objectContaining({
        scriptId: "audit-denied",
        capability: "file.picker",
        ok: false,
        error: "CapabilityRequired",
      }),
    );
  });
});
