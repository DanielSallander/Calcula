//! FILENAME: app/extensions/DataTables/__tests__/dataTableDialog.test.tsx
// PURPOSE: The Data Table dialog works on the ACTIVE sheet and is MODAL while a
//          run is going, as Excel's is.
// CONTEXT: Round-13 fix lane "whatif3" (2026-10-30). The dialog sent
//          `sheetIndex: 0` whatever sheet was active, so a table selected on
//          Sheet3 was computed, written and restored on Sheet1. And while a run
//          went: Enter started a SECOND run (only the OK button was disabled),
//          which left the input cell at one of the first run's trial values;
//          Esc closed the dialog under the running table, whose results were
//          then never repainted. The backend single-flight is pinned in
//          whatif_recalc_tests.rs
//          `a_whatif_run_is_refused_while_another_is_running_and_writes_nothing`.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  dataTableOneVar: vi.fn(),
  dataTableTwoVar: vi.fn(),
  getActiveSheet: vi.fn(async () => 2),
}));

vi.mock("@api", () => ({
  dataTableOneVar: (...a: unknown[]) => h.dataTableOneVar(...a),
  dataTableTwoVar: (...a: unknown[]) => h.dataTableTwoVar(...a),
  columnToLetter: (col: number) => String.fromCharCode(65 + col),
}));
vi.mock("@api/lib", () => ({
  getActiveSheet: () => h.getActiveSheet(),
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

import { DataTableDialog } from "../components/DataTableDialog";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let host: HTMLDivElement;
let root: Root;
let onClose: ReturnType<typeof vi.fn>;
let refreshes: number;
const onRefresh = () => {
  refreshes += 1;
};

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

function key(k: string): void {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: k }));
}

/** D10:E15 selected, column input $A$10 (a one-variable table). */
async function render(): Promise<void> {
  await act(async () => {
    root.render(
      React.createElement(DataTableDialog, {
        isOpen: true,
        onClose,
        data: { activeRow: 9, activeCol: 3, endRow: 14, endCol: 4 },
      } as never),
    );
  });
  const col = host.querySelector('input[placeholder="$A$1"]') as HTMLInputElement;
  expect(col).not.toBeNull();
  await act(async () => setInput(col, "$A$10"));
}

const ok = { cells: [], updatedCells: [], error: null };

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  onClose = vi.fn();
  refreshes = 0;
  window.addEventListener("grid:refresh", onRefresh);
  h.dataTableOneVar.mockReset();
  h.dataTableTwoVar.mockReset();
  h.getActiveSheet.mockClear();
});

afterEach(() => {
  window.removeEventListener("grid:refresh", onRefresh);
  act(() => root.unmount());
  host.remove();
});

describe("DataTableDialog", () => {
  it("computes the table on the ACTIVE sheet", async () => {
    h.dataTableOneVar.mockResolvedValue(ok);
    await render();
    await act(async () => button("OK").click());
    expect(h.dataTableOneVar).toHaveBeenCalledTimes(1);
    const params = h.dataTableOneVar.mock.calls[0][0] as { sheetIndex: number; colInputRow: number };
    expect(params.sheetIndex).toBe(2);
    expect(params.colInputRow).toBe(9);
    expect(refreshes).toBe(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("is modal while a run goes: a second Enter starts nothing, Esc does not close it, and the end repaints", async () => {
    let finish: (r: typeof ok) => void = () => {};
    h.dataTableOneVar.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    await render();
    await act(async () => key("Enter"));
    expect(button("Calculating...").disabled).toBe(true);
    await act(async () => key("Enter"));
    await act(async () => key("Enter"));
    expect(h.dataTableOneVar, "Enter during a run started a second run").toHaveBeenCalledTimes(1);

    await act(async () => key("Escape"));
    await act(async () => button("Cancel").click());
    expect(onClose, "Esc / Cancel closed the dialog under the running table").not.toHaveBeenCalled();

    await act(async () => finish(ok));
    expect(refreshes, "the finished table is repainted").toBe(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("repaints after a run that ended in an error, and Esc closes once no run is going", async () => {
    h.dataTableOneVar.mockResolvedValue({ ...ok, error: "The sheet this what-if analysis runs on was deleted while it ran." });
    await render();
    await act(async () => button("OK").click());
    expect(refreshes, "a run that wrote and failed is repainted too").toBe(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(host.textContent).toContain("deleted while it ran");
    await act(async () => key("Escape"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
