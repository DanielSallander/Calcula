//! FILENAME: app/extensions/Slicer/lib/__tests__/slicerClickOverwrite.test.ts
// PURPOSE: A slicer CLICK that grows pivots over the user's cells (fix round
//          5, F6). The backend records the overwritten cells INSIDE the
//          click's own undo step and names it (`overwriteToken`); the store
//          then asks ONCE for the whole click, after that step has landed,
//          naming how many cells -- through `@api/pivotOverwrite`, whose
//          `confirmAsync` double has the Tauri shape and FAILS CLOSED -- and a
//          decline hands back exactly the click's tokens, so the backend takes
//          back THE WHOLE CLICK (the selection with its pivots), never another
//          step. The click is ONE backend gesture (wave B, BUG-0187) and a
//          user click is ALWAYS a step of its own -- even while a script batch
//          is open -- so it always asks; a gesture whose step JOINED a batch
//          (a script's own call) never does. The undo reconcile never asks.
//
//          A DECLINED click resolves only once the store holds the RESTORED
//          selection, and every user click waits for the reconciles in flight
//          before it reads the store (fix round 5 review, finding 1: a
//          Ctrl+click queued behind a declined click toggled the DECLINED
//          selection, re-applying the refused item and asking again).

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Slicer } from "../slicerTypes";

const h = vi.hoisted(() => ({
  confirm: vi.fn((..._a: unknown[]): Promise<boolean> => Promise.resolve(false)),
  undo: vi.fn((..._a: unknown[]) =>
    Promise.resolve({ stepsUndone: 1, complete: true, refreshDomains: ["slicer", "pivot"] }),
  ),
  emit: vi.fn(),
  apply: vi.fn(),
  /** The order things happened in: "select", "apply", "commit", "ask". */
  order: [] as string[],
  txDepth: 0,
  backend: [] as Slicer[],
  /** A transaction a script batch opened on the BACKEND directly. */
  backendTxOpen: false,
  /** Answer `getAllSlicers` a macrotask later, as an IPC round trip does. */
  ipcDelay: false,
  /** What `getSlicerItems` answers (a Ctrl+click toggle needs the list). */
  items: [] as Array<{ value: string; selected: boolean; hasData: boolean }>,
  /** Every selection written, in order. */
  history: [] as Array<string[] | null>,
  /** Where the backend put the gesture's step. */
  gestureStep: "pushed" as string,
}));

// The backend's undo state, which `@api/pivotOverwrite` reads to tell whether
// a transaction is open anywhere (the frontend flag is the double below).
vi.mock("../../../../src/core/lib/tauri-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/core/lib/tauri-api")>()),
  getUndoState: async () => ({ undoSeqs: [], transactionOpen: h.backendTxOpen }),
}));

vi.mock("@api/gridOverlays", () => ({
  replaceGridRegionsByType: vi.fn(),
  removeGridRegionsByType: vi.fn(),
  requestOverlayRedraw: vi.fn(),
}));
vi.mock("@api/state", () => ({
  getGridStateSnapshot: () => ({ sheetContext: { activeSheetIndex: 2 } }),
}));
vi.mock("@api/events", () => ({
  emitAppEvent: (...a: unknown[]) => h.emit(...a),
  AppEvents: { MUTATION_REFRESH: "app:mutation-refresh", GRID_REFRESH: "app:grid-refresh" },
}));
vi.mock("@api/notifications", () => ({ showToast: vi.fn() }));
vi.mock("@api/dialogs", () => ({
  confirmAsync: (...a: unknown[]) => {
    h.order.push("ask");
    return h.confirm(...a);
  },
}));
vi.mock("@api/backend", () => ({ undoPivotOverwrite: (...a: unknown[]) => h.undo(...a) }));
vi.mock("@api/objectGeometry", () => ({
  isUndoTransactionOpen: () => h.txDepth > 0,
  undoCommitsSettled: () => Promise.resolve(),
  runInUndoTransaction: async (_label: string, fn: () => Promise<unknown>) => {
    const opener = h.txDepth === 0;
    h.txDepth++;
    try {
      return await fn();
    } finally {
      h.txDepth--;
      if (opener) h.order.push("commit");
    }
  },
}));
vi.mock("../slicerFilterBridge", () => ({
  applySlicerFilter: (s: Slicer, options?: unknown) => h.apply(s, options),
  listPivotSlicerItemsFromModel: async () => null,
  reportSlicerFilterFailures: vi.fn(),
  // The click's ONE backend gesture: the selection written, then its pivot
  // writes (the `h.apply` doubles note what they overwrote), then its step.
  runSlicerSelectionGesture: async (sl: Slicer, _actor: string) => {
    h.order.push("select");
    h.history.push(sl.selectedItems);
    h.backend = h.backend.map((b) => (b.id === sl.id ? { ...b, selectedItems: sl.selectedItems } : b));
    const { createPivotOverwriteTally } = await import("@api/pivotOverwrite");
    const overwrites = createPivotOverwriteTally();
    await h.apply(sl, { overwrites });
    return { step: h.gestureStep, overwrites };
  },
}));
vi.mock("../slicer-api", () => ({
  getAllSlicers: async () => {
    if (h.ipcDelay) await new Promise((r) => setTimeout(r, 0));
    return h.backend.map((s) => ({ ...s, selectedItems: s.selectedItems ? [...s.selectedItems] : null }));
  },
  getSlicerItems: async () => h.items,
  updateSlicerSelection: async (id: string, items: string[] | null) => {
    h.order.push("select");
    h.history.push(items);
    h.backend = h.backend.map((s) => (s.id === id ? { ...s, selectedItems: items } : s));
  },
}));

import {
  clickSlicerItem,
  getSlicerById,
  refreshCache,
  refreshCacheAndReapplyChangedFilters,
  resetStore,
  updateSlicerSelectionAsync,
} from "../slicerStore";
import { SlicerEvents } from "../slicerEvents";

type Tally = { note(r: unknown): void } | undefined;

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
    connectedSources: [{ sourceType: "biConnection", sourceId: "c1" }],
    filterLevel: 1,
    ...overrides,
  };
}

/** The bridge double: the click's apply grew two pivots over 2 + 3 cells. */
function applyThatOverwrites() {
  h.apply.mockImplementation(async (_s: Slicer, options?: { overwrites?: Tally }) => {
    h.order.push("apply");
    options?.overwrites?.note({ pivotId: "pA", overwrittenCellCount: 2, overwriteToken: 11 });
    options?.overwrites?.note({ pivotId: "pB", overwrittenCellCount: 3, overwriteToken: 12 });
  });
}

const selectionChanged: unknown[] = [];
window.addEventListener(SlicerEvents.SLICER_SELECTION_CHANGED, (e) => selectionChanged.push((e as CustomEvent).detail));

beforeEach(async () => {
  resetStore();
  h.order.length = 0;
  h.txDepth = 0;
  h.backendTxOpen = false;
  h.ipcDelay = false;
  h.items = [];
  h.history.length = 0;
  h.gestureStep = "pushed";
  h.confirm.mockReset().mockImplementation(() => Promise.resolve(false));
  h.undo.mockReset().mockImplementation(() =>
    Promise.resolve({ stepsUndone: 1, complete: true, refreshDomains: ["slicer", "pivot"] }),
  );
  h.emit.mockClear();
  h.apply.mockReset();
  selectionChanged.length = 0;
  h.backend = [slicer("s1")];
  await refreshCache();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("a slicer click that grows pivots over the user's cells", () => {
  it("asks ONCE, after the click's step committed, naming every cell of every pivot", async () => {
    applyThatOverwrites();
    h.confirm.mockImplementation(() => Promise.resolve(true));

    await clickSlicerItem("s1", "West", false);

    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(h.confirm.mock.calls[0][0]).toContain("5 cells");
    // One gesture (the selection and its pivots), THEN the question.
    expect(h.order).toEqual(["select", "apply", "ask"]);
    expect(h.undo).not.toHaveBeenCalled();
    expect(selectionChanged).toHaveLength(1);
  });

  it("a decline hands back exactly the click's tokens -- the whole click, never another step", async () => {
    applyThatOverwrites();

    await clickSlicerItem("s1", "West", false);

    expect(h.undo).toHaveBeenCalledTimes(1);
    expect(h.undo).toHaveBeenCalledWith("pA", [11, 12]);
    // What came back is announced as an undo announces it (the store re-reads
    // the restored selection on the "slicer" domain), and the declined
    // selection is never announced as the new one.
    const refresh = h.emit.mock.calls.find((c) => c[0] === "app:mutation-refresh");
    expect((refresh?.[1] as { domains: string[] }).domains).toEqual(expect.arrayContaining(["slicer", "pivot"]));
    expect(selectionChanged).toEqual([]);
  });

  it("FAILS CLOSED: a dialog that cannot be shown is a decline", async () => {
    applyThatOverwrites();
    h.confirm.mockImplementation(() => Promise.reject(new Error("the dialog could not be shown")));

    await clickSlicerItem("s1", "West", false);

    expect(h.undo).toHaveBeenCalledWith("pA", [11, 12]);
  });

  it("a click that overwrote nothing asks nothing", async () => {
    h.apply.mockImplementation(async () => undefined);

    await clickSlicerItem("s1", "West", false);

    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.undo).not.toHaveBeenCalled();
    expect(selectionChanged).toHaveLength(1);
  });

  it("a gesture whose step JOINED a caller's transaction never asks (it cannot take back only its part)", async () => {
    applyThatOverwrites();
    h.gestureStep = "joined";

    await updateSlicerSelectionAsync("s1", ["West"], { askBeforeOverwrite: true });

    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.undo).not.toHaveBeenCalled();
  });

  it("a click while a script batch is open is a step of its OWN: it asks, and a decline takes back exactly its tokens", async () => {
    applyThatOverwrites();
    // `api.beginBatch` went straight to the backend; the click never joins it
    // any more (wave B): its step is pushed beside the batch.
    h.backendTxOpen = true;

    await clickSlicerItem("s1", "West", false);

    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(h.undo).toHaveBeenCalledWith("pA", [11, 12]);
  });

  it("a scripted selection (no user click) never asks", async () => {
    applyThatOverwrites();

    await updateSlicerSelectionAsync("s1", ["West"]);

    expect(h.confirm).not.toHaveBeenCalled();
  });

  it("the undo RECONCILE never asks and hands the bridge no tally", async () => {
    applyThatOverwrites();
    // An undo restored another selection on the backend.
    h.backend = [slicer("s1", { selectedItems: ["North"] })];

    const changed = await refreshCacheAndReapplyChangedFilters();

    expect(changed.map((s) => s.id)).toEqual(["s1"]);
    expect(h.apply).toHaveBeenCalledTimes(1);
    expect(h.apply.mock.calls[0][1]).toMatchObject({ masksOnly: true });
    expect((h.apply.mock.calls[0][1] as { overwrites?: unknown }).overwrites).toBeUndefined();
    expect(h.confirm).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// After a DECLINE: the store is back on the restored selection before any
// click reads it (fix round 5 review, finding 1)
// ---------------------------------------------------------------------------

const FOUR = ["East", "North", "West", "South"].map((value) => ({ value, selected: false, hasData: true }));

/** A selection with North in it grows a pivot over the user's cell. */
function northOverwrites(): void {
  let token = 100;
  h.apply.mockImplementation(async (s: Slicer, options?: { overwrites?: Tally }) => {
    if (s.selectedItems?.includes("North")) {
      options?.overwrites?.note({ pivotId: "pA", overwrittenCellCount: 1, overwriteToken: ++token });
    }
  });
}

/** The backend take-back: the click's whole step comes back (the selection
 *  before it), announcing `domains`. */
function takeBackRestores(selection: string[] | null, domains: string[]): void {
  h.undo.mockImplementation(async () => {
    h.backend = h.backend.map((s) => ({ ...s, selectedItems: selection }));
    return { stepsUndone: 1, complete: true, refreshDomains: domains };
  });
}

/** The Shell's fan-out, synchronous inside the announcement as the real one
 *  is: MUTATION_REFRESH "slicer" -> "slicers:refresh" -> the Slicer
 *  extension's handler -> refreshCacheAndReapplyChangedFilters(). */
const reconciles: Promise<unknown>[] = [];
function shellFanOut(): void {
  h.emit.mockImplementation((evt: string, payload?: { domains?: string[] }) => {
    if (evt === "app:mutation-refresh" && payload?.domains?.includes("slicer")) {
      reconciles.push(refreshCacheAndReapplyChangedFilters());
    }
  });
}

describe("a declined click, and the clicks after it", () => {
  beforeEach(() => {
    reconciles.length = 0;
    h.items = FOUR;
    northOverwrites();
    shellFanOut();
  });

  it("resolves only once the store shows the RESTORED selection (the re-read is an IPC round trip)", async () => {
    await refreshCache(); // the item list, for the Ctrl+click toggle
    h.ipcDelay = true;
    takeBackRestores(["East"], ["slicer", "pivot"]);

    await clickSlicerItem("s1", "North", true);

    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(getSlicerById("s1")?.selectedItems, "the declined click left the store on the DECLINED selection").toEqual(["East"]);
    // ...and the masks the step did not carry were re-derived from it.
    const remask = h.apply.mock.calls.find((c) => (c[1] as { masksOnly?: boolean } | undefined)?.masksOnly);
    expect((remask?.[0] as Slicer | undefined)?.selectedItems).toEqual(["East"]);
  });

  it("when the take-back started no reconcile (no slicer domain announced), the store runs one itself", async () => {
    await refreshCache();
    h.ipcDelay = true;
    takeBackRestores(["East"], ["pivot"]);

    await clickSlicerItem("s1", "North", true);

    expect(reconciles, "fixture: the fan-out ran a reconcile").toHaveLength(0);
    expect(getSlicerById("s1")?.selectedItems, "nothing brought the store back to the restored selection").toEqual(["East"]);
  });

  it("a click queued while an undo's reconcile is still re-reading is computed from what the undo restored", async () => {
    await refreshCache();
    h.ipcDelay = true;
    // An undo restored [East, South] on the backend; its reconcile is in flight.
    h.backend = [slicer("s1", { selectedItems: ["East", "South"] })];
    const undoReconcile = refreshCacheAndReapplyChangedFilters();

    await clickSlicerItem("s1", "West", true);
    await undoReconcile;

    expect(h.history, "the click toggled the cache the reconcile was replacing").toEqual([["East", "South", "West"]]);
  });

  it("a Ctrl+click queued behind a DECLINED click never re-applies the declined item, and is not asked about again", async () => {
    await refreshCache();
    h.ipcDelay = true;
    takeBackRestores(["East"], ["slicer", "pivot"]);

    // Ctrl+click North (asked, declined) and Ctrl+click West while the first
    // is still in flight, so the second is queued behind it.
    const first = clickSlicerItem("s1", "North", true);
    const second = clickSlicerItem("s1", "West", true);
    await Promise.all([first, second]);
    await Promise.all(reconciles);

    expect(h.history[1], "the queued click re-applied the item the user had just declined").toEqual(["East", "West"]);
    expect(h.confirm, "the user was asked AGAIN about the overwrite they had just declined").toHaveBeenCalledTimes(1);
    expect(getSlicerById("s1")?.selectedItems).toEqual(["East", "West"]);
  });
});
