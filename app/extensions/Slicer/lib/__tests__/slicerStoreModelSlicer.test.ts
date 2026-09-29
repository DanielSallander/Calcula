//! FILENAME: app/extensions/Slicer/lib/__tests__/slicerStoreModelSlicer.test.ts
// PURPOSE: The slicer store's side of the model slicer (owner finding 4,
//          2026-09-27): what ONE click, ONE undo, ONE delete and ONE view do.
//
//          - A click is ONE undo step: the selection write AND the filter it
//            puts on the pivots go to the backend as ONE gesture, which
//            records ONE step at the end (BUG-0187) -- no frontend undo
//            transaction is opened around it any more.
//          - User clicks are QUEUED: a click starts only after the previous
//            one landed, and a Ctrl+click toggle is computed from the
//            selection the previous click committed.
//          - After the undo fan-out ("slicers:refresh") the store RE-APPLIES
//            only the pivot MASKS (masksOnly) of ordinary (level-1) slicers
//            that still exist and whose selection changed. It never clears a
//            vanished slicer's page by its cached sheet index (a sheet delete
//            renumbers sheets; delete_slicer AND delete_sheet already took a
//            removed slicer's filter off on the backend), never re-applies a
//            slicer pinned on either side (the backend recorded the pivot's
//            PRE-pin state in the undone step; a re-apply would re-query into
//            a fresh step and wipe redo), and the initial load applies
//            nothing. Pivots that refuse a re-apply are told in ONE toast for
//            the whole Ctrl+Z.
//          - Deleting relies on the backend's clear (owner decision 3, ANY
//            slicer): the store issues no filter write, only refreshes the
//            views the backend changed (pivots; a table's AutoFilter).
//          - A view (sheet switch) READS: no slicer's refresh issues a write --
//            not a model slicer's, and not a PIVOT slicer's whose column left
//            its BI pivot (its items are listed from the model instead). That
//            includes the re-read after a sheet delete.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Slicer } from "../slicerTypes";
import type { SlicerFilterFailure } from "../slicerFilterBridge";

// ---------------------------------------------------------------------------
// Mocks — the store's whole outside world
// ---------------------------------------------------------------------------

vi.mock("@api/gridOverlays", () => ({
  replaceGridRegionsByType: vi.fn(),
  removeGridRegionsByType: vi.fn(),
  requestOverlayRedraw: vi.fn(),
}));

vi.mock("@api/state", () => ({
  getGridStateSnapshot: () => ({ sheetContext: { activeSheetIndex: 2 } }),
}));

const mockEmit = vi.fn();
vi.mock("@api/events", () => ({
  emitAppEvent: (...a: unknown[]) => mockEmit(...a),
  AppEvents: { MUTATION_REFRESH: "app:mutation-refresh", GRID_REFRESH: "app:grid-refresh" },
}));

vi.mock("@api/notifications", () => ({ showToast: vi.fn() }));

/** Every recorded step, with whether it ran inside the undo transaction. */
const log: Array<{ what: string; inTx: boolean; detail?: unknown }> = [];
let txDepth = 0;
/** The deepest the transactions ever nested: 2 = one JOINED another. */
let maxTxDepth = 0;
const txLabels: string[] = [];
vi.mock("@api/objectGeometry", () => ({
  // Mirrors the real seam: a click reads it right before it opens its step.
  isUndoTransactionOpen: () => txDepth > 0,
  undoCommitsSettled: () => Promise.resolve(),
  runInUndoTransaction: async (label: string, fn: () => Promise<unknown>) => {
    txLabels.push(label);
    txDepth++;
    maxTxDepth = Math.max(maxTxDepth, txDepth);
    try {
      return await fn();
    } finally {
      txDepth--;
    }
  },
}));

type ApplyOptions = { masksOnly?: boolean; failures?: SlicerFilterFailure[] };
/** Per slicer id: the refusal its apply reports (a column the model lost). */
let refusals: Record<string, string> = {};
const mockApply = vi.fn(async (s: Slicer, options?: ApplyOptions) => {
  log.push({ what: "apply", inTx: txDepth > 0, detail: { id: s.id, selectedItems: s.selectedItems } });
  const refusal = refusals[s.id];
  if (refusal) {
    const failure: SlicerFilterFailure = { slicer: s.name, target: "pivot", clearing: false, message: refusal };
    // The real bridge's contract: into the caller's list when given one,
    // else told by the apply itself.
    if (options?.failures) options.failures.push(failure);
    else mockReport([failure]);
  }
});
const mockReport = vi.fn((_failures: readonly SlicerFilterFailure[]) => undefined);
type Item = { value: string; selected: boolean; hasData: boolean };
const mockListFromModel = vi.fn(async (_s: Slicer): Promise<Item[] | null> => null);
/** The click's ONE backend gesture: the selection AND its filter. */
const mockGesture = vi.fn(async (s: Slicer, actor: string) => {
  apiCalls.push(`gesture:${s.id}`);
  log.push({ what: "gesture:start", inTx: txDepth > 0, detail: { selectedItems: s.selectedItems, actor } });
  const gate = selectionGate;
  selectionGate = null;
  if (gate) await gate;
  backendSlicers = backendSlicers.map((b) => (b.id === s.id ? { ...b, selectedItems: s.selectedItems } : b));
  log.push({ what: "gesture:end", inTx: txDepth > 0, detail: s.selectedItems });
  return {
    step: "pushed",
    overwrites: { note: () => undefined, cellCount: 0, pivotIds: [], tokens: [], unrecorded: false },
  };
});
vi.mock("../slicerFilterBridge", () => ({
  applySlicerFilter: (s: Slicer, options?: ApplyOptions) => mockApply(s, options),
  listPivotSlicerItemsFromModel: (s: Slicer) => mockListFromModel(s),
  reportSlicerFilterFailures: (f: readonly SlicerFilterFailure[]) => mockReport(f),
  runSlicerSelectionGesture: (s: Slicer, actor: string) => mockGesture(s, actor),
}));

/** The backend, as the list `get_all_slicers` returns. */
let backendSlicers: Slicer[] = [];
let itemsError: string | null = null;
/** Items get_slicer_items answers, per slicer id. */
let backendItems: Record<string, Array<{ value: string; selected: boolean; hasData: boolean }>> = {};
/** When set, the next update_slicer_selection waits on it (a slow BI apply). */
let selectionGate: Promise<void> | null = null;
const apiCalls: string[] = [];
vi.mock("../slicer-api", () => ({
  getAllSlicers: async () => {
    apiCalls.push("getAllSlicers");
    return backendSlicers.map((s) => ({ ...s, selectedItems: s.selectedItems ? [...s.selectedItems] : null }));
  },
  getSlicerItems: async (id: string) => {
    apiCalls.push(`getSlicerItems:${id}`);
    if (itemsError) throw new Error(itemsError);
    return backendItems[id] ?? [];
  },
  updateSlicerSelection: async (id: string, items: string[] | null) => {
    apiCalls.push(`updateSlicerSelection:${id}`);
    log.push({ what: "select", inTx: txDepth > 0, detail: items });
    const gate = selectionGate;
    selectionGate = null;
    if (gate) await gate;
    backendSlicers = backendSlicers.map((s) => (s.id === id ? { ...s, selectedItems: items } : s));
  },
  deleteSlicer: async (id: string) => {
    apiCalls.push(`deleteSlicer:${id}`);
    log.push({ what: "delete", inTx: txDepth > 0, detail: id });
    backendSlicers = backendSlicers.filter((s) => s.id !== id);
  },
}));

import {
  connectionChanges,
  refreshCache,
  refreshCacheAndReapplyChangedFilters,
  slicersWhoseFilterChanged,
  updateSlicerSelectionAsync,
  clickSlicerItem,
  clickSlicerClearFilter,
  getCachedItems,
  deleteSlicerAsync,
  deleteSlicersAsync,
  getSlicerById,
  resetStore,
} from "../slicerStore";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function slicer(id: string, overrides: Partial<Slicer> = {}): Slicer {
  return {
    id,
    name: id,
    headerText: null,
    sheetIndex: 2,
    x: 0,
    y: 0,
    width: 180,
    height: 240,
    sourceType: "biConnection",
    cacheSourceId: "c1",
    fieldName: "Geo.Region",
    selectedItems: null,
    showHeader: true,
    columns: 1,
    stylePreset: "slicer-light-1",
    selectionMode: "standard",
    hideNoData: false,
    indicateNoData: true,
    sortNoDataLast: true,
    forceSelection: false,
    showSelectAll: false,
    arrangement: "vertical",
    rows: 0,
    itemGap: 4,
    autogrid: false,
    itemPadding: 4,
    buttonRadius: 2,
    connectedSources: [{ sourceType: "biConnection", sourceId: "c1" }],
    filterLevel: 1,
    ...overrides,
  };
}

const WRITE = /^(updateSlicerSelection|deleteSlicer|gesture)/;

beforeEach(async () => {
  resetStore();
  backendSlicers = [];
  backendItems = {};
  itemsError = null;
  selectionGate = null;
  log.length = 0;
  apiCalls.length = 0;
  txLabels.length = 0;
  txDepth = 0;
  maxTxDepth = 0;
  mockApply.mockClear();
  mockGesture.mockClear();
  mockReport.mockClear();
  refusals = {};
  mockListFromModel.mockReset();
  mockListFromModel.mockImplementation(async () => null);
  mockEmit.mockClear();
});

async function load(slicers: Slicer[]): Promise<void> {
  backendSlicers = slicers;
  await refreshCache();
  log.length = 0;
  apiCalls.length = 0;
  mockApply.mockClear();
}

// ---------------------------------------------------------------------------
// A click is ONE undo step
// ---------------------------------------------------------------------------

describe("a slicer click", () => {
  it("sends the selection AND its filter as ONE backend gesture, with no frontend transaction around it", async () => {
    await load([slicer("s1")]);
    await updateSlicerSelectionAsync("s1", ["East"]);

    expect(txLabels).toEqual([]);
    expect(log.map((l) => [l.what, l.inTx])).toEqual([
      ["gesture:start", false],
      ["gesture:end", false],
    ]);
    // The gesture carried the NEW selection; a direct call is a SCRIPT's
    // (it joins the batch the script opened).
    expect(log[0].detail).toEqual({ selectedItems: ["East"], actor: "script" });
    expect(getSlicerById("s1")?.selectedItems).toEqual(["East"]);
  });
});

// ---------------------------------------------------------------------------
// User clicks run one at a time
// ---------------------------------------------------------------------------

const ITEMS = ["East", "West", "North", "South"].map((value) => ({ value, selected: true, hasData: true }));

describe("user clicks (the click queue)", () => {
  it("a second click made while the first is still applying starts only after the first LANDED, as a user click", async () => {
    backendItems = { s1: ITEMS };
    await load([slicer("s1")]);
    let release!: () => void;
    selectionGate = new Promise<void>((r) => (release = r));

    const first = clickSlicerItem("s1", "East", false);
    const second = clickSlicerItem("s1", "West", false);
    // Let the first click reach its (slow) backend gesture.
    await new Promise((r) => setTimeout(r, 0));
    release();
    await Promise.all([first, second]);

    expect(txLabels).toEqual([]);
    // Each click is its own gesture, one after the other.
    expect(log.map((l) => [l.what, l.detail])).toEqual([
      ["gesture:start", { selectedItems: ["East"], actor: "user" }],
      ["gesture:end", ["East"]],
      ["gesture:start", { selectedItems: ["West"], actor: "user" }],
      ["gesture:end", ["West"]],
    ]);
  });

  it("a Ctrl+click toggle made while the previous click is applying keeps the item that click added", async () => {
    backendItems = { s1: ITEMS };
    await load([slicer("s1")]);
    let release!: () => void;
    selectionGate = new Promise<void>((r) => (release = r));

    const first = clickSlicerItem("s1", "East", false);
    // Ctrl+click West BEFORE the first click committed: on screen the slicer
    // still shows "all", and a toggle computed from that is "all but West".
    const second = clickSlicerItem("s1", "West", true);
    await new Promise((r) => setTimeout(r, 0));
    release();
    await Promise.all([first, second]);

    expect(getSlicerById("s1")?.selectedItems).toEqual(["East", "West"]);
    expect(log.filter((l) => l.what === "gesture:end").map((l) => l.detail)).toEqual([["East"], ["East", "West"]]);
  });

  it("Clear on a slicer that filters nothing writes nothing (no empty undo step)", async () => {
    await load([slicer("s1")]);
    await clickSlicerClearFilter("s1");
    expect(apiCalls.filter((c) => WRITE.test(c))).toEqual([]);
    expect(txLabels).toEqual([]);
  });

  it("Clear on a filtering slicer clears it in one step", async () => {
    await load([slicer("s1", { selectedItems: ["East"] })]);
    await clickSlicerClearFilter("s1");
    expect(apiCalls.filter((c) => WRITE.test(c))).toEqual(["gesture:s1"]);
    expect(mockGesture.mock.calls[0][0]).toMatchObject({ id: "s1", selectedItems: null });
    expect(getSlicerById("s1")?.selectedItems).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The reconcile after the undo fan-out
// ---------------------------------------------------------------------------

describe("slicersWhoseFilterChanged (pure)", () => {
  it("only ordinary slicers present before AND after whose selection changed", () => {
    const before = [
      slicer("changed", { selectedItems: ["East"] }),
      slicer("same", { selectedItems: ["West"] }),
      slicer("vanished", { selectedItems: ["North"] }),
      slicer("level", { selectedItems: ["X"], filterLevel: 1 }),
      slicer("pinned", { selectedItems: ["A"], filterLevel: 2 }),
    ];
    const after = [
      slicer("changed", { selectedItems: null }),
      slicer("same", { selectedItems: ["West"] }),
      slicer("appeared", { selectedItems: ["South"] }),
      slicer("level", { selectedItems: ["X"], filterLevel: 2 }),
      slicer("pinned", { selectedItems: ["B"], filterLevel: 2 }),
    ];
    expect(slicersWhoseFilterChanged(before, after).map((s) => s.id)).toEqual(["changed"]);
  });

  // Fix round 5 review, finding 2: an undone / declined Report Connections
  // save moves what the slicer reaches without touching its selection.
  it("also a slicer whose CONNECTIONS moved while it filters something -- never one that filters nothing", () => {
    const pivots = (...ids: string[]) => ids.map((id) => ({ sourceType: "pivot" as const, sourceId: id }));
    const before = [
      slicer("moved", { selectedItems: ["East"], connectedSources: pivots("a", "b") }),
      slicer("idle", { selectedItems: null, connectedSources: pivots("a", "b") }),
      slicer("pinned", { selectedItems: ["East"], filterLevel: 2, connectedSources: pivots("a", "b") }),
      slicer("still", { selectedItems: ["East"], connectedSources: pivots("a", "b") }),
    ];
    const after = [
      slicer("moved", { selectedItems: ["East"], connectedSources: pivots("a", "c") }),
      slicer("idle", { selectedItems: null, connectedSources: pivots("a", "c") }),
      slicer("pinned", { selectedItems: ["East"], filterLevel: 2, connectedSources: pivots("a", "c") }),
      // Same set, another order: not a change.
      slicer("still", { selectedItems: ["East"], connectedSources: pivots("b", "a") }),
    ];
    expect(slicersWhoseFilterChanged(before, after).map((s) => s.id)).toEqual(["moved"]);
    expect(connectionChanges(before[0], after[0])).toEqual({ dropped: pivots("b"), added: pivots("c") });
  });
});

describe("the reconcile after an undo", () => {
  it("re-applies exactly the slicer whose selection the undo restored", async () => {
    await load([
      slicer("s1", { selectedItems: ["East"] }),
      slicer("s2", { selectedItems: ["West"] }),
    ]);
    // The backend's undo restored s1's selection; s2 is untouched.
    backendSlicers = backendSlicers.map((s) => (s.id === "s1" ? { ...s, selectedItems: null } : s));

    const reapplied = await refreshCacheAndReapplyChangedFilters();

    expect(reapplied.map((s) => s.id)).toEqual(["s1"]);
    expect(mockApply).toHaveBeenCalledTimes(1);
    expect(mockApply.mock.calls[0][0]).toMatchObject({ id: "s1", selectedItems: null });
    // Masks only: a table target's AutoFilter was restored by the undo itself.
    expect(mockApply.mock.calls[0][1]).toMatchObject({ masksOnly: true });
    expect(apiCalls.filter((c) => WRITE.test(c))).toEqual([]);
  });

  it("NEVER clears a slicer that vanished (a sheet delete renumbered the sheets; delete_sheet already cleared the filters of the slicers it removed)", async () => {
    await load([
      slicer("on-deleted-canvas", { sheetIndex: 1, selectedItems: ["East"] }),
      // The NEXT canvas's own model slicer, renumbered 2 -> 1 by the delete.
      slicer("next-canvas", { sheetIndex: 2, selectedItems: ["West"] }),
    ]);
    backendSlicers = [slicer("next-canvas", { sheetIndex: 1, selectedItems: ["West"] })];

    await refreshCacheAndReapplyChangedFilters();

    expect(mockApply).not.toHaveBeenCalled();
    expect(getSlicerById("on-deleted-canvas")).toBeUndefined();
  });

  it("the re-read a sheet delete triggers (SHEET_CHANGED -> refreshCache) neither clears the gone slicer again nor re-applies the survivors", async () => {
    // delete_sheet cleared the filters of the slicers on the deleted sheet
    // itself (host masks in the command, a dropped pin re-queried in the
    // background). The frontend's only reaction is the active-sheet re-read.
    await load([
      slicer("on-deleted-canvas", { sheetIndex: 1, selectedItems: ["East"] }),
      slicer("next-canvas", { sheetIndex: 2, selectedItems: ["West"] }),
      slicer("pinned-elsewhere", { sheetIndex: 3, selectedItems: ["North"], filterLevel: 2 }),
    ]);
    backendSlicers = [
      slicer("next-canvas", { sheetIndex: 1, selectedItems: ["West"] }),
      slicer("pinned-elsewhere", { sheetIndex: 2, selectedItems: ["North"], filterLevel: 2 }),
    ];

    await refreshCache();

    expect(mockApply).not.toHaveBeenCalled();
    expect(apiCalls.filter((c) => WRITE.test(c))).toEqual([]);
    expect(txLabels).toEqual([]);
    expect(getSlicerById("on-deleted-canvas")).toBeUndefined();
  });

  it("a PINNED slicer is never re-applied: the undone step restored the pre-pin pivot, and a re-apply would re-query into a fresh step that wipes redo", async () => {
    await load([slicer("pin", { selectedItems: ["East"], filterLevel: 3 })]);
    backendSlicers = [slicer("pin", { selectedItems: ["West"], filterLevel: 3 })];
    await refreshCacheAndReapplyChangedFilters();
    expect(mockApply).not.toHaveBeenCalled();
  });

  it("an undone LEVEL change (pinned <-> ordinary) is not re-applied either: the undone step restored the mask", async () => {
    await load([slicer("lvl", { selectedItems: ["East"], filterLevel: 3 })]);
    backendSlicers = [slicer("lvl", { selectedItems: ["East"], filterLevel: 1 })];
    await refreshCacheAndReapplyChangedFilters();
    expect(mockApply).not.toHaveBeenCalled();
  });

  it("pivots that refuse the re-apply are told in ONE toast for the whole Ctrl+Z, not one per slicer", async () => {
    await load([
      slicer("s1", { selectedItems: ["East"] }),
      slicer("s2", { selectedItems: ["West"] }),
    ]);
    backendSlicers = backendSlicers.map((s) => ({ ...s, selectedItems: null }));
    refusals = { s1: "Column 'Geo.Region' not found in model", s2: "Column 'Geo.Region' not found in model" };

    await refreshCacheAndReapplyChangedFilters();

    expect(mockApply).toHaveBeenCalledTimes(2);
    expect(mockReport).toHaveBeenCalledTimes(1);
    expect(mockReport.mock.calls[0][0].map((f) => f.slicer)).toEqual(["s1", "s2"]);
  });

  it("the initial load applies nothing (the pivots' hidden items are persisted)", async () => {
    backendSlicers = [slicer("s1", { selectedItems: ["East"] }), slicer("s2", { selectedItems: ["West"] })];
    await refreshCache();
    expect(mockApply).not.toHaveBeenCalled();
    // A re-read with nothing changed applies nothing either.
    await refreshCacheAndReapplyChangedFilters();
    expect(mockApply).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// A view reads; it never writes
// ---------------------------------------------------------------------------

describe("switching to a canvas with model slicers", () => {
  it("only READS: no selection write, no filter write -- even when an item read fails", async () => {
    backendSlicers = [slicer("s1", { selectedItems: ["East"] })];
    itemsError = "Field 'Geo.Region' not found in pivot cache";
    await refreshCache();
    expect(apiCalls.every((c) => c === "getAllSlicers" || c.startsWith("getSlicerItems:"))).toBe(true);
    expect(mockApply).not.toHaveBeenCalled();
    // A MODEL slicer never reaches the pivot-slicer fallback at all.
    expect(mockListFromModel).not.toHaveBeenCalled();
    expect(txLabels).toEqual([]);
  });

  it("a PIVOT slicer whose column left its BI pivot is LISTED from the model -- no write, no undo step, no transaction", async () => {
    backendSlicers = [slicer("p1", { sourceType: "pivot", cacheSourceId: "pv", selectedItems: ["East"], connectedSources: [{ sourceType: "pivot", sourceId: "pv" }] })];
    itemsError = "Field 'Geo.Region' not found in pivot cache";
    const fromModel = [
      { value: "East", selected: true, hasData: true },
      { value: "West", selected: false, hasData: true },
    ];
    mockListFromModel.mockImplementation(async () => fromModel);

    await refreshCache();

    expect(mockListFromModel).toHaveBeenCalledTimes(1);
    expect(getCachedItems("p1")).toEqual(fromModel);
    // A navigation READS: nothing but the slicer list and item reads.
    expect(apiCalls.every((c) => c === "getAllSlicers" || c.startsWith("getSlicerItems:"))).toBe(true);
    expect(mockApply).not.toHaveBeenCalled();
    expect(txLabels).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Delete relies on the backend's clear
// ---------------------------------------------------------------------------

describe("deleting a slicer", () => {
  it("issues no filter write of its own and repaints the pivots the backend cleared", async () => {
    await load([slicer("s1", { selectedItems: ["East"] })]);
    const refresh = vi.fn();
    window.addEventListener("pivot:refresh", refresh);
    try {
      expect(await deleteSlicerAsync("s1")).toBe(true);
    } finally {
      window.removeEventListener("pivot:refresh", refresh);
    }
    expect(apiCalls.filter((c) => WRITE.test(c))).toEqual(["deleteSlicer:s1"]);
    expect(mockApply).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(mockEmit).toHaveBeenCalledWith("app:grid-refresh");
  });

  it("an idle slicer's delete changes no pivot, so nothing is repainted", async () => {
    await load([slicer("s1")]);
    const refresh = vi.fn();
    window.addEventListener("pivot:refresh", refresh);
    try {
      await deleteSlicerAsync("s1");
    } finally {
      window.removeEventListener("pivot:refresh", refresh);
    }
    expect(refresh).not.toHaveBeenCalled();
  });

  it("a TABLE slicer's delete refreshes the AutoFilter view (the backend cleared its column) and repaints no pivot", async () => {
    await load([
      slicer("t1", {
        sourceType: "table",
        cacheSourceId: "tbl",
        fieldName: "Region",
        selectedItems: ["East"],
        connectedSources: [{ sourceType: "table", sourceId: "tbl" }],
      }),
    ]);
    const refresh = vi.fn();
    window.addEventListener("pivot:refresh", refresh);
    try {
      expect(await deleteSlicerAsync("t1")).toBe(true);
    } finally {
      window.removeEventListener("pivot:refresh", refresh);
    }
    expect(apiCalls.filter((c) => WRITE.test(c))).toEqual(["deleteSlicer:t1"]);
    expect(mockApply).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    // The AutoFilter owner re-reads on the "objects" domain (the one an undo
    // of the same AutoFilter change reports), and the grid repaints.
    expect(mockEmit).toHaveBeenCalledWith("app:mutation-refresh", { domains: ["objects"], source: "commit" });
    expect(mockEmit).toHaveBeenCalledWith("app:grid-refresh");
  });

  it("an idle TABLE slicer's delete clears nothing, so nothing is re-read", async () => {
    await load([
      slicer("t1", {
        sourceType: "table",
        cacheSourceId: "tbl",
        fieldName: "Region",
        connectedSources: [{ sourceType: "table", sourceId: "tbl" }],
      }),
    ]);
    await deleteSlicerAsync("t1");
    expect(mockEmit).not.toHaveBeenCalledWith("app:mutation-refresh", { domains: ["objects"], source: "commit" });
    expect(mockEmit).not.toHaveBeenCalledWith("app:grid-refresh");
  });

  it("several slicers are deleted one after another inside ONE undo transaction", async () => {
    await load([slicer("a", { selectedItems: ["X"] }), slicer("b")]);
    const failed = await deleteSlicersAsync(["a", "b"], "Delete Slicers");
    expect(failed).toEqual([]);
    expect(txLabels).toEqual(["Delete Slicers"]);
    expect(log.map((l) => [l.what, l.inTx, l.detail])).toEqual([
      ["delete", true, "a"],
      ["delete", true, "b"],
    ]);
    expect(mockApply).not.toHaveBeenCalled();
  });
});
