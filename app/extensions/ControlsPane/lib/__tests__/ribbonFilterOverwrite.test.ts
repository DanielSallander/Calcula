//! FILENAME: app/extensions/ControlsPane/lib/__tests__/ribbonFilterOverwrite.test.ts
// PURPOSE: A ribbon filter selection that grows pivots over the user's cells
//          (fix round 5, F6), and the reconcile after an outside change.
//
//          Wave B (BUG-0187 / BUG-0200): the change is ONE backend command --
//          the selection AND every pivot -- that records ONE step and names
//          it (`overwriteToken`). The store asks ONCE for the whole change,
//          after that step landed, naming how many cells, through
//          `@api/pivotOverwrite` (Tauri-shaped `confirmAsync` double, FAILING
//          CLOSED), and a decline hands back the change's tokens -- the WHOLE
//          change, selection and pivots, one step (no separate selection step
//          to name any more). A change whose step is not its own never asks.
//
//          The pivots a change masked WITHOUT overwriting recorded nothing;
//          after ANY outside change of a filter -- a plain Ctrl+Z, a declined
//          change's take-back, a pull -- the store's reconcile re-derives
//          them from the restored state, recording nothing (the general
//          ribbon reconcile; it used to exist for the decline path only), and
//          a declined change resolves only once that reconcile has landed.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  confirm: vi.fn((..._a: unknown[]): Promise<boolean> => Promise.resolve(false)),
  undo: vi.fn((..._a: unknown[]) =>
    Promise.resolve({ stepsUndone: 1, complete: true, refreshDomains: ["pivot", "ribbonFilter"] }),
  ),
  getAll: vi.fn(),
  apply: vi.fn(async (..._a: unknown[]) => undefined),
  clear: vi.fn(async (..._a: unknown[]) => undefined),
  clearColumn: vi.fn(async (..._a: unknown[]) => undefined),
  /** What the gesture double notes into the change's tally. */
  gestureNotes: [] as Array<Record<string, unknown>>,
  gestureStep: "pushed" as string,
  /** Every gesture, as the filter it carried. */
  gestures: [] as Array<{ id: string; selectedItems: string[] | null }>,
  toast: vi.fn(),
  order: [] as string[],
  /** The Shell's fan-out: MUTATION_REFRESH "ribbonFilter" -> the reconcile. */
  fanOut: null as null | (() => void),
  /** When set, the change's backend command lands only once this settles. */
  holdGesture: null as null | Promise<void>,
}));

vi.mock("../../../../src/core/lib/tauri-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/core/lib/tauri-api")>()),
  getUndoState: async () => ({ undoSeqs: [], transactionOpen: false }),
}));
vi.mock("@api/notifications", () => ({ showToast: (...a: unknown[]) => h.toast(...a) }));
vi.mock("@api/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitAppEvent: (evt: string, payload?: { domains?: string[] }) => {
    if (evt === "app:mutation-refresh" && payload?.domains?.includes("ribbonFilter")) h.fanOut?.();
  },
}));

vi.mock("../filterPaneApi", () => ({
  updateRibbonFilterSelection: async () => undefined,
  getAllRibbonFilters: () => h.getAll(),
  getBiConnections: async () => [],
  recalcControlDependents: () => Promise.resolve([]),
  getBiColumnValues: async () => [],
  getBiColumnAvailableValues: async () => [],
}));
vi.mock("../filterPaneFilterBridge", () => ({
  applyRibbonFilter: (...a: unknown[]) => h.apply(...a),
  clearRibbonFilter: (...a: unknown[]) => h.clear(...a),
  clearModelColumnOnPivots: (...a: unknown[]) => h.clearColumn(...a),
  reportRibbonFilterFailures: vi.fn(),
  // Manual mode: the stored list; anything else: two pivots.
  resolveTargetPivots: async (f: { connectionMode?: string; connectedPivots?: string[] }) =>
    f.connectionMode === "manual" ? [...(f.connectedPivots ?? [])] : ["pA", "pB"],
  runRibbonFilterSelectionGesture: async (f: { id: string; selectedItems: string[] | null }) => {
    if (h.holdGesture) await h.holdGesture;
    h.order.push("change");
    h.gestures.push({ id: f.id, selectedItems: f.selectedItems });
    const { createPivotOverwriteTally } = await import("@api/pivotOverwrite");
    const overwrites = createPivotOverwriteTally();
    for (const note of h.gestureNotes) overwrites.note(note as never);
    return { step: h.gestureStep, overwrites };
  },
}));
vi.mock("@api/dialogs", () => ({
  confirmAsync: (...a: unknown[]) => {
    h.order.push("ask");
    return h.confirm(...a);
  },
}));
vi.mock("@api/backend", () => ({ undoPivotOverwrite: (...a: unknown[]) => h.undo(...a) }));
vi.mock("@api/objectGeometry", () => ({
  isUndoTransactionOpen: () => false,
  undoCommitsSettled: () => Promise.resolve(),
}));

import type { RibbonFilter } from "../filterPaneTypes";
import {
  clearCache,
  getFilterById,
  isRibbonFilterChangeLanding,
  refreshCache,
  refreshCacheAndReapplyChangedFilters,
  ribbonFiltersWhoseFilterChanged,
  updateFilterSelectionAsync,
} from "../filterPaneStore";

const FID = "0197f001-0000-7000-8000-000000000001";

function filter(overrides: Partial<RibbonFilter> = {}): RibbonFilter {
  return {
    id: FID,
    name: "Category",
    connectionId: "0197a001-0000-7000-8000-00000000000a",
    fieldName: "Products.Category",
    fieldDataType: "text",
    connectionMode: "workbook",
    connectedPivots: [],
    connectedSheets: [],
    displayMode: "checklist",
    selectedItems: null,
    crossFilterTargets: [],
    crossFilterSlicerTargets: [],
    advancedFilter: null,
    hideNoData: false,
    indicateNoData: true,
    sortNoDataLast: false,
    showSelectAll: true,
    singleSelect: false,
    order: 0,
    buttonColumns: 1,
    buttonRows: 1,
    ...overrides,
  };
}

/** The backend as it stands: a FRESH object per read. */
function backendHolds(overrides: Partial<RibbonFilter>): void {
  h.getAll.mockReset().mockImplementation(async () => [filter(overrides)]);
}

/** The change grew two pivots over 1 + 4 cells, both in its one step. */
function changeOverwrites(): void {
  h.gestureNotes = [
    { pivotId: "pA", overwrittenCellCount: 1, overwriteToken: 51 },
    { pivotId: "pB", overwrittenCellCount: 4, overwriteToken: 51 },
  ];
}

/** The take-back puts the backend's filter back to `restored`. */
function takeBackRestores(restored: Partial<RibbonFilter>): void {
  h.undo.mockImplementation(async () => {
    backendHolds(restored);
    return { stepsUndone: 1, complete: true, refreshDomains: ["pivot", "ribbonFilter"] };
  });
}

const reconciles: Promise<unknown>[] = [];

beforeEach(async () => {
  clearCache();
  h.order.length = 0;
  h.gestures.length = 0;
  h.gestureNotes = [];
  h.gestureStep = "pushed";
  h.toast.mockReset();
  h.confirm.mockReset().mockImplementation(() => Promise.resolve(false));
  h.undo.mockReset().mockImplementation(() =>
    Promise.resolve({ stepsUndone: 1, complete: true, refreshDomains: ["pivot", "ribbonFilter"] }),
  );
  h.apply.mockClear();
  h.clear.mockClear();
  h.clearColumn.mockClear();
  reconciles.length = 0;
  h.fanOut = () => {
    reconciles.push(refreshCacheAndReapplyChangedFilters());
  };
  backendHolds({});
  await refreshCache();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("a ribbon filter change that grows pivots over the user's cells", () => {
  it("asks ONCE, after the change's one step landed, naming every cell; OK keeps it", async () => {
    changeOverwrites();
    h.confirm.mockImplementation(() => Promise.resolve(true));

    await updateFilterSelectionAsync(FID, ["Books"]);

    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(h.confirm.mock.calls[0][0]).toContain("5 cells");
    expect(h.order).toEqual(["change", "ask"]);
    expect(h.undo).not.toHaveBeenCalled();
  });

  it("a decline hands back the change's token -- the whole change, one step, nothing named after it", async () => {
    changeOverwrites();

    await updateFilterSelectionAsync(FID, ["Books"]);

    expect(h.undo).toHaveBeenCalledTimes(1);
    expect(h.undo).toHaveBeenCalledWith("pA", [51]);
  });

  it("a CLEAR (select all) that overwrites is asked about and declined the same way", async () => {
    changeOverwrites();

    await updateFilterSelectionAsync(FID, null);

    expect(h.gestures).toEqual([{ id: FID, selectedItems: null }]);
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(h.undo).toHaveBeenCalledWith("pA", [51]);
  });

  it("FAILS CLOSED: a dialog that cannot be shown is a decline", async () => {
    changeOverwrites();
    h.confirm.mockImplementation(() => Promise.reject(new Error("the dialog could not be shown")));

    await updateFilterSelectionAsync(FID, ["Books"]);

    expect(h.undo).toHaveBeenCalledWith("pA", [51]);
  });

  it("a change that overwrote nothing asks nothing", async () => {
    await updateFilterSelectionAsync(FID, ["Books"]);

    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.undo).not.toHaveBeenCalled();
  });

  it("a change whose step is not its own (nothing recorded) never asks", async () => {
    changeOverwrites();
    h.gestureStep = "nothing";

    await updateFilterSelectionAsync(FID, ["Books"]);

    expect(h.confirm).not.toHaveBeenCalled();
  });
});

describe("a declined change: the pivots that recorded nothing", () => {
  it("are re-derived by the reconcile the take-back starts, from the RESTORED selection, and the change waits for it", async () => {
    backendHolds({ selectedItems: ["Toys"] });
    await refreshCache();
    h.gestureNotes = [{ pivotId: "pA", overwrittenCellCount: 2, overwriteToken: 51 }];
    takeBackRestores({ selectedItems: ["Toys"] });

    await updateFilterSelectionAsync(FID, ["Books", "Toys"]);

    expect(h.undo).toHaveBeenCalledWith("pA", [51]);
    expect(reconciles, "the take-back's announcement started no reconcile").toHaveLength(1);
    expect(h.apply, "nothing re-derived the masks").toHaveBeenCalledTimes(1);
    const [rederived, , tally, reconcile] = h.apply.mock.calls[0];
    expect((rederived as RibbonFilter).selectedItems).toEqual(["Toys"]);
    expect(tally, "a re-derive is not a gesture: nothing to ask about").toBeUndefined();
    expect(reconcile, "a re-derive must record nothing").toEqual({ skipPivotIds: [] });
    // Resolved on the restored selection.
    expect(getFilterById(FID)?.selectedItems).toEqual(["Toys"]);
  });

  it("when the take-back started no reconcile (no ribbonFilter domain), the store runs one itself", async () => {
    backendHolds({ selectedItems: null });
    await refreshCache();
    h.gestureNotes = [{ pivotId: "pA", overwrittenCellCount: 2, overwriteToken: 51 }];
    h.undo.mockImplementation(async () => {
      backendHolds({ selectedItems: null });
      return { stepsUndone: 1, complete: true, refreshDomains: ["pivot"] };
    });

    await updateFilterSelectionAsync(FID, ["Books"]);

    expect(reconciles).toHaveLength(0);
    expect(h.clear, "the restored ALL was not re-derived").toHaveBeenCalledTimes(1);
    expect(h.clear.mock.calls[0][3]).toEqual({ skipPivotIds: [] });
  });
});

describe("the general ribbon reconcile after an outside change (BUG-0200)", () => {
  it("a plain Ctrl+Z that restored a selection re-derives that filter's masks, recording nothing", async () => {
    backendHolds({ selectedItems: ["Books"] });
    await refreshCache();
    backendHolds({ selectedItems: ["Toys"] }); // the undo restored Toys

    const changed = await refreshCacheAndReapplyChangedFilters();

    expect(changed.map((f) => f.id)).toEqual([FID]);
    expect(h.apply).toHaveBeenCalledTimes(1);
    expect((h.apply.mock.calls[0][0] as RibbonFilter).selectedItems).toEqual(["Toys"]);
    expect(h.apply.mock.calls[0][3]).toEqual({ skipPivotIds: [] });
  });

  it("targets that moved while the filter filters something: the mask comes OFF the pivot it no longer reaches", async () => {
    backendHolds({ selectedItems: ["Books"], connectionMode: "manual", connectedPivots: ["pA", "pB"] });
    await refreshCache();
    backendHolds({ selectedItems: ["Books"], connectionMode: "manual", connectedPivots: ["pA"] });

    await refreshCacheAndReapplyChangedFilters();

    expect(h.clearColumn).toHaveBeenCalledTimes(1);
    expect(h.clearColumn.mock.calls[0][0]).toBe("Products.Category");
    expect(h.clearColumn.mock.calls[0][1]).toEqual(["pB"]);
    expect(h.clearColumn.mock.calls[0][2]).toMatchObject({ reconcile: true });
    expect(h.apply).toHaveBeenCalledTimes(1);
  });

  it("the ribbonFilter fan-out (undo, redo, a take-back) runs THIS reconcile, not a bare re-read", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(__dirname, "../../index.ts"), "utf8");
    const at = src.indexOf("const handleFiltersRefresh = () => {");
    expect(at, "test out of date: the fan-out handler").toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf("};", at));
    expect(body).toContain("refreshCacheAndReapplyChangedFilters()");
  });

  it("a change reads as LANDING until its one step landed, and the ControlsPane refuses a keyboard Undo meanwhile", async () => {
    // The review of BUG-0187: the backend refuses an undo or redo while the
    // change lands; the keyboard's refusal (ControlsPane/index.ts) asks this.
    let release!: () => void;
    h.holdGesture = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const change = updateFilterSelectionAsync(FID, ["Books"]);
      await vi.waitFor(() => expect(isRibbonFilterChangeLanding(), "the change in flight does not read as landing").toBe(true));
      release();
      await change;
      expect(isRibbonFilterChangeLanding(), "the change landed and still reads as landing").toBe(false);
    } finally {
      h.holdGesture = null;
    }
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(__dirname, "../../index.ts"), "utf8");
    expect(src, "the ControlsPane does not refuse a keyboard Undo while a change lands").toContain(
      "refuseUndoWhileAGestureLands(isRibbonFilterChangeLanding)",
    );
  });

  it("the initial load re-derives nothing", async () => {
    clearCache();
    backendHolds({ selectedItems: ["Books"] });
    await refreshCacheAndReapplyChangedFilters();
    expect(h.apply).not.toHaveBeenCalled();
  });

  it("Ctrl+Z of a filter's DELETE re-derives the masks of the filter it brings back (the delete cleared them unrecorded)", async () => {
    // The review of S2: deleteFilterAsync cleared the filter's level-1 masks
    // (recording nothing) and the backend delete recorded only the filter, so
    // the undo restored the card with its selection over unfiltered pivots.
    h.getAll.mockReset().mockImplementation(async () => []);
    await refreshCache();
    backendHolds({ selectedItems: ["Books"] }); // the undo brought it back
    await refreshCacheAndReapplyChangedFilters();
    expect(h.apply, "the restored filter's pivots were never re-masked").toHaveBeenCalledTimes(1);
    expect((h.apply.mock.calls[0][0] as RibbonFilter).selectedItems).toEqual(["Books"]);
    expect(h.apply.mock.calls[0][3], "the re-derive is not a reconcile (it would record a step)").toBeDefined();
    expect(h.clearColumn, "a filter that came back had no old reach to take off").not.toHaveBeenCalled();
  });
});

describe("ribbonFiltersWhoseFilterChanged (pure)", () => {
  it("ordinary filters whose selection -- or, while filtering, whose targets -- moved, and ordinary ones that APPEARED with a selection", () => {
    const f = (id: string, o: Partial<RibbonFilter>) => filter({ id, ...o });
    const before = [
      f("changed", { selectedItems: ["A"] }),
      f("same", { selectedItems: ["B"] }),
      f("vanished", { selectedItems: ["C"] }),
      f("pinned", { selectedItems: ["D"], filterLevel: 2 }),
      f("moved", { selectedItems: ["E"], connectionMode: "manual", connectedPivots: ["p1", "p2"] }),
      f("idleMoved", { selectedItems: null, connectionMode: "manual", connectedPivots: ["p1"] }),
      f("reordered", { selectedItems: ["F"], connectionMode: "manual", connectedPivots: ["p1", "p2"] }),
    ];
    const after = [
      f("changed", { selectedItems: ["A", "Z"] }),
      f("same", { selectedItems: ["B"] }),
      f("appeared", { selectedItems: ["G"] }),
      f("appearedIdle", { selectedItems: null }),
      f("appearedPinned", { selectedItems: ["I"], filterLevel: 2 }),
      f("pinned", { selectedItems: ["H"], filterLevel: 2 }),
      f("moved", { selectedItems: ["E"], connectionMode: "manual", connectedPivots: ["p1"] }),
      f("idleMoved", { selectedItems: null, connectionMode: "manual", connectedPivots: ["p2"] }),
      f("reordered", { selectedItems: ["F"], connectionMode: "manual", connectedPivots: ["p2", "p1"] }),
    ];
    expect(ribbonFiltersWhoseFilterChanged(before, after).map((x) => x.id)).toEqual(["changed", "appeared", "moved"]);
  });
});
