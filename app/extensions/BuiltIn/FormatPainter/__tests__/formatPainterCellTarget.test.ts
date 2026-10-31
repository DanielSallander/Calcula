//! FILENAME: app/extensions/BuiltIn/FormatPainter/__tests__/formatPainterCellTarget.test.ts
// PURPOSE: Format Painter and a floating grid's cells (P3 S10, owner finding
//          G3).
//            - FROM a floating grid TO the sheet: the source styles are read
//              through the grid's styled read (never Core's hidden cell under
//              the grid), no marching ants are drawn on the host, and a sheet
//              stroke paints the grid's styles, tiled.
//            - FROM the sheet INTO a floating grid (BUG-0513): exactly as
//              sheet -> sheet -- each cell of the grid's selection is pointed
//              at the source's style INDEX through `setCellStyle`'s TARGET, in
//              the grid's own coordinates, tiled, as ONE undo step. The grid's
//              own selection moving (`onCellTargetChanged`) is a stroke like a
//              click; a notification that merely restates the last stroke is
//              not a second one.
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

import { activateFormatPainter, applyFormatToTarget, deactivateFormatPainter } from "../formatPainterLogic";
import { getSourceStyles, isFormatPainterActive } from "../formatPainterState";
import { registerSelectionOwner, type CellTargetCapability } from "@api/selectionOwner";
import { notifyCellTargetChanged } from "@api/cellTarget";
import type { Selection } from "@api/types";

const REF = { kind: "floatingRange" as const, id: "fr-1" };
const SHEET_SOURCE: Selection = { startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells" };
const SHEET_TARGET: Selection = { startRow: 4, startCol: 4, endRow: 5, endCol: 5, type: "cells" };
const ADMITS: readonly CellTargetCapability[] = ["read", "format", "numberFormat", "content", "clear"];

/** The stroke's whole-rectangle CHECK (`checkArea`): writes nothing. */
function isCheck(a: readonly unknown[]): boolean {
  return Boolean((a[3] as { checkArea?: unknown } | undefined)?.checkArea);
}

/** The cell WRITES (every setCellStyle call but the check). */
function paints(): unknown[][] {
  return h.setCellStyle.mock.calls.filter((a) => !isCheck(a));
}

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
    // A sheet stroke: no target, the active sheet.
    expect(h.setCellStyle.mock.calls).toEqual([
      [4, 4, 0, { target: undefined, checkArea: { startRow: 4, startCol: 4, endRow: 4, endCol: 6 } }],
      [4, 4, 7, { target: undefined }],
      [4, 5, 8, { target: undefined }],
      [4, 6, 7, { target: undefined }],
    ]);
  });
});

describe("from the sheet into a floating grid (BUG-0513)", () => {
  it("a stroke into the grid's cells paints them through the TARGET, tiled, as ONE undo step", async () => {
    h.getCell.mockImplementation(async (r: number, c: number) => ({ styleIndex: 10 + r * 2 + c }));
    // A 1x2 sheet source: A1 (style 10), B1 (style 11).
    await activateFormatPainter(false, { startRow: 0, startCol: 0, endRow: 0, endCol: 1, type: "cells" });
    expect(isFormatPainterActive()).toBe(true);
    frSelection = { startRow: 2, startCol: 1, endRow: 3, endCol: 3, type: "cells" };
    // The stroke's Selection argument is ignored for an object: the grid's own
    // selection (its coordinates) is where it lands.
    await applyFormatToTarget({ startRow: 40, startCol: 40, endRow: 40, endCol: 40, type: "cells" });
    expect(h.setCellStyle.mock.calls).toEqual([
      // ONE check of the whole stroke before its first cell (all or nothing).
      [2, 1, 0, { target: REF, checkArea: { startRow: 2, startCol: 1, endRow: 3, endCol: 3 } }],
      [2, 1, 10, { target: REF }],
      [2, 2, 11, { target: REF }],
      [2, 3, 10, { target: REF }],
      [3, 1, 10, { target: REF }],
      [3, 2, 11, { target: REF }],
      [3, 3, 10, { target: REF }],
    ]);
    expect(h.begin).toHaveBeenCalledTimes(1);
    expect(h.commit).toHaveBeenCalledTimes(1);
    expect(h.alert, "a stroke into the grid was refused").not.toHaveBeenCalled();
    expect(isFormatPainterActive(), "a single-use painter disarms after its stroke").toBe(false);
  });

  it("the grid's OWN selection moving is a stroke (it never moves Core's selection); a restatement is not a second", async () => {
    await activateFormatPainter(true, SHEET_SOURCE);
    frSelection = { startRow: 3, startCol: 0, endRow: 3, endCol: 0, type: "cells" };
    notifyCellTargetChanged();
    await vi.waitFor(() => expect(h.commit).toHaveBeenCalledTimes(1));
    expect(paints()).toEqual([[3, 0, 3, { target: REF }]]);
    expect(h.alert).not.toHaveBeenCalled();
    // The same selection announced again (a repaint, a format announcement):
    // no second stroke, no second undo step.
    notifyCellTargetChanged();
    await new Promise((r) => setTimeout(r, 0));
    expect(paints()).toHaveLength(1);
    // A NEW cell of the grid is a new stroke.
    frSelection = { startRow: 4, startCol: 1, endRow: 4, endCol: 1, type: "cells" };
    notifyCellTargetChanged();
    await vi.waitFor(() => expect(h.commit).toHaveBeenCalledTimes(2));
    expect(paints()[1]).toEqual([4, 1, 3, { target: REF }]);
  });

  it("a refused grid stroke (the host's protection) changes NO cell, opens no step, and says why", async () => {
    // The host does not allow Format Cells: the whole-stroke check refuses
    // before A1 or A2 is painted (rev10A finding 3). (A LOCKED cell is no
    // longer a refusal: with Format Cells allowed Excel paints it and it keeps
    // its Locked flag [LIVE, Excel 16 COM, 2026-10-30] -- round 12 wrote this
    // premise as "A3 locked".)
    h.setCellStyle.mockImplementation(async (...a: unknown[]) => {
      if (isCheck(a)) throw new Error("Cannot format cells on a protected sheet.");
      return null;
    });
    await activateFormatPainter(true, SHEET_SOURCE);
    frSelection = { startRow: 0, startCol: 0, endRow: 2, endCol: 0, type: "cells" };
    await applyFormatToTarget(frSelection);
    expect(h.setCellStyle.mock.calls).toEqual([
      [0, 0, 0, { target: REF, checkArea: { startRow: 0, startCol: 0, endRow: 2, endCol: 0 } }],
    ]);
    expect(paints(), "cells were painted before the refusal").toEqual([]);
    expect(h.begin, "a refused stroke opened an undo step").not.toHaveBeenCalled();
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.alert).toHaveBeenCalledWith("Cannot format cells on a protected sheet.");
  });

  it("a refused SHEET stroke changes no cell either (the same check, no target)", async () => {
    h.setCellStyle.mockImplementation(async (...a: unknown[]) => {
      if (isCheck(a)) throw new Error("Cannot format cells on a protected sheet.");
      return null;
    });
    await activateFormatPainter(false, SHEET_SOURCE);
    await applyFormatToTarget(SHEET_TARGET);
    expect(h.setCellStyle.mock.calls).toEqual([
      [4, 4, 0, { target: undefined, checkArea: { startRow: 4, startCol: 4, endRow: 5, endCol: 5 } }],
    ]);
    expect(h.begin).not.toHaveBeenCalled();
    expect(h.alert).toHaveBeenCalledWith("Cannot format cells on a protected sheet.");
  });

  it("positive control: a sheet-to-sheet stroke paints", async () => {
    await activateFormatPainter(false, SHEET_SOURCE);
    await applyFormatToTarget(SHEET_TARGET);
    expect(paints()).toHaveLength(4);
    expect(h.alert).not.toHaveBeenCalled();
  });
});
