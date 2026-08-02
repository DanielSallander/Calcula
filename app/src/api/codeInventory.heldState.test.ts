//! FILENAME: app/src/api/codeInventory.heldState.test.ts
// PURPOSE: Cover the third transparency question — "what is a script HOLDING on
//          my behalf right now?" — and the machine-scoped add-in trail.
// CONTEXT: Keyboard shortcuts (`ui.shortcut`), private clipboards and the
//          background submission watch were all correctly bounded and all three
//          were invisible to the person they belong to, which is the VBA
//          Application.OnKey failure mode with the roles reversed. These tests
//          pin the two properties that matter for a transparency surface:
//            1. a held thing is REPORTED, with the code that holds it named; and
//            2. "nothing held" is never reported when something IS held — a
//               transparency panel may err loud, never reassuring.
//          The residence/reach half of the inventory stays in codeInventory.test.ts.

import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Populations the owner join reads (all empty unless a test says otherwise)
vi.mock("./objectScriptBackend", () => ({ loadAllObjectScripts: vi.fn() }));
vi.mock("./moduleScriptBackend", () => ({
  listModuleScripts: vi.fn(),
  getModuleScript: vi.fn(),
  describeModuleScriptScope: () => "Workbook-global",
}));
vi.mock("./notebookBackend", () => ({ listNotebooks: vi.fn(), loadNotebook: vi.fn() }));
// PARTIAL: scriptLibraries/linker.ts reads HOST_ONLY_EXPOSED_PREFIX at module
// scope, so a total mock of the broker breaks the import graph, not this test.
vi.mock("./scriptHost/broker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./scriptHost/broker")>()),
  listMountedHandles: vi.fn(),
}));
vi.mock("./chartTransformScripts", () => ({
  loadPersistedTransformLibraryWithProvenance: vi.fn(),
  CHART_TRANSFORMS_SCRIPT_ID: "__calcula_chart_transforms__",
}));
vi.mock("./chartMarkScripts", () => ({
  loadPersistedMarkLibraryWithProvenance: vi.fn(),
  markScriptId: (id: string) => `__chartmark__:${id}`,
}));
vi.mock("./writebackValidators", () => ({ mountedWritebackValidators: vi.fn() }));

// --- The three held-state sources -------------------------------------------
vi.mock("./keybindings", () => ({
  listScriptKeybindings: vi.fn(),
  revokeScriptKeybinding: vi.fn(),
}));
vi.mock("./scriptHost/host", () => ({
  scriptClipboardSize: vi.fn(),
  clearScriptClipboard: vi.fn(),
}));
vi.mock("./distribution", () => ({ getSubmissionWatchStatus: vi.fn() }));
vi.mock("./backend", () => ({ invokeBackend: vi.fn() }));

import { loadAllObjectScripts } from "./objectScriptBackend";
import { listModuleScripts, getModuleScript } from "./moduleScriptBackend";
import { listNotebooks, loadNotebook } from "./notebookBackend";
import { listMountedHandles } from "./scriptHost/broker";
import { loadPersistedTransformLibraryWithProvenance } from "./chartTransformScripts";
import { loadPersistedMarkLibraryWithProvenance } from "./chartMarkScripts";
import { mountedWritebackValidators } from "./writebackValidators";
import { listScriptKeybindings } from "./keybindings";
import { scriptClipboardSize, clearScriptClipboard as hostClear } from "./scriptHost/host";
import { getSubmissionWatchStatus } from "./distribution";
import { invokeBackend } from "./backend";
import {
  getScriptHeldState,
  summarizeScriptHeldState,
  clearScriptClipboard,
  getExtensionAuditTrail,
  EXTENSION_AUDIT_ACTION_LABELS,
} from "./codeInventory";

const OBJECT_SCRIPT = {
  id: "os1",
  name: "Sales refresher",
  objectType: "shape",
  instanceId: "i1",
  source: "export function refreshAll() {}",
  accessLevel: "restricted",
  provenance: "local",
  packageName: null,
  declaredCapabilities: ["ui.shortcut"],
};

const IDLE_WATCH = {
  refCount: 0,
  running: false,
  intervalMs: 60_000,
  watchedRegionIds: [],
  skippedRegionIds: [],
  lastPollAt: null,
  lastPollCalls: 0,
  lastError: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  (loadAllObjectScripts as any).mockResolvedValue([]);
  (listModuleScripts as any).mockResolvedValue([]);
  (getModuleScript as any).mockResolvedValue(null);
  (listNotebooks as any).mockResolvedValue([]);
  (loadNotebook as any).mockResolvedValue(null);
  (listMountedHandles as any).mockReturnValue([]);
  (loadPersistedTransformLibraryWithProvenance as any).mockResolvedValue(null);
  (loadPersistedMarkLibraryWithProvenance as any).mockResolvedValue(null);
  (mountedWritebackValidators as any).mockReturnValue([]);
  (listScriptKeybindings as any).mockReturnValue([]);
  (scriptClipboardSize as any).mockReturnValue(null);
  (getSubmissionWatchStatus as any).mockReturnValue(IDLE_WATCH);
  (invokeBackend as any).mockResolvedValue({
    entries: [],
    total: 0,
    unreadableLines: 0,
    path: "C:/x/extension-audit.jsonl",
    missing: true,
    lastWriteError: "",
  });
});

describe("getScriptHeldState — nothing held", () => {
  it("reports empty when no script holds anything", async () => {
    const state = await getScriptHeldState([]);
    expect(state.shortcuts).toEqual([]);
    expect(state.clipboards).toEqual([]);
    expect(state.watches).toEqual([]);
    expect(summarizeScriptHeldState(state).any).toBe(false);
  });

  it("does not fetch the inventory when nothing is held", async () => {
    await getScriptHeldState();
    expect(loadAllObjectScripts).not.toHaveBeenCalled();
  });
});

describe("getScriptHeldState — keyboard shortcuts", () => {
  it("names the script whose code the keys run", async () => {
    (listScriptKeybindings as any).mockReturnValue([
      {
        id: "script:os1:CTRL+SHIFT+R",
        combo: "Ctrl+Shift+R",
        scriptId: "os1",
        scriptName: "Sales refresher",
        handler: "refreshAll",
        label: "refreshAll()",
      },
    ]);
    (loadAllObjectScripts as any).mockResolvedValue([OBJECT_SCRIPT]);

    const state = await getScriptHeldState();
    expect(state.shortcuts).toHaveLength(1);
    const s = state.shortcuts[0];
    expect(s.combo).toBe("Ctrl+Shift+R");
    expect(s.handler).toBe("refreshAll");
    expect(s.ownerName).toBe("Sales refresher");
    expect(s.ownerMissing).toBe(false);
    expect(s.ownerProvenance).toBe("local");
    expect(summarizeScriptHeldState(state).shortcuts).toBe(1);
  });

  it("attributes a shortcut held by a distributed extension worker instead of calling it an orphan", async () => {
    // The worker's code lives in %APPDATA%/extensions, so it is deliberately NOT
    // a workbook code unit — but it IS mounted, so the keys really do fire.
    (listScriptKeybindings as any).mockReturnValue([
      {
        id: "script:ext1:CTRL+SHIFT+K",
        combo: "Ctrl+Shift+K",
        scriptId: "ext1",
        scriptName: "Tax Tools",
        handler: "openPanel",
        label: "openPanel()",
      },
    ]);
    (listMountedHandles as any).mockReturnValue([
      { scriptId: "ext1", scriptName: "Tax Tools", origin: "tax-tools", tier: "restricted", grants: [] },
    ]);

    const state = await getScriptHeldState();
    expect(state.shortcuts[0].ownerMissing).toBe(false);
    expect(state.shortcuts[0].ownerProvenance).toBe("distributed");
    expect(state.shortcuts[0].ownerPackage).toBe("tax-tools");
  });

  it("still reports a shortcut whose owner is gone rather than dropping it", async () => {
    (listScriptKeybindings as any).mockReturnValue([
      {
        id: "script:ghost:CTRL+SHIFT+G",
        combo: "Ctrl+Shift+G",
        scriptId: "ghost",
        scriptName: "Gone",
        handler: "run",
        label: "run()",
      },
    ]);
    const state = await getScriptHeldState();
    expect(state.shortcuts).toHaveLength(1);
    expect(state.shortcuts[0].ownerMissing).toBe(true);
    expect(state.shortcuts[0].ownerName).toBe("Gone");
  });
});

describe("getScriptHeldState — private clipboards", () => {
  it("reports the size of a held buffer, never its contents", async () => {
    (listMountedHandles as any).mockReturnValue([
      { scriptId: "os1", scriptName: "Sales refresher", origin: "local", tier: "restricted", grants: [] },
    ]);
    (scriptClipboardSize as any).mockImplementation((id: string) =>
      id === "os1" ? { rows: 4, cols: 3 } : null,
    );
    (loadAllObjectScripts as any).mockResolvedValue([OBJECT_SCRIPT]);

    const state = await getScriptHeldState();
    expect(state.clipboards).toHaveLength(1);
    expect(state.clipboards[0]).toMatchObject({
      scriptId: "os1",
      ownerName: "Sales refresher",
      rows: 4,
      cols: 3,
      cells: 12,
    });
    // The entry carries no cell values at all — the panel must not become a
    // second copy of the user's data.
    expect(JSON.stringify(state.clipboards[0])).not.toMatch(/value|display|formula/i);
    expect(summarizeScriptHeldState(state).clipboardCells).toBe(12);
  });

  it("enumerates every MOUNTED script, not only this workbook's own code", async () => {
    // A distributed extension worker holds the user's cells exactly like a local
    // object script does; reporting only workbook units would under-report.
    (listMountedHandles as any).mockReturnValue([
      { scriptId: "ext1", scriptName: "Tax Tools", origin: "tax-tools", tier: "restricted", grants: [] },
    ]);
    (scriptClipboardSize as any).mockReturnValue({ rows: 2, cols: 2 });
    const state = await getScriptHeldState();
    expect(state.clipboards).toHaveLength(1);
    expect(state.clipboards[0].ownerName).toBe("Tax Tools");
  });

  it("ignores an empty buffer", async () => {
    (listMountedHandles as any).mockReturnValue([
      { scriptId: "os1", scriptName: "S", origin: "local", tier: "restricted", grants: [] },
    ]);
    (scriptClipboardSize as any).mockReturnValue({ rows: 0, cols: 0 });
    expect((await getScriptHeldState()).clipboards).toEqual([]);
  });

  it("clears a buffer through the host, which is the control half of the promise", async () => {
    await clearScriptClipboard("os1");
    expect(hostClear).toHaveBeenCalledWith("os1");
  });
});

describe("getScriptHeldState — background watch", () => {
  it("stays silent while nothing is polling", async () => {
    const state = await getScriptHeldState();
    expect(state.watches).toEqual([]);
  });

  it("discloses the poll, its cadence and what it touched", async () => {
    (getSubmissionWatchStatus as any).mockReturnValue({
      refCount: 2,
      running: true,
      intervalMs: 60_000,
      watchedRegionIds: ["r1", "r2"],
      skippedRegionIds: ["r3"],
      lastPollAt: "2026-07-31T10:00:00.000Z",
      lastPollCalls: 3,
      lastError: null,
    });
    const state = await getScriptHeldState();
    expect(state.watches).toHaveLength(1);
    const w = state.watches[0];
    expect(w.running).toBe(true);
    expect(w.refCount).toBe(2);
    expect(w.cadence).toBe("Every minute");
    expect(w.watchedRegionIds).toEqual(["r1", "r2"]);
    expect(w.skippedRegionIds).toEqual(["r3"]);
    expect(w.lastPollCalls).toBe(3);
    expect(w.what).toMatch(/registry/i);
    expect(summarizeScriptHeldState(state).runningWatches).toBe(1);
  });

  it("still reports a held-but-not-running watch, and its last failure", async () => {
    (getSubmissionWatchStatus as any).mockReturnValue({
      ...IDLE_WATCH,
      refCount: 1,
      running: false,
      lastError: "registry unreachable",
    });
    const state = await getScriptHeldState();
    expect(state.watches).toHaveLength(1);
    expect(state.watches[0].lastError).toBe("registry unreachable");
    expect(summarizeScriptHeldState(state).runningWatches).toBe(0);
    expect(summarizeScriptHeldState(state).any).toBe(true);
  });
});

describe("getScriptHeldState — degradation must never read as 'nothing held'", () => {
  it("still reports clipboards when the shortcut registry throws", async () => {
    (listScriptKeybindings as any).mockImplementation(() => {
      throw new Error("registry unavailable");
    });
    (listMountedHandles as any).mockReturnValue([
      { scriptId: "os1", scriptName: "S", origin: "local", tier: "restricted", grants: [] },
    ]);
    (scriptClipboardSize as any).mockReturnValue({ rows: 1, cols: 5 });

    const state = await getScriptHeldState();
    expect(state.shortcuts).toEqual([]);
    expect(state.clipboards).toHaveLength(1);
  });

  it("still reports shortcuts when the clipboard read throws", async () => {
    (listScriptKeybindings as any).mockReturnValue([
      {
        id: "script:os1:CTRL+SHIFT+R",
        combo: "Ctrl+Shift+R",
        scriptId: "os1",
        scriptName: "Sales refresher",
        handler: "refreshAll",
        label: "refreshAll()",
      },
    ]);
    (listMountedHandles as any).mockReturnValue([
      { scriptId: "os1", scriptName: "Sales refresher", origin: "local", tier: "restricted", grants: [] },
    ]);
    (scriptClipboardSize as any).mockImplementation(() => {
      throw new Error("host not wired");
    });

    const state = await getScriptHeldState();
    expect(state.clipboards).toEqual([]);
    expect(state.shortcuts).toHaveLength(1);
  });

  it("does not let a failed watch read hide the rest", async () => {
    (getSubmissionWatchStatus as any).mockImplementation(() => {
      throw new Error("distribution not wired");
    });
    (listScriptKeybindings as any).mockReturnValue([
      {
        id: "script:os1:CTRL+SHIFT+R",
        combo: "Ctrl+Shift+R",
        scriptId: "os1",
        scriptName: "S",
        handler: "r",
        label: "r()",
      },
    ]);
    const state = await getScriptHeldState();
    expect(state.watches).toEqual([]);
    expect(state.shortcuts).toHaveLength(1);
  });
});

describe("the machine-scoped add-in trail", () => {
  it("reads through the main-window-only backend command", async () => {
    await getExtensionAuditTrail();
    expect(invokeBackend).toHaveBeenCalledWith("list_extension_audit");
  });

  it("passes the record through, including what was true at decision time", async () => {
    (invokeBackend as any).mockResolvedValue({
      entries: [
        {
          at: "2026-07-30T09:00:00Z",
          action: "publisherChangeAccepted",
          id: "acme.demo",
          name: "Demo",
          version: "2.0.0",
          bundleFileName: "demo.js",
          publisherKey: "new",
          previousPublisherKey: "old",
          trustStatus: "publisherChanged",
          capabilitiesHonored: false,
          declaredCapabilities: ["formula.udf"],
          contributions: ["formulas:DEMO"],
          sourcePath: "C:/downloads/demo",
          detail: "You accepted a DIFFERENT publisher for 'acme.demo'.",
        },
      ],
      total: 1,
      unreadableLines: 0,
      path: "C:/x/extension-audit.jsonl",
      missing: false,
      lastWriteError: "",
    });

    const trail = await getExtensionAuditTrail();
    expect(trail.total).toBe(1);
    expect(trail.entries[0].previousPublisherKey).toBe("old");
    expect(trail.entries[0].trustStatus).toBe("publisherChanged");
    expect(trail.entries[0].capabilitiesHonored).toBe(false);
  });

  /// An unreachable backend must not render as "nothing was ever installed".
  it("reports a read failure instead of an empty history", async () => {
    (invokeBackend as any).mockRejectedValue(new Error("command not found"));
    const trail = await getExtensionAuditTrail();
    expect(trail.entries).toEqual([]);
    expect(trail.missing).toBe(false);
    expect(trail.lastWriteError).toMatch(/command not found/);
  });

  it("labels every action the Rust store can record", () => {
    for (const action of [
      "installed",
      "removed",
      "publisherPinned",
      "publisherChangeAccepted",
    ]) {
      expect(
        EXTENSION_AUDIT_ACTION_LABELS[action],
        `unlabelled add-in audit action "${action}"`,
      ).toBeTruthy();
    }
  });
});
