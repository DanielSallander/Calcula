//! FILENAME: app/extensions/Solver/__tests__/solverResultRestore.test.tsx
// PURPOSE: The Solver Results dialog's Restore Original Values names the run's
//          sheet by its STABLE id (`SolverResultData.sheetId`), never by the
//          index the sheet had when the run started, and says so when the
//          backend refuses.
// CONTEXT: Round-16 fix lane "whatif4" (2026-10-31). Restore sent the dialog's
//          `sheetIndex`; a tab dragged while the dialog was open made it write
//          the original values onto whichever sheet held that position now. The
//          backend half (Restore follows the id through a tab move, and a
//          deleted sheet is refused) is pinned in whatif_recalc_tests.rs
//          `solvers_restore_follows_its_sheet_by_stable_id`.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  solverRevert: vi.fn(),
  alert: vi.fn(async () => undefined),
  emit: vi.fn(),
}));

vi.mock("@api", () => ({
  solverRevert: (...a: unknown[]) => h.solverRevert(...a),
  columnToLetter: (col: number) => String.fromCharCode(65 + col),
}));
vi.mock("@api/events", () => ({
  emitAppEvent: (...a: unknown[]) => h.emit(...a),
  AppEvents: { CELLS_UPDATED: "app:cells-updated" },
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

import { SolverResultDialog } from "../components/SolverResultDialog";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const SHEET2_ID = "0191abcd-6789-7abc-8def-0123456789ab";

let host: HTMLDivElement;
let root: Root;
let onClose: ReturnType<typeof vi.fn>;

function button(label: string): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.trim() === label);
  expect(found, `no "${label}" button`).toBeDefined();
  return found as HTMLButtonElement;
}

async function render(sheetId: string | null = SHEET2_ID): Promise<void> {
  await act(async () => {
    root.render(
      React.createElement(SolverResultDialog, {
        isOpen: true,
        onClose,
        // The dialog was opened for a run on the sheet then at index 1.
        data: {
          sheetIndex: 1,
          result: {
            foundSolution: true,
            objectiveValue: 0,
            variableValues: [{ row: 0, col: 0, value: 3 }],
            iterations: 4,
            statusMessage: "Solver found a solution.",
            updatedCells: [],
            originalValues: [{ row: 0, col: 0, value: 0 }],
            sheetId,
            error: null,
          },
        },
      } as never),
    );
  });
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

describe("Solver Results: Restore Original Values", () => {
  it("restores on the run's sheet by its stable id, never by the index it had", async () => {
    h.solverRevert.mockResolvedValue({ updatedCells: [], error: null });
    await render();
    await act(async () => {
      button("Restore Original Values").click();
    });
    expect(h.solverRevert).toHaveBeenCalledTimes(1);
    expect(h.solverRevert).toHaveBeenCalledWith(SHEET2_ID, [{ row: 0, col: 0, value: 0 }]);
    expect(h.alert).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("says so when the backend refuses (the sheet was deleted meanwhile)", async () => {
    h.solverRevert.mockResolvedValue({
      updatedCells: [],
      error: "The sheet this what-if analysis runs on was deleted while it ran.",
    });
    await render();
    await act(async () => {
      button("Restore Original Values").click();
    });
    expect(h.alert).toHaveBeenCalledTimes(1);
    expect(String((h.alert.mock.calls[0] as unknown[])[0])).toContain("was deleted");
  });

  // Round 18 (whatif5). A refused Restore closed the dialog after the alert, so
  // the original values could no longer be restored; Goal Seek's refused Cancel
  // keeps its dialog open, and so does this now. Keep closes it.
  it("keeps the dialog open when a Restore is refused, so it can be retried", async () => {
    h.solverRevert.mockResolvedValueOnce({
      updatedCells: [],
      error: "Another what-if analysis (Data Table, Goal Seek, Solver or a scenario) is still running.",
    });
    await render();
    await act(async () => {
      button("Restore Original Values").click();
    });
    expect(h.alert).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(h.emit).not.toHaveBeenCalled();
    // Retried once the other run is over: restored, announced, closed.
    h.solverRevert.mockResolvedValueOnce({ updatedCells: [], error: null });
    await act(async () => {
      button("Restore Original Values").click();
    });
    expect(h.solverRevert).toHaveBeenCalledTimes(2);
    expect(h.emit).toHaveBeenCalledWith("app:cells-updated");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("says why when the result names no sheet, instead of closing with the values kept", async () => {
    await render(null);
    await act(async () => {
      button("Restore Original Values").click();
    });
    expect(h.solverRevert).not.toHaveBeenCalled();
    expect(h.alert).toHaveBeenCalledTimes(1);
    expect(String((h.alert.mock.calls[0] as unknown[])[0])).toContain("could not restore");
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => {
      button("Keep Solver Solution").click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
