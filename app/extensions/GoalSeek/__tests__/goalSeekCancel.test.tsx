//! FILENAME: app/extensions/GoalSeek/__tests__/goalSeekCancel.test.tsx
// PURPOSE: The Goal Seek status dialog's Cancel puts the changing cell back
//          EXACTLY as it was, through the backend: `cancelGoalSeek(undoSeq)`
//          takes the run's OWN undo step off the history by its id, so a text
//          or empty changing cell comes back as itself AND no redo step is
//          left behind (Excel [LIVE]: after Cancel, Undo and Redo are both
//          disabled). Round 12 replaced the scoped `undo(undoSeq)`, which moved
//          the step onto the redo stack so Ctrl+Y re-applied the result; the
//          backend half is whatif_recalc_tests.rs
//          `goal_seek_cancel_takes_the_run_back_and_leaves_nothing_to_redo`.
// CONTEXT: Round-10 fix lane "misc" (2026-10-30). Cancel used to retype
//          `originalVariableValue` -- a NUMBER, 0 for anything that was not a
//          number -- through updateCellsBatch, so "n/a" or an empty cell came
//          back as 0. The backend half (goal_seek records the step and hands
//          back its id) is pinned by whatif_recalc_tests.rs
//          `goal_seek_records_one_step_that_puts_the_changing_cell_back_exactly`.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  getCell: vi.fn(),
  goalSeek: vi.fn(),
  cancelGoalSeek: vi.fn(),
  undo: vi.fn(),
  updateCellsBatch: vi.fn(),
  alert: vi.fn(async () => undefined),
}));

vi.mock("@api", () => ({
  getCell: (...a: unknown[]) => h.getCell(...a),
  goalSeek: (...a: unknown[]) => h.goalSeek(...a),
  cancelGoalSeek: (...a: unknown[]) => h.cancelGoalSeek(...a),
  undo: (...a: unknown[]) => h.undo(...a),
  updateCellsBatch: (...a: unknown[]) => h.updateCellsBatch(...a),
  columnToLetter: (col: number) => String.fromCharCode(65 + col),
}));
vi.mock("@api/dialogs", () => ({
  alertAsync: (...a: unknown[]) => h.alert(...(a as [])),
  confirmAsync: vi.fn(async () => false),
  promptAsync: vi.fn(async () => null),
}));
vi.mock("@api/dialogWindow", async () => {
  const react = await import("react");
  return {
    useDialogWindow: () => ({
      ref: react.useRef(null),
      style: {},
      onHeaderMouseDown: () => {},
      resizeHandles: null,
    }),
  };
});
vi.mock("../lib/goalSeekParse", () => ({
  parseGoalSeekTarget: (text: string) => (text.trim() === "" ? null : Number(text)),
  formatGoalSeekValue: (value: number) => String(value),
}));

import { GoalSeekDialog } from "../components/GoalSeekDialog";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let host: HTMLDivElement;
let root: Root;
let onClose: ReturnType<typeof vi.fn>;

function setInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.trim() === label);
  expect(found, `no "${label}" button`).toBeDefined();
  return found as HTMLButtonElement;
}

async function runToStatus(undoSeq: number | null): Promise<void> {
  h.getCell.mockImplementation(async (row: number, col: number) =>
    row === 0 && col === 1 ? { formula: "=A1*2" } : { formula: null },
  );
  h.goalSeek.mockResolvedValue({
    foundSolution: true,
    variableValue: 5,
    targetResult: 10,
    iterations: 2,
    // What the backend reports for a TEXT changing cell: 0. Cancel must not use it.
    originalVariableValue: 0,
    updatedCells: [],
    error: null,
    undoSeq,
  });
  await act(async () => {
    root.render(<GoalSeekDialog onClose={onClose} data={{ activeRow: 0, activeCol: 1 }} isOpen />);
  });
  const inputs = Array.from(host.querySelectorAll("input"));
  await act(async () => {
    setInput(inputs[1], "10");
    setInput(inputs[2], "$A$1");
  });
  await act(async () => {
    button("OK").click();
  });
  expect(h.goalSeek).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("Goal Seek Status");
}

beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  onClose = vi.fn();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("Goal Seek status Cancel", () => {
  it("cancels the run by its own step id -- never an undo that leaves a redo -- and never retypes the original", async () => {
    h.cancelGoalSeek.mockResolvedValue({ updatedCells: [], error: null, undoSeq: null });
    await runToStatus(41);
    await act(async () => {
      button("Cancel").click();
    });
    expect(h.cancelGoalSeek).toHaveBeenCalledTimes(1);
    expect(h.cancelGoalSeek).toHaveBeenCalledWith(41);
    expect(h.undo).not.toHaveBeenCalled();
    expect(h.updateCellsBatch).not.toHaveBeenCalled();
    expect(h.alert).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("says so when the backend refuses because something else changed the workbook meanwhile", async () => {
    h.cancelGoalSeek.mockResolvedValue({ updatedCells: [], error: "Something else changed the workbook", undoSeq: null });
    await runToStatus(7);
    await act(async () => {
      button("Cancel").click();
    });
    expect(h.cancelGoalSeek).toHaveBeenCalledWith(7);
    expect(h.alert).toHaveBeenCalledTimes(1);
    expect(String((h.alert.mock.calls[0] as unknown[])[0])).toContain("Something else changed the workbook");
    // Round 16 (whatif4): a refused Cancel keeps the status dialog open (it
    // used to close it); OK then keeps the result.
    expect(onClose).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Goal Seek Status");
    await act(async () => {
      button("OK").click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // A Cancel refused because an animation holds cells on loan (or another
  // what-if run is going) closed the status dialog after the alert and kept
  // the result: the user could not end the animation and press Cancel again.
  // It now stays open, and a second Cancel -- once the animation is stopped --
  // takes the run back.
  it("a Cancel refused while an animation holds cells keeps the dialog open, and Cancel can be retried", async () => {
    h.cancelGoalSeek
      .mockResolvedValueOnce({
        updatedCells: [],
        error: "An animation is playing or paused, and Stop puts its cells back.",
        undoSeq: null,
      })
      .mockResolvedValueOnce({ updatedCells: [], error: null, undoSeq: null });
    await runToStatus(12);
    await act(async () => {
      button("Cancel").click();
    });
    expect(h.alert).toHaveBeenCalledTimes(1);
    expect(String((h.alert.mock.calls[0] as unknown[])[0])).toContain("An animation is playing");
    expect(onClose).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Goal Seek Status");

    await act(async () => {
      button("Cancel").click();
    });
    expect(h.cancelGoalSeek).toHaveBeenCalledTimes(2);
    expect(h.cancelGoalSeek).toHaveBeenLastCalledWith(12);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("OK keeps the result: nothing is taken back", async () => {
    await runToStatus(9);
    await act(async () => {
      button("OK").click();
    });
    expect(h.undo).not.toHaveBeenCalled();
    expect(h.cancelGoalSeek).not.toHaveBeenCalled();
    expect(h.updateCellsBatch).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
