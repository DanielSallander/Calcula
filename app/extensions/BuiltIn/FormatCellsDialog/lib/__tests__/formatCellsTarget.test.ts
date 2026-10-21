//! FILENAME: app/extensions/BuiltIn/FormatCellsDialog/lib/__tests__/formatCellsTarget.test.ts
// PURPOSE: Format Cells' OK on a FLOATING GRID'S cells: the rectangle is the
//          grid's own selection, and every write -- applyFormatting,
//          applyBorderPreset, and the Locked / Hidden flags -- carries the
//          grid's `{ target }`; never Core's selection, and never the active
//          sheet's protection command.
// CONTEXT: P3 S9 (owner finding G3; closes the BUG-0493 door properly). The
//          writes do not live in the dialog: lib/formatCellsWrites.ts plans
//          them and executes them over the rectangle and target the dialog
//          resolved. Core's selection (A1:B2) and the grid's (D6:E8) differ on
//          purpose.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  applyFormatting: vi.fn(async (..._a: unknown[]) => ({ cells: [{ row: 5, col: 3, display: "", formula: null, styleIndex: 1 }], styles: [] })),
  applyBorderPreset: vi.fn(async (..._a: unknown[]) => ({ cells: [], styles: [] })),
  setCellProtection: vi.fn(async (..._a: unknown[]) => ({ success: true })),
}));
vi.mock("@api/lib", () => ({
  applyFormatting: (...a: unknown[]) => h.applyFormatting(...a),
  applyBorderPreset: (...a: unknown[]) => h.applyBorderPreset(...a),
}));
vi.mock("@api/backend", () => ({
  setCellProtection: (...a: unknown[]) => h.setCellProtection(...a),
}));

import {
  planFormatCellsWrites,
  executeFormatCellsPlan,
  formatCellsRectOf,
} from "../formatCellsWrites";
import { useFormatCellsStore, snapshotOf, type FormatCellsSnapshot } from "../../hooks/useFormatCellsState";
import type { CellTarget } from "@api/cellTarget";

const REF = { kind: "floatingRange" as const, id: "fr-3" };
const CORE = { startRow: 0, startCol: 0, endRow: 1, endCol: 1, type: "cells" as const };
/** The grid's own selection, D6:E8, drawn bottom-up (normalised by the rect). */
const OBJECT: CellTarget = {
  kind: "object",
  ownerId: "floatingRange",
  ref: REF,
  selection: { startRow: 7, startCol: 4, endRow: 5, endCol: 3, activeRow: 5, activeCol: 3, type: "cells" },
  bounds: { rows: 20, cols: 8 },
  label: "Float1",
  wholeObject: false,
};
const GRID_TARGET: CellTarget = { kind: "grid", selection: CORE };

function loaded(): FormatCellsSnapshot {
  useFormatCellsStore.getState().reset();
  return { ...snapshotOf(useFormatCellsStore.getState()), fontFamily: "Calibri", numberFormat: "general" };
}

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockClear();
});

describe("formatCellsRectOf", () => {
  it("an object target: the grid's OWN selection, normalised -- never Core's", () => {
    expect(formatCellsRectOf(OBJECT, CORE)).toEqual({ startRow: 5, startCol: 3, endRow: 7, endCol: 4 });
  });

  it("the grid target: Core's selection (the seam's, else the dialog's)", () => {
    expect(formatCellsRectOf(GRID_TARGET)).toEqual({ startRow: 0, startCol: 0, endRow: 1, endCol: 1 });
    expect(formatCellsRectOf({ kind: "grid", selection: null }, CORE)).toEqual({ startRow: 0, startCol: 0, endRow: 1, endCol: 1 });
    expect(formatCellsRectOf({ kind: "grid", selection: null }, null)).toBeNull();
  });
});

describe("executeFormatCellsPlan with an object target", () => {
  it("formatting, an Outline and the Locked flag all go to the grid's rows/cols with { target }", async () => {
    const baseline = loaded();
    const thick = { style: "thick" as const, color: "#000000" };
    const current: FormatCellsSnapshot = {
      ...baseline,
      bold: true,
      borderTop: thick,
      borderBottom: thick,
      borderLeft: thick,
      borderRight: thick,
      locked: !baseline.locked,
    };
    const rect = formatCellsRectOf(OBJECT, CORE)!;
    const plan = planFormatCellsWrites(baseline, current, rect, false);
    const done = await executeFormatCellsPlan(plan, rect, REF);

    expect(h.applyFormatting.mock.calls).toEqual([
      [[5, 6, 7], [3, 4], { bold: true }, { target: REF }],
      [[5, 6, 7], [3, 4], { locked: current.locked, formulaHidden: current.formulaHidden }, { target: REF }],
    ]);
    expect(h.applyBorderPreset.mock.calls).toEqual([[5, 3, 7, 4, "outside", "solid", "#000000", 3, { target: REF }]]);
    // The active sheet's protection command is never asked about a floating
    // grid's cells (it would lock the sheet cells under the grid).
    expect(h.setCellProtection).not.toHaveBeenCalled();
    expect(done.protectionError).toBeNull();
    // Core's rows (0..1) were never written.
    for (const call of h.applyFormatting.mock.calls) expect(call[0]).not.toContain(0);
  });

  it("an edge change (no outline) writes only the grid's edge, with the target", async () => {
    const baseline = loaded();
    const rect = formatCellsRectOf(OBJECT, CORE)!;
    const plan = planFormatCellsWrites(baseline, { ...baseline, borderTop: { style: "thin", color: "#ff0000" } }, rect, false);
    await executeFormatCellsPlan(plan, rect, REF);
    expect(h.applyFormatting.mock.calls).toEqual([
      [[5], [3, 4], { borderTop: { style: "thin", color: "#ff0000" } }, { target: REF }],
    ]);
  });
});

describe("executeFormatCellsPlan on Core's selection (no target)", () => {
  it("writes with no target and changes protection through setCellProtection", async () => {
    const baseline = loaded();
    const rect = formatCellsRectOf(GRID_TARGET)!;
    const plan = planFormatCellsWrites(baseline, { ...baseline, italic: true, formulaHidden: true }, rect, false);
    h.setCellProtection.mockResolvedValueOnce({ success: false, error: "Sheet1 is protected." } as never);
    const done = await executeFormatCellsPlan(plan, rect, undefined);
    expect(h.applyFormatting.mock.calls).toEqual([[[0, 1], [0, 1], { italic: true }, { target: undefined }]]);
    expect(h.setCellProtection.mock.calls).toEqual([
      [{ startRow: 0, startCol: 0, endRow: 1, endCol: 1, locked: baseline.locked, formulaHidden: true }],
    ]);
    expect(done.protectionError).toBe("Sheet1 is protected.");
  });
});
