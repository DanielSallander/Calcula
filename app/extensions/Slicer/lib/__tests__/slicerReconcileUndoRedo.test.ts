//! FILENAME: app/extensions/Slicer/lib/__tests__/slicerReconcileUndoRedo.test.ts
// PURPOSE: The reconcile after an undo / redo ("slicers:refresh") must not
//          break undo and redo for a TABLE slicer -- the store AND the bridge,
//          real, against a backend double that records undo the way the real
//          one does.
//
// A table slicer click is ONE undo step: update_slicer_selection and the
// table's AutoFilter write (set_column_filter_values records obj_autofilter)
// both join the click's transaction. So Ctrl+Z already restores the table's
// AutoFilter. The reconcile used to re-apply the table anyway: with no
// transaction open, clear_column_criteria / set_column_filter_values recorded a
// FRESH step, and a fresh step clears the redo stack -- Ctrl+Y dead, and the
// next Ctrl+Z spent on a step that changed nothing. Only a level-1 PIVOT mask
// (which records no undo) needs re-deriving, and it still is, even on a slicer
// that also reaches a table.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Slicer } from "../slicerTypes";

// ---------------------------------------------------------------------------
// The backend double: an undo and a redo stack, and the commands the store and
// the bridge send.
// ---------------------------------------------------------------------------

const undoStack: string[] = [];
const redoStack: string[] = [];
const invokes: string[] = [];
/** Every pivot filter request, with its command. */
const pivotRequests: Array<{ cmd: string; request: Record<string, unknown> }> = [];
/** The pivots `get_all_pivot_tables` lists (a deleted one is absent). */
let alivePivots: string[] = [];
let backendSlicers: Slicer[] = [];

/** A command that records undo outside any transaction: a new step, and a
 *  new step clears redo (core/engine/src/undo.rs push_transaction). */
function recordStep(label: string): void {
  undoStack.push(label);
  redoStack.length = 0;
}

vi.mock("../slicerBackend", () => ({
  slicerBackend: {
    invoke: (cmd: string, args?: Record<string, unknown>) => {
      invokes.push(cmd);
      switch (cmd) {
        case "get_tables_for_sheet":
          return Promise.resolve([
            {
              id: "t1",
              startCol: 0,
              autoFilterId: "af1",
              columns: [{ name: "Region" }, { name: "Amount" }],
              styleOptions: { headerRow: true, showFilterButton: true },
            },
          ]);
        case "get_pivot_hierarchies":
          // A range pivot that carries the column.
          return Promise.resolve({ hierarchies: [{ index: 0, name: "Region" }] });
        case "get_all_pivot_tables":
          return Promise.resolve(alivePivots.map((id) => ({ id, name: id, sourceRange: "" })));
        case "apply_pivot_filter":
        case "clear_pivot_filter": {
          // A level-1 pivot mask records no undo of its own -- and a
          // `reconcile` request records nothing even when it overwrites.
          const request = (args as { request: Record<string, unknown> }).request;
          pivotRequests.push({ cmd, request });
          if (request.reconcile !== true) recordStep("Filter pivot");
          return Promise.resolve({ pivotId: request.pivotId });
        }
        default:
          return Promise.resolve(undefined);
      }
    },
  },
}));

// The AutoFilter owner's controller: its column writes reach the same backend
// commands, which record a step of their own (autofilter.rs
// record_autofilter_undo), so here they record one.
vi.mock("@api/autoFilterService", () => ({
  requireAutoFilterController: () => ({
    get: async () => {
      invokes.push("autoFilter.get");
      return { id: "af1", startRow: 0, startCol: 0, endRow: 9, endCol: 1, enabled: true, isDataFiltered: false, columns: [], hiddenRows: [] };
    },
    setColumn: async () => {
      invokes.push("set_column_filter_values");
      recordStep("Filter");
      return null;
    },
    clear: async () => {
      invokes.push("clear_column_criteria");
      recordStep("Clear column filter");
      return null;
    },
  }),
}));

vi.mock("../slicer-api", () => ({
  getAllSlicers: async () =>
    backendSlicers.map((s) => ({ ...s, selectedItems: s.selectedItems ? [...s.selectedItems] : null })),
  getSlicerItems: async () => [],
}));

vi.mock("@api/gridOverlays", () => ({
  replaceGridRegionsByType: vi.fn(),
  removeGridRegionsByType: vi.fn(),
  requestOverlayRedraw: vi.fn(),
}));
vi.mock("@api/state", () => ({
  getGridStateSnapshot: () => ({ sheetContext: { activeSheetIndex: 0 } }),
}));
vi.mock("@api/events", () => ({
  emitAppEvent: vi.fn(),
  AppEvents: { MUTATION_REFRESH: "app:mutation-refresh", GRID_REFRESH: "app:grid-refresh" },
}));
vi.mock("@api", () => ({
  emitAppEvent: vi.fn(),
  AppEvents: { MUTATION_REFRESH: "app:mutation-refresh", GRID_REFRESH: "app:grid-refresh" },
}));
vi.mock("@api/notifications", () => ({ showToast: vi.fn() }));
vi.mock("@api/pivotNotices", () => ({ surfacePivotNotices: vi.fn() }));
vi.mock("@api/objectGeometry", () => ({
  isUndoTransactionOpen: () => false,
  undoCommitsSettled: () => Promise.resolve(),
  runInUndoTransaction: async (_label: string, fn: () => Promise<unknown>) => fn(),
}));

import { refreshCache, refreshCacheAndReapplyChangedFilters, resetStore } from "../slicerStore";
import { showToast } from "@api/notifications";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function tableSlicer(overrides: Partial<Slicer> = {}): Slicer {
  return {
    id: "ts",
    name: "Region",
    headerText: null,
    sheetIndex: 0,
    x: 0,
    y: 0,
    width: 180,
    height: 240,
    sourceType: "table",
    cacheSourceId: "t1",
    fieldName: "Region",
    selectedItems: ["East"],
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
    connectedSources: [{ sourceType: "table", sourceId: "t1" }],
    filterLevel: 1,
    ...overrides,
  };
}

const TABLE_WRITES = new Set(["set_column_filter_values", "clear_column_criteria"]);

/** The backend's Ctrl+Z / Ctrl+Y of the click: move the step between the
 *  stacks and put the slicer's selection back, as apply_slicer_restore does
 *  (the AutoFilter is restored by the SAME step). */
function backendUndo(selection: string[] | null): void {
  redoStack.push(undoStack.pop()!);
  backendSlicers = backendSlicers.map((s) => ({ ...s, selectedItems: selection }));
}
function backendRedo(selection: string[] | null): void {
  undoStack.push(redoStack.pop()!);
  backendSlicers = backendSlicers.map((s) => ({ ...s, selectedItems: selection }));
}

beforeEach(async () => {
  resetStore();
  undoStack.length = 0;
  redoStack.length = 0;
  invokes.length = 0;
  pivotRequests.length = 0;
  alivePivots = [];
  vi.mocked(showToast).mockClear();
});

async function afterClick(slicer: Slicer): Promise<void> {
  // The click's one step is on the stack, the store holds the clicked state.
  backendSlicers = [slicer];
  await refreshCache();
  undoStack.push("Slicer Selection");
  invokes.length = 0;
}

// ---------------------------------------------------------------------------
// Fix round 5 review, finding 2: an undone -- or DECLINED -- Report
// Connections save puts the connection list back, but the level-1 masks the
// save put on or took off pivots recorded nothing. The reconcile follows the
// connections: the mask comes OFF the pivot the undo disconnected (the one
// the save had added) and goes back ON the one it reconnected (the one the
// save had removed), every write a reconcile write that records nothing.
// ---------------------------------------------------------------------------

function pivotSlicer(pivots: string[], overrides: Partial<Slicer> = {}): Slicer {
  return tableSlicer({
    sourceType: "pivot",
    cacheSourceId: pivots[0],
    connectedSources: pivots.map((id) => ({ sourceType: "pivot" as const, sourceId: id })),
    ...overrides,
  });
}

const pivotWrites = () => pivotRequests.map((r) => [r.cmd, r.request.pivotId, r.request.reconcile]);

describe("the reconcile after an undone / declined Report Connections save", () => {
  it("takes the mask OFF the pivot the undo disconnected and puts it back ON the one it reconnected -- recording nothing", async () => {
    // The Save swapped p-old for p-new (and masked / unmasked them); the undo
    // put the old connection list back. Every pivot still exists.
    await afterClick(pivotSlicer(["p-keep", "p-new"]));
    alivePivots = ["p-keep", "p-new", "p-old"];
    backendSlicers = [pivotSlicer(["p-keep", "p-old"])];

    await refreshCacheAndReapplyChangedFilters();

    expect(pivotWrites()).toEqual([
      ["clear_pivot_filter", "p-new", true],
      ["apply_pivot_filter", "p-old", true],
    ]);
    // The untouched pivot is left alone, and the reconcile recorded nothing.
    expect(undoStack).toEqual(["Slicer Selection"]);
  });

  it("a pivot disconnected because it was DELETED is not cleared -- nothing is left to clear, and no refusal is told", async () => {
    await afterClick(pivotSlicer(["p-keep", "p-dead"]));
    alivePivots = ["p-keep"];
    backendSlicers = [pivotSlicer(["p-keep"])];

    await refreshCacheAndReapplyChangedFilters();

    expect(pivotWrites()).toEqual([]);
    expect(vi.mocked(showToast)).not.toHaveBeenCalled();
  });

  it("a slicer that filters nothing writes nothing when its connections move", async () => {
    await afterClick(pivotSlicer(["p-keep", "p-new"], { selectedItems: null }));
    alivePivots = ["p-keep", "p-new", "p-old"];
    backendSlicers = [pivotSlicer(["p-keep", "p-old"], { selectedItems: null })];

    await refreshCacheAndReapplyChangedFilters();

    expect(pivotWrites()).toEqual([]);
  });
});

describe("the reconcile after an undo / redo of a TABLE slicer click", () => {
  it("Ctrl+Z: re-applies no table write, so Ctrl+Y still redoes the click", async () => {
    await afterClick(tableSlicer());

    backendUndo(null);
    await refreshCacheAndReapplyChangedFilters();

    expect(invokes.filter((c) => TABLE_WRITES.has(c))).toEqual([]);
    expect(undoStack).toEqual([]);
    expect(redoStack).toEqual(["Slicer Selection"]);
  });

  it("Ctrl+Y: re-applies no table write either, so the undo stack holds exactly the click again", async () => {
    await afterClick(tableSlicer());
    backendUndo(null);
    await refreshCacheAndReapplyChangedFilters();
    invokes.length = 0;

    backendRedo(["East"]);
    await refreshCacheAndReapplyChangedFilters();

    expect(invokes.filter((c) => TABLE_WRITES.has(c))).toEqual([]);
    expect(undoStack).toEqual(["Slicer Selection"]);
    expect(redoStack).toEqual([]);
  });

  it("a slicer reaching a table AND a pivot still re-masks the pivot (its mask recorded no undo)", async () => {
    await afterClick(
      tableSlicer({
        connectedSources: [
          { sourceType: "table", sourceId: "t1" },
          { sourceType: "pivot", sourceId: "p1" },
        ],
      }),
    );

    backendUndo(null);
    await refreshCacheAndReapplyChangedFilters();

    expect(invokes.filter((c) => TABLE_WRITES.has(c))).toEqual([]);
    expect(invokes).toContain("clear_pivot_filter");
    expect(redoStack).toEqual(["Slicer Selection"]);
  });
});
