//! FILENAME: app/extensions/ControlsPane/lib/__tests__/ribbonFilterOverwrite.test.ts
// PURPOSE: A ribbon filter selection that grows pivots over the user's cells
//          (fix round 5, F6). The backend records the cells in the pivot step
//          ("Ribbon filter change") and names it (`overwriteToken`); the store
//          asks ONCE for the whole change, after that step has committed,
//          naming how many cells, through `@api/pivotOverwrite` (Tauri-shaped
//          `confirmAsync` double, FAILING CLOSED). A decline hands back the
//          change's tokens AND the selection's own step -- which the ribbon
//          backend records separately, beneath the pivots' -- so the filter
//          card and the pivots come back together; it names that step only
//          when it can prove it (`runNamingItsUndoStep`), never a guess.
//          The bridge notes every pivot response into the tally.
//
//          Fix round 5 review: after a decline, the pivots the change masked
//          WITHOUT overwriting (they recorded nothing, so the take-back could
//          not restore them) are re-derived from the RESTORED selection,
//          recording nothing (finding 2); and a change made while a script
//          batch holds a BACKEND transaction open never asks (finding 3).

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  confirm: vi.fn((..._a: unknown[]): Promise<boolean> => Promise.resolve(false)),
  undo: vi.fn((..._a: unknown[]) =>
    Promise.resolve({ stepsUndone: 2, complete: true, refreshDomains: ["pivot", "ribbonFilter"] }),
  ),
  select: vi.fn((..._a: unknown[]) => Promise.resolve(undefined)),
  getAll: vi.fn(),
  apply: vi.fn(),
  clear: vi.fn(),
  /** The step id the selection write is proven to have pushed (null: unproven). */
  selectionStep: 77 as number | null,
  txOpen: false,
  /** A transaction a script batch opened on the BACKEND directly. */
  backendTxOpen: false,
  toast: vi.fn(),
  order: [] as string[],
}));

// The backend's undo state, which `@api/pivotOverwrite` reads to tell whether
// a transaction is open anywhere (the frontend flag is `txOpen` below).
vi.mock("../../../../src/core/lib/tauri-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/core/lib/tauri-api")>()),
  getUndoState: async () => ({ undoSeqs: [], transactionOpen: h.backendTxOpen }),
}));
vi.mock("@api/notifications", () => ({ showToast: (...a: unknown[]) => h.toast(...a) }));

vi.mock("../filterPaneApi", () => ({
  updateRibbonFilterSelection: (...a: unknown[]) => {
    h.order.push("select");
    return h.select(...a);
  },
  getAllRibbonFilters: () => h.getAll(),
  getBiConnections: async () => [],
  recalcControlDependents: () => Promise.resolve([]),
  getBiColumnValues: async () => [],
  getBiColumnAvailableValues: async () => [],
}));
vi.mock("../filterPaneFilterBridge", () => ({
  applyRibbonFilter: (...a: unknown[]) => h.apply(...a),
  clearRibbonFilter: (...a: unknown[]) => h.clear(...a),
}));
vi.mock("@api/dialogs", () => ({
  confirmAsync: (...a: unknown[]) => {
    h.order.push("ask");
    return h.confirm(...a);
  },
}));
vi.mock("@api/backend", () => ({ undoPivotOverwrite: (...a: unknown[]) => h.undo(...a) }));
vi.mock("@api/objectGeometry", () => ({ isUndoTransactionOpen: () => h.txOpen }));
vi.mock("@api/pivotOverwrite", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // The history reads are proven in src/api/__tests__/pivotOverwrite.test.ts;
  // here the write's step is whatever the test says was proven.
  runNamingItsUndoStep: async (write: () => Promise<unknown>) => ({ result: await write(), seq: h.selectionStep }),
}));

import type { RibbonFilter } from "../filterPaneTypes";
import {
  clearCache,
  refreshCache,
  updateFilterSelectionAsync,
  RIBBON_DECLINE_NOT_REDERIVED,
} from "../filterPaneStore";

function filter(overrides: Partial<RibbonFilter> = {}): RibbonFilter {
  return {
    id: "0197f001-0000-7000-8000-000000000001",
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

type Tally = { note(r: unknown): void } | undefined;

/** The bridge double: the change grew two pivots over 1 + 4 cells. */
function bridgeThatOverwrites(fn: typeof h.apply) {
  fn.mockImplementation(async (_f: RibbonFilter, _failures: unknown, overwrites?: Tally) => {
    h.order.push("pivots");
    overwrites?.note({ pivotId: "pA", overwrittenCellCount: 1, overwriteToken: 51 });
    overwrites?.note({ pivotId: "pB", overwrittenCellCount: 4, overwriteToken: 52 });
  });
}

const FID = "0197f001-0000-7000-8000-000000000001";

beforeEach(async () => {
  clearCache();
  h.order.length = 0;
  h.txOpen = false;
  h.backendTxOpen = false;
  h.toast.mockReset();
  h.selectionStep = 77;
  h.confirm.mockReset().mockImplementation(() => Promise.resolve(false));
  h.undo.mockReset().mockImplementation(() =>
    Promise.resolve({ stepsUndone: 2, complete: true, refreshDomains: ["pivot", "ribbonFilter"] }),
  );
  h.apply.mockReset();
  h.clear.mockReset();
  h.getAll.mockReset().mockResolvedValue([filter()]);
  await refreshCache();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("a ribbon filter selection that grows pivots over the user's cells", () => {
  it("asks ONCE, after the pivot step, naming every cell; OK keeps it", async () => {
    bridgeThatOverwrites(h.apply);
    h.confirm.mockImplementation(() => Promise.resolve(true));

    await updateFilterSelectionAsync(FID, ["Books"]);

    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(h.confirm.mock.calls[0][0]).toContain("5 cells");
    expect(h.order).toEqual(["select", "pivots", "ask"]);
    expect(h.undo).not.toHaveBeenCalled();
  });

  it("a decline hands back the change's tokens AND its proven selection step -- nothing else", async () => {
    bridgeThatOverwrites(h.apply);

    await updateFilterSelectionAsync(FID, ["Books"]);

    expect(h.undo).toHaveBeenCalledTimes(1);
    expect(h.undo).toHaveBeenCalledWith("pA", [51, 52], 77);
  });

  it("a CLEAR (select all) that overwrites is asked about and declined the same way", async () => {
    bridgeThatOverwrites(h.clear);

    await updateFilterSelectionAsync(FID, null);

    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(h.undo).toHaveBeenCalledWith("pA", [51, 52], 77);
  });

  it("FAILS CLOSED: a dialog that cannot be shown is a decline", async () => {
    bridgeThatOverwrites(h.apply);
    h.confirm.mockImplementation(() => Promise.reject(new Error("the dialog could not be shown")));

    await updateFilterSelectionAsync(FID, ["Books"]);

    expect(h.undo).toHaveBeenCalledWith("pA", [51, 52], 77);
  });

  it("an UNPROVEN selection step is never named: only the pivot step is taken back", async () => {
    bridgeThatOverwrites(h.apply);
    h.selectionStep = null;

    await updateFilterSelectionAsync(FID, ["Books"]);

    expect(h.undo).toHaveBeenCalledWith("pA", [51, 52], null);
  });

  it("a change that overwrote nothing asks nothing", async () => {
    h.apply.mockImplementation(async () => undefined);

    await updateFilterSelectionAsync(FID, ["Books"]);

    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.undo).not.toHaveBeenCalled();
  });

  it("a change inside someone else's open transaction never asks", async () => {
    bridgeThatOverwrites(h.apply);
    h.txOpen = true;

    await updateFilterSelectionAsync(FID, ["Books"]);

    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.undo).not.toHaveBeenCalled();
  });

  it("a change while a script batch holds a BACKEND transaction open never asks (the frontend flag cannot see it)", async () => {
    bridgeThatOverwrites(h.apply);
    h.backendTxOpen = true;

    await updateFilterSelectionAsync(FID, ["Books"]);

    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.undo).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// After a DECLINE: the pivots that overwrote nothing follow the restored
// selection (fix round 5 review, finding 2)
// ---------------------------------------------------------------------------

/** The backend as it stands: a FRESH object per read (the store mutates the
 *  object it cached, and a shared one would make the "restored" read lie). */
function backendHolds(overrides: Partial<RibbonFilter>): void {
  h.getAll.mockReset().mockImplementation(async () => [filter(overrides)]);
}

/** The change grew pivot pA over 2 cells; pB it masked, overwriting nothing. */
function onlyPaOverwrites(fn: typeof h.apply) {
  fn.mockImplementation(async (_f: RibbonFilter, _failures: unknown, overwrites?: Tally) => {
    h.order.push("pivots");
    overwrites?.note({ pivotId: "pA", overwrittenCellCount: 2, overwriteToken: 51 });
    overwrites?.note({ pivotId: "pB", overwrittenCellCount: 0 });
  });
}

/** The take-back puts the backend's selection back to `restored`. */
function takeBackRestores(restored: Partial<RibbonFilter>): void {
  h.undo.mockImplementation(async () => {
    backendHolds(restored);
    return { stepsUndone: 2, complete: true, refreshDomains: ["pivot", "ribbonFilter"] };
  });
}

describe("a declined change: the pivots that recorded nothing", () => {
  it("are re-derived from the RESTORED selection, recording nothing, skipping the pivots the step restored", async () => {
    backendHolds({ selectedItems: ["Toys"] });
    await refreshCache();
    onlyPaOverwrites(h.apply);
    takeBackRestores({ selectedItems: ["Toys"] });

    await updateFilterSelectionAsync(FID, ["Books", "Toys"]);

    expect(h.undo).toHaveBeenCalledWith("pA", [51], 77);
    expect(h.apply, "nothing re-derived the pivot that overwrote nothing").toHaveBeenCalledTimes(2);
    const [rederived, failures, tally, reconcile] = h.apply.mock.calls[1];
    expect((rederived as RibbonFilter).selectedItems).toEqual(["Toys"]);
    expect(failures).toBeUndefined();
    expect(tally, "a re-derive is not a gesture: nothing to ask about").toBeUndefined();
    expect(reconcile).toEqual({ skipPivotIds: ["pA"] });
  });

  it("a restored ALL (no filter) is re-derived by a reconcile CLEAR", async () => {
    backendHolds({ selectedItems: null });
    await refreshCache();
    onlyPaOverwrites(h.apply);
    takeBackRestores({ selectedItems: null });

    await updateFilterSelectionAsync(FID, ["Books"]);

    expect(h.clear).toHaveBeenCalledTimes(1);
    expect((h.clear.mock.calls[0][0] as RibbonFilter).selectedItems).toBeNull();
    expect(h.clear.mock.calls[0][3]).toEqual({ skipPivotIds: ["pA"] });
  });

  it("nothing is re-derived when the selection did not come back (its step was not provably the change's)", async () => {
    backendHolds({ selectedItems: ["Toys"] });
    await refreshCache();
    onlyPaOverwrites(h.apply);
    h.selectionStep = null;
    // Only the pivot step came back: the backend still holds the declined selection.
    takeBackRestores({ selectedItems: ["Books", "Toys"] });

    await updateFilterSelectionAsync(FID, ["Books", "Toys"]);

    expect(h.undo).toHaveBeenCalledWith("pA", [51], null);
    expect(h.apply).toHaveBeenCalledTimes(1);
    expect(h.clear).not.toHaveBeenCalled();
  });

  it("nothing is re-derived at a PINNED level (every pivot's re-query recorded its pre-state in the step)", async () => {
    backendHolds({ selectedItems: ["Toys"], filterLevel: 2 });
    await refreshCache();
    onlyPaOverwrites(h.apply);
    takeBackRestores({ selectedItems: ["Toys"], filterLevel: 2 });

    await updateFilterSelectionAsync(FID, ["Books", "Toys"]);

    expect(h.apply).toHaveBeenCalledTimes(1);
  });

  it("a filter that cannot be re-read is TOLD, not swallowed", async () => {
    backendHolds({ selectedItems: ["Toys"] });
    await refreshCache();
    onlyPaOverwrites(h.apply);
    h.undo.mockImplementation(async () => {
      h.getAll.mockReset().mockImplementation(async () => {
        throw new Error("no backend");
      });
      return { stepsUndone: 2, complete: true, refreshDomains: ["pivot", "ribbonFilter"] };
    });

    await updateFilterSelectionAsync(FID, ["Books", "Toys"]);

    expect(h.apply).toHaveBeenCalledTimes(1);
    expect(h.toast).toHaveBeenCalledWith(RIBBON_DECLINE_NOT_REDERIVED, expect.objectContaining({ type: "error" }));
  });
});
