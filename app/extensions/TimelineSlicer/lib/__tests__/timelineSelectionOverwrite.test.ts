//! FILENAME: app/extensions/TimelineSlicer/lib/__tests__/timelineSelectionOverwrite.test.ts
// PURPOSE: S2 (BUG-0200): "the TimelineSlicer transaction and overwrite
//          prompt". A timeline selection's filter used to be applied by a
//          fire-and-forget listener: outside every undo step, one step per
//          pivot that grew over the user's cells, and never asked about. The
//          selection change now applies its filter itself as ONE step, asks
//          ONCE (Tauri-shaped `confirmAsync` double, FAILING CLOSED), and a
//          decline takes back the gesture's ONE step by its overwrite token.
//
//          W1 (wave C): the selection is written INSIDE the gesture's
//          transaction -- the backend's `update_timeline_selection` joins it
//          now instead of committing a step of its own -- so the one step
//          holds the selection AND its pivots, and the decline no longer
//          names a second step by its history id (`thenUndoSeq`).

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  order: [] as string[],
  txDepth: 0,
  /** The transaction depth each selection write ran at. */
  selectDepths: [] as number[],
  confirm: vi.fn((..._a: unknown[]): Promise<boolean> => Promise.resolve(false)),
  undo: vi.fn((..._a: unknown[]) => Promise.resolve({ stepsUndone: 2, complete: true, refreshDomains: ["slicer"] })),
  /** What each pivot apply reports it grew over. */
  overwrite: { overwrittenCellCount: 0 } as Record<string, unknown>,
  requests: [] as Array<Record<string, unknown>>,
  selection: { start: null as string | null, end: null as string | null },
  toast: vi.fn(),
  /** When set, every pivot apply waits for it (a slow model re-query). */
  hold: null as null | Promise<void>,
}));

// The gesture's ONE step is opened by its own begin and closed with the ticket
// that begin answered (Z3): the backend doors are doubled here, and `txDepth`
// is the backend transaction they hold open.
vi.mock("../../../../src/core/lib/tauri-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/core/lib/tauri-api")>()),
  getUndoState: async () => ({ undoSeqs: [], transactionOpen: h.txDepth > 0 }),
  beginUndoTransaction: async () => {
    if (h.txDepth > 0) return null;
    h.txDepth++;
    return 41_000;
  },
  commitUndoTransaction: async (ticket?: number | null) => {
    if (h.txDepth > 0 && ticket === 41_000) {
      h.txDepth--;
      h.order.push("commit");
    }
  },
  cancelUndoTransaction: async (ticket?: number | null) => {
    if (h.txDepth > 0 && ticket === 41_000) h.txDepth--;
  },
}));
vi.mock("@api/gridOverlays", () => ({
  replaceGridRegionsByType: vi.fn(),
  removeGridRegionsByType: vi.fn(),
  requestOverlayRedraw: vi.fn(),
}));
vi.mock("@api/state", () => ({ getGridStateSnapshot: () => ({ sheetContext: { activeSheetIndex: 0 } }) }));
vi.mock("@api/notifications", () => ({ showToast: (...a: unknown[]) => h.toast(...a) }));
vi.mock("@api", () => ({ emitAppEvent: vi.fn(), AppEvents: { GRID_REFRESH: "app:grid-refresh" } }));
vi.mock("@api/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitAppEvent: vi.fn(),
}));
vi.mock("@api/dialogs", () => ({
  confirmAsync: (...a: unknown[]) => {
    h.order.push("ask");
    return h.confirm(...a);
  },
}));
vi.mock("@api/objectGeometry", () => ({
  // No FRONTEND transaction is open in these tests: the selection opens its
  // step through the backend door above.
  isUndoTransactionOpen: () => false,
  joinUndoTransaction: (fn: () => Promise<unknown>) => fn(),
  undoCommitsSettled: () => Promise.resolve(),
  runInUndoTransaction: async (_label: string, fn: () => Promise<unknown>) => {
    h.txDepth++;
    try {
      return await fn();
    } finally {
      h.txDepth--;
      h.order.push("commit");
    }
  },
}));
vi.mock("@api/backend", () => ({
  getPivotHierarchies: async () => ({ hierarchies: [{ index: 3, name: "Date" }] }),
  applyPivotFilter: async (request: Record<string, unknown>) => {
    if (h.hold) await h.hold;
    h.order.push("filter");
    h.requests.push(request);
    return { pivotId: request.pivotId, ...h.overwrite };
  },
  clearPivotFilter: async (request: Record<string, unknown>) => {
    h.order.push("filter");
    h.requests.push(request);
    return { pivotId: request.pivotId, ...h.overwrite };
  },
  undoPivotOverwrite: (...a: unknown[]) => h.undo(...a),
}));
vi.mock("../timeline-slicer-api", () => ({
  updateTimelineSelection: async (p: { selectionStart: string | null; selectionEnd: string | null }) => {
    h.order.push("select");
    h.selectDepths.push(h.txDepth);
    h.selection = { start: p.selectionStart, end: p.selectionEnd };
  },
  getTimelineSelectedItems: async () => (h.selection.start ? ["2026-01-05"] : null),
  getAllTimelineSlicers: async () => [timeline(h.selection.start, h.selection.end)],
  getTimelineData: async () => ({ periods: [] }),
}));

import {
  isTimelineGestureLanding,
  refreshCache,
  refreshCacheAndReconcile,
  resetStore,
  updateTimelineSelectionAsync,
} from "../timelineSlicerStore";

function timeline(start: string | null, end: string | null) {
  return {
    id: "t1",
    name: "Date",
    sheetIndex: 0,
    x: 0,
    y: 0,
    width: 300,
    height: 120,
    sourceType: "pivot",
    sourceId: "p1",
    fieldName: "Date",
    connectedPivotIds: ["p1", "p2"],
    selectionStart: start,
    selectionEnd: end,
    level: "months",
  };
}

beforeEach(async () => {
  h.order.length = 0;
  h.txDepth = 0;
  h.selectDepths.length = 0;
  h.hold = null;
  h.requests.length = 0;
  h.overwrite = { overwrittenCellCount: 0 };
  h.selection = { start: null, end: null };
  h.confirm.mockReset().mockImplementation(() => Promise.resolve(false));
  h.toast.mockReset();
  // The take-back puts back what the ONE step held: the selection with its
  // pivots, whenever the step carrying the token is taken back.
  h.undo.mockReset().mockImplementation((...a: unknown[]) => {
    if (Array.isArray(a[1]) && (a[1] as number[]).includes(41)) h.selection = { start: null, end: null };
    return Promise.resolve({ stepsUndone: 1, complete: true, refreshDomains: ["slicer"] });
  });
  await refreshCache();
  h.order.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("a timeline selection is one gesture with its filter", () => {
  it("applies its filter itself, in ONE step WITH the selection, and asks ONCE naming every cell", async () => {
    h.overwrite = { overwrittenCellCount: 2, overwriteToken: 41 };
    h.confirm.mockImplementation(() => Promise.resolve(true));

    await updateTimelineSelectionAsync("t1", "2026-01-01", "2026-01-31", { askBeforeOverwrite: true });

    expect(h.order).toEqual(["select", "filter", "filter", "commit", "ask"]);
    expect(h.selectDepths, "the selection was written outside the gesture's one step (W1)").toEqual([1]);
    expect(h.confirm.mock.calls[0][0]).toContain("4 cells");
  });

  it("a decline takes back the ONE step by its token (the selection with it), then re-derives quietly", async () => {
    h.overwrite = { overwrittenCellCount: 2, overwriteToken: 41 };

    await updateTimelineSelectionAsync("t1", "2026-01-01", "2026-01-31", { askBeforeOverwrite: true });

    expect(h.undo).toHaveBeenCalledTimes(1);
    expect(h.undo.mock.calls[0][1]).toEqual([41]);
    expect(h.undo.mock.calls[0][2], "the decline still names a separate selection step (thenUndoSeq)").toBeFalsy();
    // The re-derive after the take-back records nothing.
    const quiet = h.requests.slice(2);
    expect(quiet.length).toBeGreaterThan(0);
    for (const r of quiet) expect(r.reconcile).toBe(true);
    // ... re-derived from the RESTORED range (no filter), never the declined one.
    for (const r of quiet) expect((r as { filters?: unknown }).filters).toBeUndefined();
    expect(h.toast).not.toHaveBeenCalled();
  });

  it("a decline whose take-back left the DECLINED selection re-applies NOTHING and says so (the review of S2)", async () => {
    h.overwrite = { overwrittenCellCount: 2, overwriteToken: 41 };
    // The take-back landed, yet the backend still holds the DECLINED
    // selection (something else re-selected it in between).
    h.undo.mockImplementation(() => Promise.resolve({ stepsUndone: 1, complete: true, refreshDomains: ["pivot"] }));

    await updateTimelineSelectionAsync("t1", "2026-01-01", "2026-01-31", { askBeforeOverwrite: true });

    expect(h.undo, "fixture: the decline took back the step").toHaveBeenCalledTimes(1);
    const quiet = h.requests.filter((r) => r.reconcile === true);
    expect(quiet, "the declined selection was re-applied, recording nothing, over the restored cells").toHaveLength(0);
    expect(h.toast, "the user was not told the selection stayed").toHaveBeenCalledTimes(1);
  });

  it("a scripted selection (no user gesture) applies its filter but never asks", async () => {
    h.overwrite = { overwrittenCellCount: 2, overwriteToken: 41 };

    await updateTimelineSelectionAsync("t1", "2026-01-01", "2026-01-31");

    expect(h.order).toEqual(["select", "filter", "filter", "commit"]);
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it("reads as LANDING while its filter is applied, so the keyboard's Ctrl+Z says why it is refused (W4)", async () => {
    let release!: () => void;
    h.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    expect(isTimelineGestureLanding(), "fixture: nothing lands yet").toBe(false);
    const selection = updateTimelineSelectionAsync("t1", "2026-01-01", "2026-01-31", { askBeforeOverwrite: true });
    // The gesture is in flight: its selection is written, its filter waits.
    await vi.waitFor(() => expect(h.order).toContain("select"));
    expect(isTimelineGestureLanding(), "a timeline selection in flight does not read as landing").toBe(true);
    release();
    await selection;
    expect(isTimelineGestureLanding(), "the selection landed and still reads as landing").toBe(false);
  });

  it("a selection that overwrote nothing asks nothing", async () => {
    await updateTimelineSelectionAsync("t1", "2026-01-01", "2026-01-31", { askBeforeOverwrite: true });
    expect(h.confirm).not.toHaveBeenCalled();
  });
});

describe("an undo or redo of a timeline selection re-derives its pivots' masks (new defect, wave C)", () => {
  it("re-applies the RESTORED range quietly, once, and again on redo", async () => {
    resetStore();
    await refreshCache();
    await updateTimelineSelectionAsync("t1", "2026-01-01", "2026-01-31", { askBeforeOverwrite: true });
    h.requests.length = 0;

    // Ctrl+Z restored the timeline's previous (empty) range on the backend;
    // its pivots still show January -- a level-1 mask records no undo.
    h.selection = { start: null, end: null };
    await refreshCacheAndReconcile();
    expect(h.requests.length, "the undo left the pivots filtered by the range it undid").toBe(2);
    for (const r of h.requests) {
      expect(r.reconcile, "the re-derive recorded a step (it would wipe the redo)").toBe(true);
      expect((r as { filters?: unknown }).filters, "re-derived from the UNDONE range").toBeUndefined();
    }

    // Nothing moved since: a second refresh re-applies nothing.
    h.requests.length = 0;
    await refreshCacheAndReconcile();
    expect(h.requests, "an unchanged timeline was re-applied").toEqual([]);

    // Ctrl+Y: January is back, and so are its masks.
    h.selection = { start: "2026-01-01", end: "2026-01-31" };
    await refreshCacheAndReconcile();
    expect(h.requests.length).toBe(2);
    for (const r of h.requests) {
      expect(r.reconcile).toBe(true);
      expect((r as { filters?: unknown }).filters, "the redo's masks were not re-derived").toBeDefined();
    }
  });

  it("reconciles nothing while a timeline gesture is landing (the gesture applies its own filter)", async () => {
    resetStore();
    await refreshCache();
    let release!: () => void;
    h.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const selection = updateTimelineSelectionAsync("t1", "2026-01-01", "2026-01-31", { askBeforeOverwrite: true });
    await vi.waitFor(() => expect(h.order).toContain("select"));
    const before = h.requests.length;
    const reconcile = refreshCacheAndReconcile();
    release();
    await reconcile;
    await selection;
    expect(h.requests.filter((r) => r.reconcile === true), "a reconcile raced the landing gesture").toEqual([]);
    expect(h.requests.length - before).toBe(2);
  });
});
