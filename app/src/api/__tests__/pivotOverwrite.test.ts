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
  /** What the step's backend BEGIN answers: true = it opened the transaction. */
  beginOpens: true,
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
  undoCommitsSettled: () => Promise.resolve(),
  // The handle's shape: a joined handle (the frontend's own transaction is
  // open) never opened; otherwise the BEGIN's answer decides.
  openUndoTransaction: (_label: string) => {
    h.order.push("open");
    const joined = h.frontendOpen;
    return {
      joined,
      run: async (fn: () => Promise<unknown>) => fn(),
      commit: async () => {
        h.order.push("commit");
      },
      openedBackend: async () => !joined && h.beginOpens,
    };
  },
}));

import {
  confirmPivotOverwriteOrUndo,
  createPivotOverwriteTally,
  isAnyUndoTransactionOpen,
  pivotOverwriteQuestion,
  runStepThenConfirmOverwrite,
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
  h.beginOpens = true;
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
    expect(h.undo).toHaveBeenCalledWith("pA", [21]);
  });

  it("a gesture that JOINS a script's backend batch never asks and takes nothing back", async () => {
    h.beginOpens = false;
    const { outcome } = await runStepThenConfirmOverwrite("Slicer Selection", overwriting);
    expect(outcome).toBe("joined");
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.undo).not.toHaveBeenCalled();
  });

  // The Z3 race (wave F backlog B5): a probe taken BEFORE the begin said
  // "nothing open", a script's batch opened in between, and the begin JOINED
  // it -- the gesture was still asked, and a decline took the script's writes
  // back with its own. The begin's own answer decides now.
  it("a begin that JOINS a batch opened after any earlier probe is joined: never asked", async () => {
    h.undoState.mockImplementation(() => Promise.resolve({ undoSeqs: [], transactionOpen: false }));
    h.beginOpens = false;
    const { outcome } = await runStepThenConfirmOverwrite("Slicer Settings", overwriting);
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

  it("a decline hands the backend exactly the gesture's tokens -- and names no other step -- then announces what came back", async () => {
    const t = createPivotOverwriteTally();
    t.note(response("pA", 2, 11));
    t.note(response("pB", 3, 12));
    await expect(confirmPivotOverwriteOrUndo(t)).resolves.toBe("undone");
    expect(h.undo).toHaveBeenCalledTimes(1);
    expect(h.undo.mock.calls[0]).toEqual(["pA", [11, 12]]);
    const refresh = h.emit.mock.calls.find((c) => c[0] === "app:mutation-refresh");
    expect(refresh?.[1]).toMatchObject({ source: "undo" });
    expect((refresh?.[1] as { domains: string[] }).domains).toEqual(expect.arrayContaining(["pivot", "slicer"]));
  });

  it("FAILS CLOSED: a dialog that cannot be shown (a rejected confirm) is a decline", async () => {
    h.confirm.mockImplementation(() => Promise.reject(new Error("no dialog")));
    const t = createPivotOverwriteTally();
    t.note(response("pA", 2, 11));
    await expect(confirmPivotOverwriteOrUndo(t)).resolves.toBe("undone");
    expect(h.undo.mock.calls[0]).toEqual(["pA", [11]]);
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
