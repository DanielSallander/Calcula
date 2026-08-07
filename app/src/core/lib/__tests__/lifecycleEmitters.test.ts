//! FILENAME: app/src/core/lib/__tests__/lifecycleEmitters.test.ts
// PURPOSE: Pin the EMITTER halves of B5 — that saveFile actually awaits the
//          veto before touching the backend, and that the sheet CRUD wrappers
//          announce the sheet-collection changes with resolvable names.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const tracedInvoke = vi.fn();
const invoke = vi.fn();
const dialogSave = vi.fn();

vi.mock("../../../utils/bridge", () => ({ tracedInvoke: (...a: unknown[]) => tracedInvoke(...a) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
  save: (...a: unknown[]) => dialogSave(...a),
}));

import { saveFile, saveFileAs } from "../file-api";
import { addSheet, calculateSheet, copySheet, deleteSheet, renameSheet } from "../tauri-api";
import { AppEvents, onAppEvent } from "../events";
import {
  registerLifecycleCancelReporter,
  registerLifecycleGuard,
  resetLifecycleGuards,
} from "../lifecycleGuards";

function capture(eventName: string): { events: unknown[]; off: () => void } {
  const events: unknown[] = [];
  const off = onAppEvent(eventName, (d) => events.push(d));
  return { events, off };
}

beforeEach(() => {
  tracedInvoke.mockReset();
  invoke.mockReset();
  dialogSave.mockReset();
  resetLifecycleGuards();
  registerLifecycleCancelReporter(() => {});
});

afterEach(() => {
  resetLifecycleGuards();
});

// ============================================================================
// saveFile: the veto is AWAITED, not fired and forgotten
// ============================================================================

describe("saveFile + lifecycle guards", () => {
  beforeEach(() => {
    tracedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_current_file_path") return "C:/books/q4.cala";
      if (cmd === "is_file_modified") return false;
      return undefined;
    });
  });

  it("saves when no guard objects", async () => {
    const before = capture(AppEvents.BEFORE_SAVE);
    const after = capture(AppEvents.AFTER_SAVE);

    await expect(saveFile()).resolves.toBe("C:/books/q4.cala");
    expect(tracedInvoke).toHaveBeenCalledWith("save_file", {
      path: "C:/books/q4.cala",
      password: undefined,
    });
    expect(before.events).toEqual([{ path: "C:/books/q4.cala" }]);
    expect(after.events).toHaveLength(1);
    before.off();
    after.off();
  });

  it("NEVER reaches save_file when a guard cancels", async () => {
    registerLifecycleGuard(async () => ({ by: "Month-end", reason: "D21 is empty" }));
    const before = capture(AppEvents.BEFORE_SAVE);
    const after = capture(AppEvents.AFTER_SAVE);

    await expect(saveFile()).resolves.toBeNull();
    expect(tracedInvoke.mock.calls.map((c) => c[0])).not.toContain("save_file");
    // The broadcast is suppressed too: nothing should do save-prep work for a
    // save that is not happening.
    expect(before.events).toHaveLength(0);
    expect(after.events).toHaveLength(0);
    before.off();
    after.off();
  });

  it("hands the target path AND the save kind to the guard so it can branch", async () => {
    const seen: unknown[] = [];
    registerLifecycleGuard(async (_action, detail) => {
      seen.push(detail);
      return null;
    });
    await saveFile();
    expect(seen).toEqual([{ path: "C:/books/q4.cala", kind: "save" }]);
  });

  it("asks with action \"save\" (a close guard must not fire on Ctrl+S)", async () => {
    const closeOnly = vi.fn(async (action: string) =>
      action === "close" ? { by: "Closer" } : null,
    );
    registerLifecycleGuard(closeOnly);
    await expect(saveFile()).resolves.toBe("C:/books/q4.cala");
    expect(closeOnly).toHaveBeenCalledWith("save", {
      path: "C:/books/q4.cala",
      kind: "save",
    });
  });
});

// ============================================================================
// The save FLAVOUR (VBA's SaveAsUI): "save" vs "saveAs"
// ============================================================================

describe("lifecycle detail kind", () => {
  it("saveFileAs asks with kind \"saveAs\"", async () => {
    dialogSave.mockResolvedValue("C:/books/new.cala");
    tracedInvoke.mockImplementation(async () => undefined);
    const seen: unknown[] = [];
    registerLifecycleGuard(async (_action, detail) => {
      seen.push(detail);
      return null;
    });
    await expect(saveFileAs()).resolves.toBe("C:/books/new.cala");
    expect(seen).toEqual([{ path: "C:/books/new.cala", kind: "saveAs" }]);
  });

  it("Ctrl+S on a NEVER-SAVED workbook is a saveAs (the picker opens)", async () => {
    // saveFile() with no current path falls through to saveFileAs, so the
    // flavour is decided by which function actually runs — not by which
    // keystroke the user pressed.
    tracedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_current_file_path") return null;
      return undefined;
    });
    dialogSave.mockResolvedValue("C:/books/untitled.cala");
    const seen: unknown[] = [];
    registerLifecycleGuard(async (_action, detail) => {
      seen.push(detail);
      return null;
    });
    await expect(saveFile()).resolves.toBe("C:/books/untitled.cala");
    expect(seen).toEqual([{ path: "C:/books/untitled.cala", kind: "saveAs" }]);
  });

  it("a cancelled saveAs still never reaches save_file", async () => {
    dialogSave.mockResolvedValue("C:/books/new.cala");
    tracedInvoke.mockImplementation(async () => undefined);
    registerLifecycleGuard(async (_a, detail) =>
      (detail as { kind?: string }).kind === "saveAs" ? { by: "Versioner" } : null,
    );
    await expect(saveFileAs()).resolves.toBeNull();
    expect(tracedInvoke.mock.calls.map((c) => c[0])).not.toContain("save_file");
  });
});

// ============================================================================
// Sheet-collection events
// ============================================================================

describe("sheet CRUD announcements", () => {
  const sheet = (index: number, name: string) => ({ index, name, visibility: "visible" });

  it("addSheet announces the NEW sheet, resolved by diffing the names", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_sheets") return { sheets: [sheet(0, "Sheet1")], activeIndex: 0 };
      return { sheets: [sheet(0, "Sheet1"), sheet(1, "Budget")], activeIndex: 1 };
    });
    const added = capture(AppEvents.SHEET_ADDED);
    await addSheet("Budget");
    expect(added.events).toEqual([{ sheetIndex: 1, sheetName: "Budget", source: "new" }]);
    added.off();
  });

  it("copySheet announces an add tagged as a copy", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_sheets") return { sheets: [sheet(0, "Q4")], activeIndex: 0 };
      return { sheets: [sheet(0, "Q4"), sheet(1, "Q4 (2)")], activeIndex: 1 };
    });
    const added = capture(AppEvents.SHEET_ADDED);
    await copySheet(0);
    expect(added.events).toEqual([{ sheetIndex: 1, sheetName: "Q4 (2)", source: "copy" }]);
    added.off();
  });

  it("deleteSheet announces the name the sheet HAD (it is gone from the result)", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_sheets") {
        return { sheets: [sheet(0, "Sheet1"), sheet(1, "Scratch")], activeIndex: 0 };
      }
      return { sheets: [sheet(0, "Sheet1")], activeIndex: 0 };
    });
    const deleted = capture(AppEvents.SHEET_DELETED);
    await deleteSheet(1);
    expect(deleted.events).toEqual([{ sheetIndex: 1, sheetName: "Scratch" }]);
    deleted.off();
  });

  it("renameSheet announces BOTH names, so a script can re-bind", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_sheets") return { sheets: [sheet(0, "Sheet1")], activeIndex: 0 };
      return { sheets: [sheet(0, "Q4 final")], activeIndex: 0 };
    });
    const renamed = capture(AppEvents.SHEET_RENAMED);
    await renameSheet(0, "Q4 final");
    expect(renamed.events).toEqual([
      { sheetIndex: 0, oldName: "Sheet1", newName: "Q4 final" },
    ]);
    renamed.off();
  });

  it("calculateSheet announces the recalc with its scope and cell count", async () => {
    invoke.mockImplementation(async () => [{ row: 0, col: 0 }, { row: 1, col: 0 }]);
    const recalcs = capture(AppEvents.RECALCULATION_COMPLETED);
    await calculateSheet();
    expect(recalcs.events).toHaveLength(1);
    const p = recalcs.events[0] as { scope: string; cellsUpdated: number; durationMs: number };
    expect(p.scope).toBe("sheet");
    expect(p.cellsUpdated).toBe(2);
    expect(typeof p.durationMs).toBe("number");
    recalcs.off();
  });

  it("a failing pre-read degrades the payload but never fails the operation", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_sheets") throw new Error("backend busy");
      return { sheets: [sheet(0, "Sheet1")], activeIndex: 0 };
    });
    const deleted = capture(AppEvents.SHEET_DELETED);
    await expect(deleteSheet(3)).resolves.toBeDefined();
    expect(deleted.events).toEqual([{ sheetIndex: 3, sheetName: "" }]);
    deleted.off();
  });
});
