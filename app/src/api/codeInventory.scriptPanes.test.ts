//! FILENAME: app/src/api/codeInventory.scriptPanes.test.ts
// PURPOSE: The fourth held-state question (M2 S7): WHICH SURFACES is a script
//          holding on screen right now? A docked task pane and the modal form
//          must appear in the code inventory's held state — owner, visible or
//          not, bound cells, updates in the last minute — and the row must be
//          gone the moment the pane closes.
// CONTEXT: The pane rows come from the REAL registry (scriptPanes.ts): a pane
//          is docked through `dockScriptPane` with a stub renderer answering on
//          the pane wire, exactly as scriptPanes.test.ts does, and the inventory
//          is then asked. Only the populations the owner join reads and the
//          other held-state sources are mocked, the same way
//          codeInventory.heldState.test.ts mocks them. The modal registry's
//          `getActiveScriptForm` is doubled: what "active" means is pinned in
//          scriptForms.test.ts; here the question is whether the inventory
//          RELAYS it with an owner.

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

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

// --- The other held-state sources, all idle ---------------------------------
vi.mock("./keybindings", () => ({
  listScriptKeybindings: vi.fn(() => []),
  revokeScriptKeybinding: vi.fn(),
}));
vi.mock("./scriptHost/host", () => ({
  scriptClipboardSize: vi.fn(() => null),
  clearScriptClipboard: vi.fn(),
}));
vi.mock("./distribution", () => ({
  getSubmissionWatchStatus: vi.fn(() => ({
    refCount: 0,
    running: false,
    intervalMs: 60_000,
    watchedRegionIds: [],
    skippedRegionIds: [],
    lastPollAt: null,
    lastPollCalls: 0,
    lastError: null,
  })),
}));
vi.mock("./backend", () => ({ invokeBackend: vi.fn() }));
// PARTIAL: the pane registry needs the real layout table from this module;
// only the modal's "active form" answer is doubled.
vi.mock("./scriptHost/scriptForms", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./scriptHost/scriptForms")>()),
  getActiveScriptForm: vi.fn(() => null),
}));

import { loadAllObjectScripts } from "./objectScriptBackend";
import { listModuleScripts, getModuleScript } from "./moduleScriptBackend";
import { listNotebooks, loadNotebook } from "./notebookBackend";
import { listMountedHandles } from "./scriptHost/broker";
import { loadPersistedTransformLibraryWithProvenance } from "./chartTransformScripts";
import { loadPersistedMarkLibraryWithProvenance } from "./chartMarkScripts";
import { mountedWritebackValidators } from "./writebackValidators";
import { getActiveScriptForm } from "./scriptHost/scriptForms";
import { emitAppEvent } from "./events";
import {
  closeScriptPane,
  dockScriptPane,
  resetScriptPanes,
  setScriptPaneBadge,
  updateScriptPane,
  type PaneSessionDeps,
} from "./scriptHost/scriptPanes";
import {
  PANE_UPDATE_WINDOW_MS,
  SCRIPT_PANE_INPUT_EVENT,
  SCRIPT_PANE_REQUEST_EVENT,
  type ScriptPaneInputPayload,
  type ScriptPaneRequestPayload,
} from "./scriptHost/scriptPaneSpec";
import type { FormSpec } from "./scriptHost/scriptFormSpec";
import { getScriptHeldState, summarizeScriptHeldState } from "./codeInventory";

/** Every mocked population above is a `vi.fn()`; this names that without `any`. */
const asMock = (fn: unknown): Mock => fn as Mock;

const OBJECT_SCRIPT = {
  id: "form-1",
  name: "Status board",
  objectType: "form",
  instanceId: "i1",
  source: "export function onPaneClick() {}",
  accessLevel: "restricted",
  provenance: "local",
  packageName: null,
  declaredCapabilities: ["ui.pane"],
};

const SPEC: FormSpec = {
  title: "Status",
  children: [
    { type: "textbox", name: "note", label: "Note" },
    { type: "checkbox", name: "done", label: "Done" },
  ],
};

const OWNER = {
  scriptId: "form-1",
  scriptName: "Status board",
  origin: { kind: "local" } as const,
  spec: SPEC,
};

function silentDeps(): PaneSessionDeps {
  return {
    forward: () => undefined,
    mirror: () => undefined,
    closed: () => undefined,
  };
}

/** The trusted renderer's half of the wire: remember each request, answer on demand. */
function renderer() {
  const requests: ScriptPaneRequestPayload[] = [];
  const onReq = (e: Event) => requests.push((e as CustomEvent).detail as ScriptPaneRequestPayload);
  window.addEventListener(SCRIPT_PANE_REQUEST_EVENT, onReq);
  const input = (payload: ScriptPaneInputPayload) => emitAppEvent(SCRIPT_PANE_INPUT_EVENT, payload);
  return {
    last: () => requests[requests.length - 1],
    docked: (paneId: string) => input({ paneId, kind: "docked", placement: "sidebar", values: {} }),
    visible: (paneId: string) => input({ paneId, kind: "visible", placement: "sidebar", values: {} }),
    hidden: (paneId: string) => input({ paneId, kind: "hidden", values: {} }),
    close: (paneId: string) => input({ paneId, kind: "close", values: {} }),
    stop: () => window.removeEventListener(SCRIPT_PANE_REQUEST_EVENT, onReq),
  };
}

async function dock(r: ReturnType<typeof renderer>, writeOnChange: string[] = []): Promise<string> {
  const promise = dockScriptPane({ ...OWNER, writeOnChange, deps: silentDeps() });
  const { paneId } = r.last();
  r.docked(paneId);
  // No gesture is stamped here, so the dock REGISTERS the pane without taking
  // the screen; the inventory reports the same row either way.
  await expect(promise).resolves.toEqual({ paneId, opened: false, placement: "sidebar" });
  return paneId;
}

let r: ReturnType<typeof renderer>;

beforeEach(() => {
  vi.clearAllMocks();
  resetScriptPanes();
  asMock(loadAllObjectScripts).mockResolvedValue([OBJECT_SCRIPT]);
  asMock(listModuleScripts).mockResolvedValue([]);
  asMock(getModuleScript).mockResolvedValue(null);
  asMock(listNotebooks).mockResolvedValue([]);
  asMock(loadNotebook).mockResolvedValue(null);
  asMock(listMountedHandles).mockReturnValue([]);
  asMock(loadPersistedTransformLibraryWithProvenance).mockResolvedValue(null);
  asMock(loadPersistedMarkLibraryWithProvenance).mockResolvedValue(null);
  asMock(mountedWritebackValidators).mockReturnValue([]);
  asMock(getActiveScriptForm).mockReturnValue(null);
  r = renderer();
});

afterEach(() => {
  r.stop();
  resetScriptPanes();
  vi.useRealTimers();
});

describe("getScriptHeldState — task panes", () => {
  it("reports nothing and fetches no inventory while no surface is up", async () => {
    const state = await getScriptHeldState();
    expect(state.panes).toEqual([]);
    expect(state.forms).toEqual([]);
    expect(summarizeScriptHeldState(state).any).toBe(false);
    expect(loadAllObjectScripts).not.toHaveBeenCalled();
  });

  it("lists a docked pane with its owner, visibility, bound cells and recent updates — and drops it on close", async () => {
    const paneId = await dock(r, ["note", "done"]);

    let state = await getScriptHeldState();
    expect(state.panes).toHaveLength(1);
    expect(state.panes[0]).toMatchObject({
      paneId,
      scriptId: "form-1",
      ownerName: "Status board",
      ownerMissing: false,
      ownerProvenance: "local",
      ownerPackage: null,
      visible: false,
      placement: "sidebar",
      boundCells: 2,
      updatesLastMinute: 0,
      updateWindowMs: PANE_UPDATE_WINDOW_MS,
      badge: null,
    });
    const summary = summarizeScriptHeldState(state);
    expect(summary.panes).toBe(1);
    expect(summary.any).toBe(true);

    // Visibility follows the renderer's section component, and the count
    // follows ADMITTED updates: two patches and a badge reached the screen.
    r.visible(paneId);
    updateScriptPane("form-1", paneId, { values: { note: "a" } });
    updateScriptPane("form-1", paneId, { values: { note: "b" } });
    setScriptPaneBadge("form-1", paneId, "3");
    state = await getScriptHeldState();
    expect(state.panes[0].visible).toBe(true);
    expect(state.panes[0].updatesLastMinute).toBe(3);
    expect(state.panes[0].badge).toBe("3");

    r.hidden(paneId);
    expect((await getScriptHeldState()).panes[0].visible).toBe(false);

    // The row is the pane's: the moment the script closes it, nothing is held.
    closeScriptPane("form-1", paneId);
    state = await getScriptHeldState();
    expect(state.panes).toEqual([]);
    expect(summarizeScriptHeldState(state).any).toBe(false);
  });

  it("a pane the USER closed leaves the inventory too", async () => {
    const paneId = await dock(r);
    expect((await getScriptHeldState()).panes.map((p) => p.paneId)).toEqual([paneId]);
    r.close(paneId);
    expect((await getScriptHeldState()).panes).toEqual([]);
  });

  it("attributes a pane whose owner is a mounted distributed script instead of calling it an orphan", async () => {
    asMock(loadAllObjectScripts).mockResolvedValue([]);
    asMock(listMountedHandles).mockReturnValue([
      {
        scriptId: "form-1",
        scriptName: "Status board",
        origin: { kind: "package", name: "acme-status" },
        tier: "restricted",
        grants: ["ui.pane"],
      },
    ]);
    await dock(r);
    const [pane] = (await getScriptHeldState()).panes;
    expect(pane.ownerMissing).toBe(false);
    expect(pane.ownerProvenance).toBe("distributed");
    expect(pane.ownerPackage).toBe("acme-status");
  });

  it("lists a form the user EMBEDDED on a sheet as embedded, and names its placement", async () => {
    // M3c: an embedded form is a pane session with `placement: "embedded"`, and
    // the transparency panel must not report it as a sidebar pane — the user
    // would go looking for it in the panel list, which is the one place it is
    // not. The stub below acknowledges "sidebar" on purpose; the registry
    // answers from the SESSION, so the panel cannot be lied to by a renderer.
    const promise = dockScriptPane({ ...OWNER, embedPlacementId: "placement-abc", deps: silentDeps() });
    const { paneId } = r.last();
    r.docked(paneId);
    await expect(promise).resolves.toMatchObject({ paneId, placement: "embedded" });

    const state = await getScriptHeldState();
    expect(state.panes).toHaveLength(1);
    expect(state.panes[0]).toMatchObject({
      paneId,
      ownerName: "Status board",
      placement: "embedded",
      embedded: true,
      placementId: "placement-abc",
    });
    const summary = summarizeScriptHeldState(state);
    // Counted in the total AND apart from it: "3 panes" for two panes and one
    // on-sheet form would send the user hunting in the sidebar.
    expect(summary.panes).toBe(1);
    expect(summary.embeddedForms).toBe(1);
    expect(summary.any).toBe(true);
  });

  it("a docked pane is NOT reported as embedded", async () => {
    await dock(r);
    const [pane] = (await getScriptHeldState()).panes;
    expect(pane.embedded).toBe(false);
    expect(pane.placementId).toBeNull();
    expect(summarizeScriptHeldState(await getScriptHeldState()).embeddedForms).toBe(0);
  });

  it("still names the pane's script from the registry's host-recorded name when nothing owns it", async () => {
    asMock(loadAllObjectScripts).mockResolvedValue([]);
    await dock(r);
    const [pane] = (await getScriptHeldState()).panes;
    expect(pane.ownerMissing).toBe(true);
    expect(pane.ownerName).toBe("Status board");
  });
});

describe("getScriptHeldState — the modal form", () => {
  it("reports the form on screen with its owner", async () => {
    asMock(getActiveScriptForm).mockReturnValue({
      showId: "show-7",
      scriptId: "form-1",
      scriptName: "Status board",
    });
    const state = await getScriptHeldState();
    expect(state.forms).toEqual([
      {
        showId: "show-7",
        scriptId: "form-1",
        ownerName: "Status board",
        ownerMissing: false,
        ownerProvenance: "local",
        ownerPackage: null,
      },
    ]);
    expect(summarizeScriptHeldState(state).forms).toBe(1);
    expect(summarizeScriptHeldState(state).any).toBe(true);
  });

  it("a failing form registry costs its own row, never the pane rows", async () => {
    asMock(getActiveScriptForm).mockImplementation(() => {
      throw new Error("form registry not wired");
    });
    const paneId = await dock(r);
    const state = await getScriptHeldState();
    expect(state.forms).toEqual([]);
    expect(state.panes.map((p) => p.paneId)).toEqual([paneId]);
  });
});
