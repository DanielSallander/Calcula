//! FILENAME: app/extensions/GoalSeek/__tests__/goalSeekModal.test.tsx
// PURPOSE: The Goal Seek dialog is MODAL while a run is going, as Excel's is.
// CONTEXT: Round-13 fix lane "whatif3" (2026-10-30). Only the OK button was
//          disabled during a run, so Enter pressed again started a SECOND run
//          beside the first (the command is `(async)`): it snapshotted the
//          first run's TRIAL value as the changing cell's original, and Cancel
//          then put that trial back. Esc closed the dialog under the running
//          search. The backend single-flight is pinned in whatif_recalc_tests.rs
//          `a_whatif_run_is_refused_while_another_is_running_and_writes_nothing`.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  getCell: vi.fn(),
  goalSeek: vi.fn(),
  cancelGoalSeek: vi.fn(),
  alert: vi.fn(async () => undefined),
}));

vi.mock("@api", () => ({
  getCell: (...a: unknown[]) => h.getCell(...a),
  goalSeek: (...a: unknown[]) => h.goalSeek(...a),
  cancelGoalSeek: (...a: unknown[]) => h.cancelGoalSeek(...a),
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

function key(k: string): void {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: k }));
}

const answer = {
  foundSolution: true,
  variableValue: 5,
  targetResult: 10,
  iterations: 2,
  originalVariableValue: 1,
  updatedCells: [],
  error: null,
  undoSeq: 7,
};

beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  onClose = vi.fn();
  h.getCell.mockImplementation(async (row: number, col: number) =>
    row === 0 && col === 1 ? { formula: "=A1*2" } : { formula: null },
  );
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("GoalSeekDialog while a run is going", () => {
  it("a second Enter starts no second run and Esc does not close the dialog", async () => {
    let finish: (r: typeof answer) => void = () => {};
    h.goalSeek.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    await act(async () => {
      root.render(<GoalSeekDialog onClose={onClose} data={{ activeRow: 0, activeCol: 1 }} isOpen />);
    });
    const inputs = Array.from(host.querySelectorAll("input"));
    await act(async () => {
      setInput(inputs[1], "10");
      setInput(inputs[2], "$A$1");
    });

    await act(async () => key("Enter"));
    await act(async () => key("Enter"));
    await act(async () => key("Enter"));
    expect(h.goalSeek, "Enter during a run started a second Goal Seek").toHaveBeenCalledTimes(1);
    await act(async () => key("Escape"));
    expect(onClose, "Esc closed the dialog under the running search").not.toHaveBeenCalled();

    await act(async () => finish(answer));
    expect(host.textContent).toContain("Goal Seek Status");

    // Esc in the status dialog is its Cancel, asked ONCE.
    let cancelled: (r: unknown) => void = () => {};
    h.cancelGoalSeek.mockImplementation(() => new Promise((resolve) => (cancelled = resolve)));
    await act(async () => key("Escape"));
    await act(async () => key("Escape"));
    expect(h.cancelGoalSeek).toHaveBeenCalledTimes(1);
    expect(h.cancelGoalSeek).toHaveBeenCalledWith(7);
    await act(async () => cancelled({ error: null }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(h.alert).not.toHaveBeenCalled();
  });
});
