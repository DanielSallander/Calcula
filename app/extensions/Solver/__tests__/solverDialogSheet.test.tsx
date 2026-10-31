//! FILENAME: app/extensions/Solver/__tests__/solverDialogSheet.test.tsx
// PURPOSE: Solver works on the ACTIVE sheet, as Excel's Solver does, and Esc
//          during a run STOPS it instead of closing the dialog.
// CONTEXT: Round-11 fix lane "whatif2" (2026-10-30). SolverDialog sent
//          `sheetIndex: 0` to solver_solve whatever sheet was active, so a run
//          from Sheet3 resolved its objective and wrote its variable cells on
//          Sheet1 (or was refused there), and the result dialog's Restore
//          reverted Sheet1 too. The backend half (a run on Sheet3 writes Sheet3
//          and nothing else) is pinned in whatif_recalc_tests.rs
//          `solver_runs_on_the_sheet_it_is_given_and_leaves_sheet1_alone`.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  solverSolve: vi.fn(),
  cancelCalculation: vi.fn(async () => true),
  openDialog: vi.fn(),
  getActiveSheet: vi.fn(async () => 2),
}));

vi.mock("@api", () => ({
  solverSolve: (...a: unknown[]) => h.solverSolve(...a),
  cancelCalculation: () => h.cancelCalculation(),
  columnToLetter: (col: number) => String.fromCharCode(65 + col),
  DialogExtensions: { openDialog: (...a: unknown[]) => h.openDialog(...a) },
}));
vi.mock("@api/lib", () => ({
  getActiveSheet: () => h.getActiveSheet(),
}));
vi.mock("@api/locale", () => ({
  parseNumber: (text: string) => (text.trim() === "" || Number.isNaN(Number(text)) ? null : Number(text)),
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

import { SolverDialog } from "../components/SolverDialog";

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

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      React.createElement(SolverDialog, {
        isOpen: true,
        onClose,
        data: { activeRow: 4, activeCol: 3 },
      } as never),
    );
  });
  const variables = host.querySelector('input[placeholder="$B$2:$B$5 or $B$2,$C$2"]') as HTMLInputElement;
  expect(variables).not.toBeNull();
  await act(async () => setInput(variables, "$B$2:$B$4"));
}

const okResult = {
  foundSolution: true,
  objectiveValue: 1,
  variableValues: [],
  iterations: 3,
  statusMessage: "Solver found a solution.",
  updatedCells: [],
  originalValues: [{ row: 1, col: 1, value: 0 }],
  error: null,
};

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  onClose = vi.fn();
  h.solverSolve.mockReset();
  h.cancelCalculation.mockClear();
  h.openDialog.mockClear();
  h.getActiveSheet.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("SolverDialog", () => {
  it("solves on the ACTIVE sheet and hands that sheet to the result dialog's Restore", async () => {
    h.solverSolve.mockResolvedValue(okResult);
    await render();
    await act(async () => button("Solve").click());

    expect(h.solverSolve).toHaveBeenCalledTimes(1);
    const params = h.solverSolve.mock.calls[0][0] as { sheetIndex: number; objectiveRow: number; objectiveCol: number };
    expect(params.sheetIndex).toBe(2);
    expect(params.objectiveRow).toBe(4);
    expect(params.objectiveCol).toBe(3);
    expect(h.openDialog).toHaveBeenCalledWith("solver-result", { result: okResult, sheetIndex: 2 });
  });

  it("Esc during a run stops it (cancel), and does not close the dialog under the running solve", async () => {
    let finish: (r: typeof okResult) => void = () => {};
    h.solverSolve.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    await render();
    await act(async () => button("Solve").click());
    expect(button("Solving...").disabled).toBe(true);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(h.cancelCalculation).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => finish({ ...okResult, foundSolution: false, statusMessage: "Solver stopped at user's request." }));
    expect(h.openDialog).toHaveBeenCalledTimes(1);
  });

  // Round 13 (whatif3): the backend clears the stop and writes the best point
  // as a real recalculation while the dialog still shows "Solving..."; a
  // second Esc raised the stop again and cut that write short (#LIMIT! in the
  // answer's dependents). One Esc stops a run; the next ones are ignored.
  it("a second Esc during a run asks for no second stop", async () => {
    let finish: (r: typeof okResult) => void = () => {};
    h.solverSolve.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    await render();
    await act(async () => button("Solve").click());
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      });
    }
    expect(h.cancelCalculation, "a second Esc raised the stop again during the final write").toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => finish({ ...okResult, foundSolution: false, statusMessage: "Solver stopped at user's request." }));

    // The NEXT run can be stopped again.
    h.solverSolve.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    h.openDialog.mockClear();
    await render();
    await act(async () => button("Solve").click());
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(h.cancelCalculation).toHaveBeenCalledTimes(2);
    await act(async () => finish(okResult));
  });

  // Round 15 (rev13A): X and Close were plain onClose, so a click during
  // "Solving..." unmounted the dialog (and its Esc-to-stop) while the run went
  // on, and the result dialog popped up later from nowhere. Modal while a run
  // is going, like the Data Table and Goal Seek dialogs and Excel's Solver.
  // SABOTAGE: make `closeUnlessRunning` call onClose unconditionally.
  it("X and Close do nothing while a run is going, and close once it answered", async () => {
    let finish: (r: typeof okResult) => void = () => {};
    h.solverSolve.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    await render();
    await act(async () => button("Solve").click());
    await act(async () => button("X").click());
    await act(async () => button("Close").click());
    expect(onClose, "X / Close closed the Solver dialog under a running solve").not.toHaveBeenCalled();

    // The run fails, so the dialog stays open with its error; Close works again.
    await act(async () => finish({ ...okResult, error: "Objective cell must contain a formula." } as never));
    expect(h.openDialog).not.toHaveBeenCalled();
    await act(async () => button("Close").click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Esc when no run is going closes the dialog, as before", async () => {
    await render();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(h.cancelCalculation).not.toHaveBeenCalled();
  });
});
