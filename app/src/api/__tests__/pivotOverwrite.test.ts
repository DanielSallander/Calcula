//! FILENAME: app/src/api/__tests__/pivotOverwrite.test.ts
// PURPOSE: The ONE "a PivotTable report will overwrite existing data" decision
//          (`@api/pivotOverwrite`): asked once for a gesture, naming how many
//          cells; a dialog that cannot be shown is a DECLINE; a decline hands
//          the backend EXACTLY the gesture's overwrite tokens (and the one step
//          the caller proved its own), never "whatever is on top"; with no
//          token it takes nothing back and says so.
//
// The dialog double has the Tauri shape: `confirmAsync` returns a Promise
// (and, for the fail-closed case, a REJECTED one).

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  confirm: vi.fn((..._a: unknown[]) => Promise.resolve(false)),
  undo: vi.fn((..._a: unknown[]) =>
    Promise.resolve({ stepsUndone: 1, complete: true, refreshDomains: ["pivot", "slicer"] }),
  ),
  emit: vi.fn(),
  toast: vi.fn(),
  undoState: vi.fn((): Promise<unknown> => Promise.resolve({ undoSeqs: [], transactionOpen: false })),
  /** The FRONTEND's own transaction flag (`isUndoTransactionOpen`). */
  frontendOpen: false,
  /** What happened, in order: "open", "body", "commit", "ask". */
  order: [] as string[],
}));

vi.mock("../dialogs", () => ({ confirmAsync: (...a: unknown[]) => h.confirm(...a) }));
vi.mock("../backend", () => ({ undoPivotOverwrite: (...a: unknown[]) => h.undo(...a) }));
vi.mock("../events", () => ({
  emitAppEvent: (...a: unknown[]) => h.emit(...a),
  AppEvents: { MUTATION_REFRESH: "app:mutation-refresh", GRID_REFRESH: "app:grid-refresh" },
}));
vi.mock("../notifications", () => ({ showToast: (...a: unknown[]) => h.toast(...a) }));
vi.mock("../../core/lib/tauri-api", () => ({ getUndoState: () => h.undoState() }));
vi.mock("../objectGeometry", () => ({
  isUndoTransactionOpen: () => h.frontendOpen,
  runInUndoTransaction: async (_label: string, fn: () => Promise<unknown>) => {
    h.order.push("open");
    try {
      return await fn();
    } finally {
      h.order.push("commit");
    }
  },
}));

import {
  confirmPivotOverwriteOrUndo,
  createPivotOverwriteTally,
  isAnyUndoTransactionOpen,
  pivotOverwriteQuestion,
  runNamingItsUndoStep,
  runStepThenConfirmOverwrite,
  undoStepPushedBetween,
  PIVOT_OVERWRITE_NOT_TAKEN_BACK,
} from "../pivotOverwrite";
import type { PivotViewResponse } from "../pivotTypes";

const response = (pivotId: string, overwrittenCellCount: number, overwriteToken?: number) =>
  ({ pivotId, version: 1, rowCount: 1, colCount: 1, rows: [], overwrittenCellCount, overwriteToken }) as unknown as PivotViewResponse;

beforeEach(() => {
  h.confirm.mockReset().mockImplementation(() => Promise.resolve(false));
  h.undo.mockReset().mockImplementation(() =>
    Promise.resolve({ stepsUndone: 1, complete: true, refreshDomains: ["pivot", "slicer"] }),
  );
  h.emit.mockClear();
  h.toast.mockClear();
  h.undoState.mockReset().mockImplementation(() => Promise.resolve({ undoSeqs: [], transactionOpen: false }));
  h.frontendOpen = false;
  h.order.length = 0;
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

// Fix round 5 review, finding 3: a script's `api.beginBatch` opens a
// transaction on the BACKEND directly, which the frontend flag never sees. A
// slicer click then "opened" its step inside the script's batch (the backend's
// begin is a no-op while one is open), its commit closed the batch, and its
// decline took back the SCRIPT's writes with the click's.
describe("is an undo transaction open anywhere", () => {
  it("a BACKEND transaction the frontend flag cannot see (a script batch) counts as open", async () => {
    h.undoState.mockImplementation(() => Promise.resolve({ undoSeqs: [], transactionOpen: true }));
    await expect(isAnyUndoTransactionOpen()).resolves.toBe(true);
  });

  it("the frontend's own open transaction counts as open", async () => {
    h.frontendOpen = true;
    await expect(isAnyUndoTransactionOpen()).resolves.toBe(true);
  });

  it("closed on both sides is closed", async () => {
    await expect(isAnyUndoTransactionOpen()).resolves.toBe(false);
  });

  it("a backend state that cannot be read counts as OPEN (a step not provably the gesture's own is never offered back)", async () => {
    h.undoState.mockImplementation(() => Promise.reject(new Error("no backend")));
    await expect(isAnyUndoTransactionOpen()).resolves.toBe(true);
  });
});

describe("one gesture as one step, asked about once it committed", () => {
  const overwriting = async (t: { note(r: PivotViewResponse): void }) => {
    h.order.push("body");
    t.note(response("pA", 2, 21));
    return "result";
  };

  it("runs the body inside ONE step, then asks after the commit; a decline takes back its tokens", async () => {
    h.confirm.mockImplementation(() => {
      h.order.push("ask");
      return Promise.resolve(false);
    });
    const { result, outcome } = await runStepThenConfirmOverwrite("Slicer Settings", overwriting);
    expect(result).toBe("result");
    expect(outcome).toBe("undone");
    expect(h.order).toEqual(["open", "body", "commit", "ask"]);
    expect(h.undo).toHaveBeenCalledWith("pA", [21], undefined);
  });

  it("a gesture that JOINS a script's backend batch never asks and takes nothing back", async () => {
    h.undoState.mockImplementation(() => Promise.resolve({ undoSeqs: [], transactionOpen: true }));
    const { outcome } = await runStepThenConfirmOverwrite("Slicer Selection", overwriting);
    expect(outcome).toBe("joined");
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.undo).not.toHaveBeenCalled();
  });

  it("a gesture inside the frontend's own open transaction never asks either", async () => {
    h.frontendOpen = true;
    const { outcome } = await runStepThenConfirmOverwrite("Slicer Connections", overwriting);
    expect(outcome).toBe("joined");
    expect(h.confirm).not.toHaveBeenCalled();
  });
});

describe("the tally of one gesture", () => {
  it("adds up every pivot's cells, keeps each token once, and ignores what overwrote nothing", () => {
    const t = createPivotOverwriteTally();
    t.note(response("pA", 2, 11));
    t.note(response("pB", 0));
    t.note(undefined);
    t.note(response("pC", 3, 12));
    t.note(response("pA", 1, 11));
    expect(t.cellCount).toBe(6);
    expect(t.pivotIds).toEqual(["pA", "pC"]);
    expect(t.tokens).toEqual([11, 12]);
    expect(t.unrecorded).toBe(false);
    t.note(response("pD", 4));
    expect(t.unrecorded).toBe(true);
  });
});

describe("confirmPivotOverwriteOrUndo", () => {
  it("asks nothing when nothing was overwritten", async () => {
    await expect(confirmPivotOverwriteOrUndo(createPivotOverwriteTally())).resolves.toBe("none");
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.undo).not.toHaveBeenCalled();
  });

  it("asks ONCE for the whole gesture, naming how many cells; OK keeps it", async () => {
    h.confirm.mockImplementation(() => Promise.resolve(true));
    const t = createPivotOverwriteTally();
    t.note(response("pA", 2, 11));
    t.note(response("pB", 3, 12));
    await expect(confirmPivotOverwriteOrUndo(t)).resolves.toBe("kept");
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(h.confirm.mock.calls[0][0]).toBe(pivotOverwriteQuestion(5));
    expect(h.confirm.mock.calls[0][0]).toContain("5 cells");
    expect(h.undo).not.toHaveBeenCalled();
  });

  it("a decline hands the backend exactly the gesture's tokens (and the named step), then announces what came back", async () => {
    const t = createPivotOverwriteTally();
    t.note(response("pA", 2, 11));
    t.note(response("pB", 3, 12));
    await expect(confirmPivotOverwriteOrUndo(t, { thenUndoSeq: 77 })).resolves.toBe("undone");
    expect(h.undo).toHaveBeenCalledTimes(1);
    expect(h.undo).toHaveBeenCalledWith("pA", [11, 12], 77);
    const refresh = h.emit.mock.calls.find((c) => c[0] === "app:mutation-refresh");
    expect(refresh?.[1]).toMatchObject({ source: "undo" });
    expect((refresh?.[1] as { domains: string[] }).domains).toEqual(expect.arrayContaining(["pivot", "slicer"]));
  });

  it("FAILS CLOSED: a dialog that cannot be shown (a rejected confirm) is a decline", async () => {
    h.confirm.mockImplementation(() => Promise.reject(new Error("no dialog")));
    const t = createPivotOverwriteTally();
    t.note(response("pA", 2, 11));
    await expect(confirmPivotOverwriteOrUndo(t)).resolves.toBe("undone");
    expect(h.undo).toHaveBeenCalledWith("pA", [11], undefined);
  });

  it("with NO token it takes nothing back -- never 'whatever is on top' -- and says so", async () => {
    const t = createPivotOverwriteTally();
    t.note(response("pA", 2));
    await expect(confirmPivotOverwriteOrUndo(t)).resolves.toBe("refused");
    expect(h.undo).not.toHaveBeenCalled();
    expect(h.toast).toHaveBeenCalledWith(PIVOT_OVERWRITE_NOT_TAKEN_BACK, expect.objectContaining({ type: "error" }));
  });

  it("a backend refusal (the step is no longer on top) is told, not swallowed", async () => {
    h.undo.mockImplementation(() => Promise.reject("no longer the last change"));
    const t = createPivotOverwriteTally();
    t.note(response("pA", 2, 11));
    await expect(confirmPivotOverwriteOrUndo(t)).resolves.toBe("refused");
    expect(h.toast).toHaveBeenCalledWith(PIVOT_OVERWRITE_NOT_TAKEN_BACK, expect.objectContaining({ type: "error" }));
    expect(h.emit).not.toHaveBeenCalled();
  });
});

describe("naming the one step a write pushed", () => {
  it("names the new top only when exactly one entry appeared on the old top", () => {
    expect(undoStepPushedBetween([1, 2], [1, 2, 3])).toBe(3);
    expect(undoStepPushedBetween([], [5])).toBe(5);
    // At the history cap the oldest entry drops: still exactly one new entry.
    expect(undoStepPushedBetween([1, 2, 3], [2, 3, 4])).toBe(4);
    // Two entries (someone else's landed too), nothing new, a cleared history.
    expect(undoStepPushedBetween([1, 2], [1, 2, 3, 4])).toBeNull();
    expect(undoStepPushedBetween([1, 2], [1, 2])).toBeNull();
    expect(undoStepPushedBetween([1, 2], [])).toBeNull();
    expect(undoStepPushedBetween([1, 2], [9])).toBeNull();
  });

  it("names the write's step from the history before and after it", async () => {
    const states = [
      { undoSeqs: [4], transactionOpen: false },
      { undoSeqs: [4, 5], transactionOpen: false },
    ];
    h.undoState.mockImplementation(() => Promise.resolve(states.shift()));
    const write = vi.fn(() => Promise.resolve("done"));
    await expect(runNamingItsUndoStep(write)).resolves.toEqual({ result: "done", seq: 5 });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("names nothing while a transaction is open (the write joins someone else's step)", async () => {
    const states = [
      { undoSeqs: [4], transactionOpen: true },
      { undoSeqs: [4, 5], transactionOpen: false },
    ];
    h.undoState.mockImplementation(() => Promise.resolve(states.shift()));
    await expect(runNamingItsUndoStep(() => Promise.resolve(1))).resolves.toEqual({ result: 1, seq: null });
  });

  it("names nothing when the history cannot be read, and still runs the write", async () => {
    h.undoState.mockImplementation(() => Promise.reject(new Error("no backend")));
    const write = vi.fn(() => Promise.resolve(2));
    await expect(runNamingItsUndoStep(write)).resolves.toEqual({ result: 2, seq: null });
    expect(write).toHaveBeenCalledTimes(1);
  });
});
