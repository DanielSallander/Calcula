//! FILENAME: app/extensions/Checkbox/__tests__/checkboxToggleRefusal.test.ts
// PURPOSE: A REFUSED Space toggle on a legacy style-flag checkbox says why --
//          one toast with the backend's reason -- and never rejects out of the
//          checkbox.toggle command.
// CONTEXT: Z7 (wave F; wave E core fix-up NEW 1). On a legacy checkbox inside a
//          pivot or report output region, `updateCellsBatch` rejects
//          (commands/data.rs, check_region_cells_protection: "Cannot change
//          cell (r, c): it is part of a PivotTable. ..."). toggleCheckboxesIn
//          Selection did not catch it: the toggle stayed un-toggled, nothing was
//          said, and the rejection travelled up to a keyboard handler that never
//          awaited it (an unhandled rejection; Core's half is pinned in
//          src/core/components/Spreadsheet/__tests__/spaceRunsExtensionCommand
//          .test.tsx).

import { describe, it, expect, vi, beforeEach } from "vitest";

const REFUSAL =
  "Cannot change cell (3, 2): it is part of a PivotTable. Use the PivotTable's own tools (refresh, edit, delete) to modify it.";

const h = vi.hoisted(() => ({
  updateCellsBatch: vi.fn(async (..._a: unknown[]): Promise<unknown> => []),
}));

vi.mock("../../../src/api/lib", () => ({
  getAllStyles: vi.fn(async () => []),
  // Style 5 is a checkbox style; B3 holds FALSE in it.
  getStyle: vi.fn(async (index: number) => (index === 5 ? { checkbox: true } : null)),
  getCell: vi.fn(async (row: number, col: number) =>
    row === 2 && col === 1 ? { row, col, display: "FALSE", styleIndex: 5 } : null,
  ),
  updateCell: vi.fn(async () => {}),
  updateCellsBatch: (...a: unknown[]) => h.updateCellsBatch(...a),
  applyFormatting: vi.fn(async () => {}),
}));

import { setCurrentSelection, toggleCheckboxesInSelection } from "../interceptors";
import { registerToastSink, type ToastPayload } from "@api/notifications";

const toasts: ToastPayload[] = [];
const refreshes: Event[] = [];
window.addEventListener("styles:refresh", (e) => refreshes.push(e));

beforeEach(() => {
  toasts.length = 0;
  refreshes.length = 0;
  registerToastSink((t) => toasts.push(t));
  h.updateCellsBatch.mockReset();
  h.updateCellsBatch.mockImplementation(async () => []);
  setCurrentSelection({ startRow: 2, startCol: 1, endRow: 2, endCol: 1, type: "cells" });
});

describe("Space on a legacy checkbox (checkbox.toggle)", () => {
  it("REFUSED by the backend: resolves, and shows the backend's reason in exactly one toast", async () => {
    h.updateCellsBatch.mockImplementation(async () => {
      throw REFUSAL;
    });
    let escaped: unknown = null;
    await toggleCheckboxesInSelection().catch((e: unknown) => {
      escaped = e ?? "rejected";
    });
    expect(escaped, "the refusal escaped the toggle as a rejection").toBeNull();
    expect(h.updateCellsBatch, "the toggle never tried to write: the test proves nothing").toHaveBeenCalledTimes(1);
    expect(
      toasts.map((t) => [t.variant, t.message]),
      "a refused toggle was silent (or said it more than once)",
    ).toEqual([["error", REFUSAL]]);
    expect(refreshes, "a refused toggle repainted as if it had changed").toEqual([]);
  });

  it("an Error-shaped refusal is shown by its message", async () => {
    h.updateCellsBatch.mockImplementation(async () => {
      throw new Error(REFUSAL);
    });
    await toggleCheckboxesInSelection();
    expect(toasts.map((t) => t.message)).toEqual([REFUSAL]);
  });

  it("allowed: toggles FALSE -> TRUE and says nothing (positive control)", async () => {
    await toggleCheckboxesInSelection();
    expect(h.updateCellsBatch.mock.calls).toEqual([[[{ row: 2, col: 1, value: "TRUE" }]]]);
    expect(toasts).toEqual([]);
    expect(refreshes.length).toBe(1);
  });
});
