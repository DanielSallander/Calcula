//! FILENAME: app/extensions/TimelineSlicer/lib/__tests__/timelineSelectionInScriptBatch.test.ts
// PURPOSE: A timeline selection made while ANOTHER caller's backend undo
//          transaction is open -- a script's `beginBatch` -- JOINS it and never
//          commits it half-way. `timeline.setSelection` runs
//          `updateTimelineSelectionAsync`, whose begin the backend answers
//          "joined" (W3); the gesture then committed anyway, closing the
//          script's batch after the selection, so the script's ONE batch became
//          two Ctrl+Z steps (review of wave C, WC-UNDO). Same for a user's click
//          during a scheduled script's batch.
//
//          Z3 (wave F): whether the click's step is its OWN -- the only step
//          it may ask about and offer to take back -- is decided by the click's
//          own BEGIN, never by a probe before it. The store asked
//          `isAnyUndoTransactionOpen()` and THEN began: a script batch opening
//          in between made the begin join the batch while the click believed
//          the step was its own (it asked), and a batch committing in between
//          made the begin open the click's own step while the click believed it
//          had joined (it never asked about the cells it overwrote).
//
//          Real @api/objectGeometry and real @api/pivotOverwrite; the backend
//          undo stack is a faithful fake of `begin_undo_transaction` (a TICKET
//          when it opens, null when it joins), `commit_undo_transaction` (with
//          a ticket: only the transaction that ticket names; without: whatever
//          is open) and `get_undo_state`.

import { describe, it, expect, vi, beforeEach } from "vitest";

const b = vi.hoisted(() => ({
  open: null as null | { label: string; writes: string[]; absorbed: boolean; ticket: number },
  nextTicket: 100,
  steps: [] as Array<{ label: string; writes: string[] }>,
  selection: { start: null as string | null, end: null as string | null },
  asked: 0,
  /** What each pivot apply reports it grew over. */
  overwrite: { overwrittenCellCount: 0 } as Record<string, unknown>,
  /** When set, every pivot apply waits for it (a slow model re-query). */
  hold: null as null | Promise<void>,
  /** Per-apply holds, taken in order (one per pivot apply) before `hold`. */
  holds: [] as Array<Promise<void>>,
  /** Every overwrite question asked, word for word. */
  questions: [] as string[],
  /** When set, the next commit that closes something waits for it first (a commit IPC in flight). */
  commitHold: null as null | Promise<void>,
  /** Commits that are waiting on `commitHold`. */
  commitsInFlight: 0,
  /**
   * Runs ONCE when the next begin reaches the backend, before it is decided:
   * what a script did in the window between the gesture's start and its begin
   * landing (every begin is an IPC round trip; a script runs meanwhile). It
   * may be async: the begin is decided when it settles.
   */
  beforeBegin: null as null | (() => void | Promise<void>),
  /** One-shot holds on the next begin with this label: that begin is decided only once it settles. */
  beginHolds: new Map<string, Promise<void>>(),
  record(what: string) {
    if (b.open) b.open.writes.push(what);
    else b.steps.push({ label: `own:${what}`, writes: [what] });
  },
}));

/** The script's own begin went through its own door: a ticket no gesture holds. */
const SCRIPT_TICKET = -1;

vi.mock("../../../../src/core/lib/tauri-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/core/lib/tauri-api")>()),
  getUndoState: async () => ({ undoSeqs: b.steps.map((_, i) => i + 1), transactionOpen: b.open !== null }),
  beginUndoTransaction: async (label: string) => {
    const slip = b.beforeBegin;
    b.beforeBegin = null;
    await slip?.();
    const heldBegin = b.beginHolds.get(label);
    if (heldBegin) {
      b.beginHolds.delete(label);
      await heldBegin;
    }
    if (b.open) {
      b.open.absorbed = true;
      return null;
    }
    const ticket = b.nextTicket++;
    b.open = { label, writes: [], absorbed: false, ticket };
    return ticket;
  },
  commitUndoTransaction: async (ticket?: number | null) => {
    const held = b.commitHold;
    if (held && b.open) {
      b.commitHold = null;
      b.commitsInFlight += 1;
      await held;
      b.commitsInFlight -= 1;
    }
    if (!b.open) return;
    if (ticket !== undefined && ticket !== null && b.open.ticket !== ticket) return;
    if (b.open.writes.length > 0) b.steps.push({ label: b.open.label, writes: b.open.writes });
    b.open = null;
  },
  cancelUndoTransaction: async (ticket?: number | null) => {
    if (!b.open) return;
    if (ticket !== undefined && ticket !== null && b.open.ticket !== ticket) return;
    b.open = null;
  },
}));
vi.mock("@api/gridOverlays", () => ({
  replaceGridRegionsByType: vi.fn(),
  removeGridRegionsByType: vi.fn(),
  requestOverlayRedraw: vi.fn(),
  getGridRegions: () => [],
}));
vi.mock("@api/state", () => ({ getGridStateSnapshot: () => ({ sheetContext: { activeSheetIndex: 0 } }) }));
vi.mock("@api/notifications", () => ({ showToast: vi.fn() }));
vi.mock("@api", () => ({ emitAppEvent: vi.fn(), AppEvents: { GRID_REFRESH: "app:grid-refresh" } }));
vi.mock("@api/dialogs", () => ({
  confirmAsync: (question: string) => {
    b.asked += 1;
    b.questions.push(question);
    return Promise.resolve(true);
  },
}));
vi.mock("@api/backend", () => ({
  getPivotHierarchies: async () => ({ hierarchies: [{ index: 3, name: "Date" }] }),
  applyPivotFilter: async (request: Record<string, unknown>) => {
    const held = b.holds.shift();
    if (held) await held;
    if (b.hold) await b.hold;
    b.record(`filter:${String(request.pivotId)}`);
    return { pivotId: request.pivotId, ...b.overwrite };
  },
  clearPivotFilter: async (request: Record<string, unknown>) => {
    b.record(`clear:${String(request.pivotId)}`);
    return { pivotId: request.pivotId, ...b.overwrite };
  },
  undoPivotOverwrite: vi.fn(),
}));
vi.mock("../timeline-slicer-api", () => ({
  updateTimelineSelection: async (p: { selectionStart: string | null; selectionEnd: string | null }) => {
    b.record("select");
    b.selection = { start: p.selectionStart, end: p.selectionEnd };
  },
  getTimelineSelectedItems: async () => (b.selection.start ? ["2026-01-05"] : null),
  getAllTimelineSlicers: async () => [
    {
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
      connectedPivotIds: ["p1"],
      selectionStart: b.selection.start,
      selectionEnd: b.selection.end,
      level: "months",
    },
  ],
  getTimelineData: async () => ({ periods: [] }),
}));

import { openUndoTransaction, runInUndoTransaction } from "@api/objectGeometry";
import {
  isTimelineGestureLanding,
  refreshCache,
  resetStore,
  updateTimelineSelectionAsync,
} from "../timelineSlicerStore";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A hold the test releases by hand. */
function gate(): { p: Promise<void>; release: () => void } {
  let release!: () => void;
  const p = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { p, release };
}

/** Steps recorded OUTSIDE every transaction (a write that split off its gesture's step). */
function strays(): Array<{ label: string; writes: string[] }> {
  return b.steps.filter((s) => s.label.startsWith("own:"));
}

/** What a script's `api.beginBatch` does: the Tauri begin, opened by the script. */
function scriptBeginsBatch(): void {
  b.open = { label: "Script batch", writes: [], absorbed: false, ticket: SCRIPT_TICKET };
}

/** What the script's `api.commitBatch` does. */
function scriptCommitsBatch(): void {
  if (b.open && b.open.writes.length > 0) b.steps.push({ label: b.open.label, writes: b.open.writes });
  b.open = null;
}

beforeEach(async () => {
  b.open = null;
  b.steps = [];
  b.selection = { start: null, end: null };
  b.asked = 0;
  b.overwrite = { overwrittenCellCount: 0 };
  b.hold = null;
  b.holds = [];
  b.questions = [];
  b.commitHold = null;
  b.commitsInFlight = 0;
  b.beforeBegin = null;
  b.beginHolds = new Map();
  resetStore();
  await refreshCache();
});

describe("a timeline selection inside another caller's open undo transaction", () => {
  it("a SCRIPT's timeline.setSelection inside beginBatch keeps the script's batch ONE step", async () => {
    scriptBeginsBatch();
    b.record("A1");
    await updateTimelineSelectionAsync("t1", "2026-01-01", "2026-01-31");
    expect(b.open, "the timeline selection COMMITTED the script's batch half-way").not.toBeNull();
    b.record("A2");
    scriptCommitsBatch();
    expect(b.steps).toEqual([{ label: "Script batch", writes: ["A1", "select", "filter:p1", "A2"] }]);
  });

  it("a USER's timeline click while a script's batch is open never closes that batch (and never asks)", async () => {
    b.overwrite = { overwrittenCellCount: 3, overwriteToken: 9 };
    scriptBeginsBatch();
    b.record("A1");
    await updateTimelineSelectionAsync("t1", "2026-01-01", "2026-01-31", { askBeforeOverwrite: true });
    expect(b.open, "the user's timeline click COMMITTED the script's open batch").not.toBeNull();
    expect(b.open?.writes).toEqual(["A1", "select", "filter:p1"]);
    expect(b.asked).toBe(0);
  });

  it("positive control: with nothing open the click is ONE step of its own", async () => {
    await updateTimelineSelectionAsync("t1", "2026-01-01", "2026-01-31", { askBeforeOverwrite: true });
    expect(b.open).toBeNull();
    expect(b.steps).toEqual([{ label: "Timeline Filter", writes: ["select", "filter:p1"] }]);
  });
});

describe("the click's OWN begin decides whether its step is its own (Z3: no probe before the begin)", () => {
  it("a script batch that OPENS before the click's begin lands: the begin joins it, so the click never asks", async () => {
    b.overwrite = { overwrittenCellCount: 3, overwriteToken: 9 };
    b.beforeBegin = () => {
      scriptBeginsBatch();
      b.record("A1");
    };

    await updateTimelineSelectionAsync("t1", "2026-01-01", "2026-01-31", { askBeforeOverwrite: true });

    expect(b.asked, "the click asked about a step that is the SCRIPT's batch (decided by a probe, not its begin)").toBe(0);
    expect(b.open?.label, "the click closed the script's batch").toBe("Script batch");
    expect(b.open?.writes).toEqual(["A1", "select", "filter:p1"]);
  });

  it("a script batch that COMMITS before the click's begin lands: the begin opens the click's own step, and the click asks", async () => {
    b.overwrite = { overwrittenCellCount: 3, overwriteToken: 9 };
    scriptBeginsBatch();
    b.record("A1");
    b.beforeBegin = () => scriptCommitsBatch();

    await updateTimelineSelectionAsync("t1", "2026-01-01", "2026-01-31", { askBeforeOverwrite: true });

    expect(b.asked, "the click never asked about the cells its OWN step overwrote (it believed it had joined)").toBe(1);
    expect(b.open).toBeNull();
    expect(b.steps).toEqual([
      { label: "Script batch", writes: ["A1"] },
      { label: "Timeline Filter", writes: ["select", "filter:p1"] },
    ]);
  });

  it("a click while a FRONTEND transaction is open joins it, tracked -- the opener's commit waits for the click -- and never asks", async () => {
    b.overwrite = { overwrittenCellCount: 3, overwriteToken: 9 };
    const drag = openUndoTransaction("Group drag");
    await drag.run(() => b.record("move"));
    let release!: () => void;
    b.hold = new Promise<void>((resolve) => {
      release = resolve;
    });

    const click = updateTimelineSelectionAsync("t1", "2026-01-01", "2026-01-31", { askBeforeOverwrite: true });
    await vi.waitFor(() => expect(b.open?.writes).toContain("select"));
    const committed = drag.commit();
    // Every chance for the drag's commit to land while the click's filter is
    // still held: a click that is not TRACKED lets it, and its filter then
    // lands as a step of its own.
    await new Promise((resolve) => setTimeout(resolve, 30));
    release();
    await click;
    await committed;

    expect(b.steps, "the drag committed before the click it holds had landed").toEqual([
      { label: "Group drag", writes: ["move", "select", "filter:p1"] },
    ]);
    expect(b.asked).toBe(0);
  });
});

// The review of Z3 (wave F). A click whose OWN begin opened its step is not a
// frontend transaction, so nothing else could see it: a second click (the UI
// fires one at mousedown and again at mouseup, neither awaited) or a chart
// move begun while it landed JOINED its step on the backend, and the click
// committed without waiting for them -- the rest of their writes landed as
// steps of their own. Before Z3 the click ran inside a frontend transaction
// and both were kept whole; they must still be.
describe("a gesture that starts while a timeline click's OWN step is landing is kept whole (review of Z3)", () => {
  it("a second timeline click joins the first click's step, and the first asks ONCE, counting both", async () => {
    b.overwrite = { overwrittenCellCount: 3, overwriteToken: 9 };
    const first = gate();
    const second = gate();
    b.holds = [first.p, second.p];

    const c1 = updateTimelineSelectionAsync("t1", "2026-01-01", "2026-01-31", { askBeforeOverwrite: true });
    await vi.waitFor(() => expect(b.open?.writes).toContain("select"));
    const c2 = updateTimelineSelectionAsync("t1", "2026-01-01", "2026-02-28", { askBeforeOverwrite: true });
    await vi.waitFor(() => expect(b.open?.writes.filter((w) => w === "select")).toHaveLength(2));
    first.release();
    // Every chance for the first click to commit while the second's filter is
    // still held: a click that does not wait for the one that joined it does.
    await sleep(30);
    second.release();
    await c1;
    await c2;

    expect(b.open).toBeNull();
    expect(strays(), "the second click's pivot filter landed OUTSIDE every step (its selection is inside the first click's)").toEqual([]);
    expect(b.steps).toEqual([{ label: "Timeline Filter", writes: ["select", "select", "filter:p1", "filter:p1"] }]);
    expect(b.asked, "a click that JOINED another click's step asked about it").toBe(1);
    expect(b.questions[0], "the question left out the cells the joined click overwrote in the same step").toContain(
      "6 cells",
    );
  });

  it("a second click made while the first click's BEGIN is still in flight joins that step too", async () => {
    b.overwrite = { overwrittenCellCount: 3, overwriteToken: 9 };
    const begin = gate();
    b.beginHolds = new Map([["Timeline Filter", begin.p]]);
    const first = gate();
    const second = gate();
    b.holds = [first.p, second.p];

    const c1 = updateTimelineSelectionAsync("t1", "2026-01-01", "2026-01-31", { askBeforeOverwrite: true });
    await sleep(5);
    const c2 = updateTimelineSelectionAsync("t1", "2026-01-01", "2026-02-28", { askBeforeOverwrite: true });
    await sleep(5);
    begin.release();
    await vi.waitFor(() => expect(b.open?.writes.filter((w) => w === "select")).toHaveLength(2));
    first.release();
    await sleep(30);
    second.release();
    await c1;
    await c2;

    expect(b.open).toBeNull();
    expect(strays(), "a click made during the other's begin landed part of itself outside every step").toEqual([]);
    expect(b.steps).toEqual([{ label: "Timeline Filter", writes: ["select", "select", "filter:p1", "filter:p1"] }]);
    expect(b.asked).toBe(1);
  });

  it("a chart move (runInUndoTransaction) begun while the click's step lands stays whole in that step", async () => {
    b.overwrite = { overwrittenCellCount: 3, overwriteToken: 9 };
    const filter = gate();
    const move = gate();
    b.holds = [filter.p];

    const click = updateTimelineSelectionAsync("t1", "2026-01-01", "2026-01-31", { askBeforeOverwrite: true });
    await vi.waitFor(() => expect(b.open?.writes).toContain("select"));
    const chart = runInUndoTransaction("Move chart", async () => {
      b.record("move1");
      await move.p;
      b.record("move2");
    });
    await vi.waitFor(() => expect(b.open?.writes).toContain("move1"));
    filter.release();
    // Every chance for the click to commit while the move is half done.
    await sleep(30);
    move.release();
    await click;
    await chart;

    expect(b.open).toBeNull();
    expect(strays(), "the chart move was split: part in the click's step, the rest outside every step").toEqual([]);
    expect(b.steps).toEqual([{ label: "Timeline Filter", writes: ["select", "move1", "filter:p1", "move2"] }]);
  });

  it("a chart move begun while the click's BEGIN is in flight, whose begin lands second, stays whole in the click's step", async () => {
    b.overwrite = { overwrittenCellCount: 3, overwriteToken: 9 };
    const filter = gate();
    const move = gate();
    const chartBegin = gate();
    b.holds = [filter.p];
    b.beginHolds = new Map([["Move chart", chartBegin.p]]);
    let chart: Promise<void> = Promise.resolve();
    b.beforeBegin = () => {
      chart = runInUndoTransaction("Move chart", async () => {
        b.record("move1");
        await move.p;
        b.record("move2");
      });
    };

    const click = updateTimelineSelectionAsync("t1", "2026-01-01", "2026-01-31", { askBeforeOverwrite: true });
    await vi.waitFor(() => expect(b.open?.label).toBe("Timeline Filter"));
    chartBegin.release();
    await vi.waitFor(() => expect(b.open?.writes).toEqual(expect.arrayContaining(["select", "move1"])));
    filter.release();
    await sleep(30);
    move.release();
    await click;
    await chart;

    expect(b.open).toBeNull();
    expect(strays(), "the chart move was split off the click's step").toEqual([]);
    expect(b.steps).toHaveLength(1);
    expect(b.steps[0].label).toBe("Timeline Filter");
    expect([...b.steps[0].writes].sort()).toEqual(["filter:p1", "move1", "move2", "select"]);
  });

  it("a chart move whose begin lands FIRST while the click's begin is in flight tracks the click: its commit waits for it", async () => {
    b.overwrite = { overwrittenCellCount: 3, overwriteToken: 9 };
    const filter = gate();
    const move = gate();
    b.holds = [filter.p];
    let chart: Promise<void> = Promise.resolve();
    b.beforeBegin = async () => {
      chart = runInUndoTransaction("Move chart", async () => {
        b.record("move1");
        await move.p;
        b.record("move2");
      });
      await vi.waitFor(() => expect(b.open?.writes).toContain("move1"));
    };

    const click = updateTimelineSelectionAsync("t1", "2026-01-01", "2026-01-31", { askBeforeOverwrite: true });
    await vi.waitFor(() => expect(b.open?.writes).toContain("select"));
    // The chart finishes FIRST: its commit must wait for the click it holds.
    move.release();
    await sleep(30);
    filter.release();
    await click;
    await chart;

    expect(b.open).toBeNull();
    expect(strays(), "the chart committed before the click inside its step had landed").toEqual([]);
    expect(b.steps).toEqual([{ label: "Move chart", writes: ["move1", "select", "move2", "filter:p1"] }]);
    expect(b.asked, "the click asked about the chart's step (its begin JOINED it)").toBe(0);
  });

  it("a click made while the previous click's COMMIT is in flight opens a step of its OWN once that landed, and asks", async () => {
    b.overwrite = { overwrittenCellCount: 3, overwriteToken: 9 };
    const commit = gate();
    b.commitHold = commit.p;

    const c1 = updateTimelineSelectionAsync("t1", "2026-01-01", "2026-01-31", { askBeforeOverwrite: true });
    await vi.waitFor(() => expect(b.commitsInFlight).toBe(1));
    const c2 = updateTimelineSelectionAsync("t1", "2026-02-01", "2026-02-28", { askBeforeOverwrite: true });
    // Every chance for the second click to begin while the first's commit is in flight.
    await sleep(30);
    commit.release();
    await c1;
    await c2;

    expect(b.open).toBeNull();
    expect(strays()).toEqual([]);
    expect(b.steps, "the second click joined a step that was already committing").toEqual([
      { label: "Timeline Filter", writes: ["select", "filter:p1"] },
      { label: "Timeline Filter", writes: ["select", "filter:p1"] },
    ]);
    expect(b.asked, "the second click never asked about its own step").toBe(2);
  });

  it("reads as LANDING until every write of its step has landed (the keyboard refuses Ctrl+Z meanwhile)", async () => {
    const filter = gate();
    const move = gate();
    b.holds = [filter.p];
    const click = updateTimelineSelectionAsync("t1", "2026-01-01", "2026-01-31", { askBeforeOverwrite: true });
    await vi.waitFor(() => expect(b.open?.writes).toContain("select"));
    const chart = runInUndoTransaction("Move chart", async () => {
      b.record("move1");
      await move.p;
      b.record("move2");
    });
    await vi.waitFor(() => expect(b.open?.writes).toContain("move1"));
    filter.release();
    await sleep(30);
    expect(isTimelineGestureLanding(), "the click's step is still open (the move joined it), yet reads as landed").toBe(true);
    move.release();
    await click;
    await chart;
    expect(isTimelineGestureLanding()).toBe(false);
  });
});
