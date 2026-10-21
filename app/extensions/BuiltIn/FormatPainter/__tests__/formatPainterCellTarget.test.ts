//! FILENAME: app/extensions/BuiltIn/FormatPainter/__tests__/formatPainterCellTarget.test.ts
// PURPOSE: Format Painter and a floating grid's cells (P3 S10, owner finding
//          G3).
//            - FROM a floating grid TO the sheet: the source styles are read
//              through the grid's styled read (never Core's hidden cell under
//              the grid), no marching ants are drawn on the host, and a sheet
//              stroke paints the grid's styles, tiled.
//            - FROM the sheet INTO a floating grid: refused with one sentence,
//              nothing written, the painter stays armed -- a stroke assigns a
//              style INDEX per cell and no style-index write takes a target
//              yet (BUG-0513). The grid's own selection
//              moving (`onCellTargetChanged`) is a stroke attempt like a click.
// CONTEXT: The selection owner is REAL (@api/selectionOwner), shaped like the
//          floating grid's; the styled read is a double.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  getCell: vi.fn(),
  setCellStyle: vi.fn(),
  begin: vi.fn(),
  commit: vi.fn(),
  dispatch: vi.fn(),
  read: vi.fn(),
  alert: vi.fn(),
}));

vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  getCell: (...a: unknown[]) => h.getCell(...a),
  setCellStyle: (...a: unknown[]) => h.setCellStyle(...a),
  beginUndoTransaction: (...a: unknown[]) => h.begin(...a),
  commitUndoTransaction: (...a: unknown[]) => h.commit(...a),
  cancelUndoTransaction: vi.fn(),
  dispatchGridAction: (...a: unknown[]) => h.dispatch(...a),
  restoreFocusToGrid: vi.fn(),
  registerEditGuard: () => () => {},
  ExtensionRegistry: { onSelectionChange: () => () => {} },
}));
vi.mock("@api/cellTarget", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/cellTarget")>()),
  getCellTargetCells: (...a: unknown[]) => h.read(...a),
}));
vi.mock("@api/dialogs", () => ({ alertAsync: (...a: unknown[]) => h.alert(...a) }));

import {
  activateFormatPainter,
  applyFormatToTarget,
  deactivateFormatPainter,
  PAINT_INTO_FLOATING_GRID_REFUSAL,
} from "../formatPainterLogic";
import { getSourceStyles, isFormatPainterActive } from "../formatPainterState";
import { registerSelectionOwner, type CellTargetCapability } from "@api/selectionOwner";
import { notifyCellTargetChanged } from "@api/cellTarget";
import type { Selection } from "@api/types";

const REF = { kind: "floatingRange" as const, id: "fr-1" };
const SHEET_SOURCE: Selection = { startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells" };
const SHEET_TARGET: Selection = { startRow: 4, startCol: 4, endRow: 5, endCol: 5, type: "cells" };
const ADMITS: readonly CellTargetCapability[] = ["read", "format", "numberFormat", "content", "clear"];

let frSelection: Selection | null = null;
let release: () => void = () => {};

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset();
  h.getCell.mockResolvedValue({ styleIndex: 3 });
  h.setCellStyle.mockResolvedValue(undefined);
  h.begin.mockResolvedValue(5);
  h.commit.mockResolvedValue(undefined);
  h.alert.mockResolvedValue(undefined);
  h.read.mockResolvedValue({
    cells: [
      { row: 1, col: 1, display: "a", formula: null, styleIndex: 7, valueKind: "text" },
      { row: 1, col: 2, display: "", formula: null, styleIndex: 8, valueKind: "empty" },
    ],
    merges: [],
    conditional: [],
    styles: [],
    rules: [],
  });
  frSelection = null;
  release = registerSelectionOwner({
    id: "test-floating-grid",
    label: "a floating grid's cells",
    ownsSelection: () => frSelection !== null,
    actsOn: ADMITS,
    cellTarget: () =>
      frSelection === null
        ? null
        : { ref: REF, selection: frSelection, bounds: { rows: 10, cols: 5 }, label: "Float1", wholeObject: false },
  });
});

afterEach(() => {
  deactivateFormatPainter();
  release();
});

describe("from a floating grid to the sheet", () => {
  it("reads the source through the grid's target, draws no ants on the host, and paints the sheet stroke", async () => {
    frSelection = { startRow: 1, startCol: 1, endRow: 1, endCol: 2, type: "cells" };
    // The caller hands Core's selection (hidden under the grid): it must not be read.
    await activateFormatPainter(false, SHEET_SOURCE);
    expect(h.read).toHaveBeenCalledWith(REF, { startRow: 1, startCol: 1, endRow: 1, endCol: 2 });
    expect(h.getCell, "captured Core's hidden cell under the grid").not.toHaveBeenCalled();
    expect([...getSourceStyles().entries()]).toEqual([
      ["0,0", 7],
      ["0,1", 8],
    ]);
    expect(h.dispatch, "drew marching ants on the HOST at the grid's coordinates").not.toHaveBeenCalled();
    expect(isFormatPainterActive()).toBe(true);

    // The user clicks a sheet cell: the grid no longer owns the selection.
    frSelection = null;
    await applyFormatToTarget({ startRow: 4, startCol: 4, endRow: 4, endCol: 6, type: "cells" });
    expect(h.setCellStyle.mock.calls).toEqual([
      [4, 4, 7],
      [4, 5, 8],
      [4, 6, 7],
    ]);
  });
});

describe("from the sheet into a floating grid", () => {
  it("a stroke into the grid's cells is refused with one sentence; nothing written; the painter stays armed", async () => {
    await activateFormatPainter(false, SHEET_SOURCE);
    expect(isFormatPainterActive()).toBe(true);
    frSelection = { startRow: 2, startCol: 2, endRow: 2, endCol: 2, type: "cells" };
    await applyFormatToTarget(frSelection);
    expect(h.setCellStyle, "painted the HOST's hidden cell").not.toHaveBeenCalled();
    expect(h.begin).not.toHaveBeenCalled();
    expect(h.alert).toHaveBeenCalledWith(PAINT_INTO_FLOATING_GRID_REFUSAL);
    expect(isFormatPainterActive(), "a refused stroke disarmed the painter").toBe(true);
  });

  it("the grid's OWN selection moving is a stroke attempt (it never moves Core's selection)", async () => {
    await activateFormatPainter(true, SHEET_SOURCE);
    frSelection = { startRow: 3, startCol: 0, endRow: 3, endCol: 0, type: "cells" };
    notifyCellTargetChanged();
    await vi.waitFor(() => expect(h.alert).toHaveBeenCalledWith(PAINT_INTO_FLOATING_GRID_REFUSAL));
    expect(h.setCellStyle).not.toHaveBeenCalled();
  });

  it("positive control: a sheet-to-sheet stroke paints", async () => {
    await activateFormatPainter(false, SHEET_SOURCE);
    await applyFormatToTarget(SHEET_TARGET);
    expect(h.setCellStyle).toHaveBeenCalledTimes(4);
    expect(h.alert).not.toHaveBeenCalled();
  });
});
