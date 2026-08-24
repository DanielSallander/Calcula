//! FILENAME: app/src/core/hooks/useMouseSelection/__tests__/selectAllCorner.test.ts
// PURPOSE: The select-all corner does something in BOTH mouse-down modes --
//          selects the whole sheet in normal mode, inserts the whole-sheet
//          reference during formula entry.
//
// CONTEXT: The formula-mode half was MISSING WIRING OVER A WORKING PRIMITIVE,
//          and it failed SILENTLY. `handleMouseDown` tried exactly three
//          handlers in formula mode, and all three are structurally blind to the
//          corner: getCellFromPixel, getColumnFromHeader and getRowFromHeader
//          each return null when `pixelX < rowHeaderWidth` or
//          `pixelY < colHeaderHeight`. So every handler returned false, the
//          branch fell through, and the click inserted NOTHING -- no error, no
//          reference, no complaint. Meanwhile `insertRowRangeReference` had
//          exactly one caller, reachable only from a row-header pixel, so no
//          code path in the repo could emit `1:1048576` at all.
//
//          The first three tests below are the ones that would have caught it:
//          they pin that the three old hit tests refuse the corner, which is the
//          reason the corner needs a predicate of its own.
//
// THE CLICK-NOT-DRAG DECISION IS TESTED, NOT ASSUMED. Excel's corner is a
// button. The row/column header handlers seed a drag ref and insert on mouse UP;
// the last test here shows what that would have produced for the corner -- mouse
// up re-reads the pointer through getRowFromHeader, gets null on a corner pixel,
// falls back to the start index and inserts `1:1`. A whole-sheet reference that
// silently becomes row 1 is a wrong ANSWER, not an error, so the corner inserts
// on mouse down and seeds no drag at all.

import { describe, it, expect, vi } from "vitest";

import { createFormulaHeaderHandlers } from "../editing/formulaHeaderHandlers";
import { createHeaderSelectionHandlers } from "../selection/headerSelectionHandlers";
import type { FormulaHeaderDragState, MousePosition } from "../types";
import type { HeaderDragState } from "../types";
import {
  getCellFromPixel,
  getColumnFromHeader,
  getRowFromHeader,
  isSelectAllCorner,
  rowRangeToReference,
} from "../../../lib/gridRenderer";
import { cappedHighlightEndRow, MAX_FORMULA_REFERENCE_ROWS } from "../../useEditing";
import { DEFAULT_GRID_CONFIG, type GridConfig, type Viewport } from "../../../types";

const CONFIG: GridConfig = { ...DEFAULT_GRID_CONFIG };
const VIEWPORT: Viewport = { scrollX: 0, scrollY: 0, startRow: 0, startCol: 0, rowCount: 30, colCount: 10 };
const DIMENSIONS = { columnWidths: new Map<number, number>(), rowHeights: new Map<number, number>() };

/** Dead centre of the 22x20 corner box. */
const CORNER = { x: 11, y: 10 };
/** A column-header pixel: past the row gutter, still above the cells. */
const COL_HEADER = { x: 60, y: 10 };
/** A row-header pixel: inside the row gutter, below the column header. */
const ROW_HEADER = { x: 11, y: 60 };
/** An ordinary cell pixel. */
const CELL = { x: 60, y: 60 };

function makeEvent(): React.MouseEvent<HTMLElement> {
  return { preventDefault: vi.fn(), button: 0, shiftKey: false } as unknown as React.MouseEvent<HTMLElement>;
}

function makeFormulaHandlers(overrides: Partial<Parameters<typeof createFormulaHeaderHandlers>[0]> = {}) {
  const onInsertRowRangeReference = vi.fn();
  const onInsertRowReference = vi.fn();
  const onInsertColumnReference = vi.fn();
  const setIsFormulaDragging = vi.fn();
  const formulaHeaderDragStartRef = { current: null as FormulaHeaderDragState | null };
  const lastMousePosRef = { current: null as MousePosition | null };

  const handlers = createFormulaHeaderHandlers({
    config: CONFIG,
    viewport: VIEWPORT,
    dimensions: DIMENSIONS,
    onInsertColumnReference,
    onInsertRowReference,
    onInsertRowRangeReference,
    setIsFormulaDragging,
    formulaHeaderDragStartRef,
    lastMousePosRef,
    ...overrides,
  });

  return {
    handlers,
    onInsertRowRangeReference,
    onInsertRowReference,
    setIsFormulaDragging,
    formulaHeaderDragStartRef,
    lastMousePosRef,
  };
}

function makeSelectionHandlers() {
  const calls: string[] = [];
  const onSelectCell = vi.fn((..._args: unknown[]) => { calls.push("select"); });
  const onCommitBeforeSelect = vi.fn(async () => { calls.push("commit"); });

  const handlers = createHeaderSelectionHandlers({
    config: CONFIG,
    viewport: VIEWPORT,
    dimensions: DIMENSIONS,
    selection: null,
    onSelectCell: onSelectCell as never,
    onExtendTo: vi.fn(),
    onCommitBeforeSelect,
    setIsDragging: vi.fn(),
    headerDragRef: { current: null as HeaderDragState | null },
    lastMousePosRef: { current: null as MousePosition | null },
  });

  return { handlers, onSelectCell, onCommitBeforeSelect, calls };
}

describe("the corner is invisible to every cell/column/row hit test", () => {
  it("getCellFromPixel returns null on a corner pixel", () => {
    expect(getCellFromPixel(CORNER.x, CORNER.y, CONFIG, VIEWPORT, DIMENSIONS)).toBeNull();
    // The control: the same function answers for an ordinary cell pixel.
    expect(getCellFromPixel(CELL.x, CELL.y, CONFIG, VIEWPORT, DIMENSIONS)).not.toBeNull();
  });

  it("getColumnFromHeader returns null on a corner pixel", () => {
    expect(getColumnFromHeader(CORNER.x, CORNER.y, CONFIG, VIEWPORT, DIMENSIONS)).toBeNull();
    expect(getColumnFromHeader(COL_HEADER.x, COL_HEADER.y, CONFIG, VIEWPORT, DIMENSIONS)).not.toBeNull();
  });

  it("getRowFromHeader returns null on a corner pixel", () => {
    expect(getRowFromHeader(CORNER.x, CORNER.y, CONFIG, VIEWPORT, DIMENSIONS)).toBeNull();
    expect(getRowFromHeader(ROW_HEADER.x, ROW_HEADER.y, CONFIG, VIEWPORT, DIMENSIONS)).not.toBeNull();
  });
});

describe("isSelectAllCorner names the corner and nothing else", () => {
  it("accepts the corner box and rejects the three neighbouring regions", () => {
    expect(isSelectAllCorner(CORNER.x, CORNER.y, CONFIG)).toBe(true);
    expect(isSelectAllCorner(COL_HEADER.x, COL_HEADER.y, CONFIG)).toBe(false);
    expect(isSelectAllCorner(ROW_HEADER.x, ROW_HEADER.y, CONFIG)).toBe(false);
    expect(isSelectAllCorner(CELL.x, CELL.y, CONFIG)).toBe(false);
  });

  it("is half-open: the first cell pixel is NOT the corner", () => {
    const w = CONFIG.rowHeaderWidth;
    const h = CONFIG.colHeaderHeight;
    expect(isSelectAllCorner(w - 1, h - 1, CONFIG)).toBe(true);
    expect(isSelectAllCorner(w, h - 1, CONFIG)).toBe(false);
    expect(isSelectAllCorner(w - 1, h, CONFIG)).toBe(false);
  });

  it("a collapsed gutter (View > Headings off) has no corner at all", () => {
    const noHeadings: GridConfig = { ...CONFIG, rowHeaderWidth: 0, colHeaderHeight: 0 };
    expect(isSelectAllCorner(0, 0, noHeadings)).toBe(false);
  });
});

describe("formula mode: a corner click inserts the whole-sheet reference", () => {
  it("inserts every row of the sheet", () => {
    const { handlers, onInsertRowRangeReference } = makeFormulaHandlers();
    const event = makeEvent();

    expect(handlers.handleFormulaCornerMouseDown(CORNER.x, CORNER.y, event)).toBe(true);
    expect(onInsertRowRangeReference).toHaveBeenCalledWith(0, CONFIG.totalRows - 1);
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it("the range it asks for spells `1:1048576`", () => {
    const { handlers, onInsertRowRangeReference } = makeFormulaHandlers();
    handlers.handleFormulaCornerMouseDown(CORNER.x, CORNER.y, makeEvent());

    const [startRow, endRow] = onInsertRowRangeReference.mock.calls[0] as [number, number];
    // The same converter insertRowRangeReference uses, so this is the text that
    // reaches the formula -- Excel's whole-sheet reference.
    expect(rowRangeToReference(startRow, endRow)).toBe("1:1048576");
  });

  it("is sheet-qualified when the formula is being written on another sheet", () => {
    const { handlers, onInsertRowRangeReference } = makeFormulaHandlers();
    handlers.handleFormulaCornerMouseDown(CORNER.x, CORNER.y, makeEvent());

    const [startRow, endRow] = onInsertRowRangeReference.mock.calls[0] as [number, number];
    // insertRowRangeReference passes the target/source sheet pair through to the
    // converter; the corner inherits that rule instead of restating it.
    expect(rowRangeToReference(startRow, endRow, "Data", "Sheet1")).toBe("Data!1:1048576");
    expect(rowRangeToReference(startRow, endRow, "Sheet1", "Sheet1")).toBe("1:1048576");
  });

  it("declines a non-corner pixel so the header handlers still get their turn", () => {
    const { handlers, onInsertRowRangeReference } = makeFormulaHandlers();

    expect(handlers.handleFormulaCornerMouseDown(COL_HEADER.x, COL_HEADER.y, makeEvent())).toBe(false);
    expect(handlers.handleFormulaCornerMouseDown(ROW_HEADER.x, ROW_HEADER.y, makeEvent())).toBe(false);
    expect(handlers.handleFormulaCornerMouseDown(CELL.x, CELL.y, makeEvent())).toBe(false);
    expect(onInsertRowRangeReference).not.toHaveBeenCalled();
  });

  it("declines when the host wired no row-range inserter, rather than throwing", () => {
    const { handlers } = makeFormulaHandlers({ onInsertRowRangeReference: undefined });
    expect(handlers.handleFormulaCornerMouseDown(CORNER.x, CORNER.y, makeEvent())).toBe(false);
  });
});

describe("formula mode: the corner is a click, not a drag", () => {
  it("seeds no header drag, so mouse up has nothing to re-read", () => {
    const { handlers, setIsFormulaDragging, formulaHeaderDragStartRef, lastMousePosRef } = makeFormulaHandlers();
    handlers.handleFormulaCornerMouseDown(CORNER.x, CORNER.y, makeEvent());

    expect(formulaHeaderDragStartRef.current).toBeNull();
    expect(lastMousePosRef.current).toBeNull();
    expect(setIsFormulaDragging).not.toHaveBeenCalled();
  });

  it("the mouse-up path is inert after a corner click (no second insert)", () => {
    const { handlers, onInsertRowRangeReference, onInsertRowReference } = makeFormulaHandlers();
    handlers.handleFormulaCornerMouseDown(CORNER.x, CORNER.y, makeEvent());
    handlers.handleFormulaHeaderMouseUp(vi.fn());

    expect(onInsertRowRangeReference).toHaveBeenCalledTimes(1);
    expect(onInsertRowReference).not.toHaveBeenCalled();
  });

  it("had the corner used the DRAG path, mouse up would have inserted `1:1`", () => {
    // Not a hypothetical: this is the mouse-up handler the row header uses, fed
    // a corner pixel. getRowFromHeader answers null there, so `finalRow` falls
    // back to the start index and the whole sheet collapses to a single row --
    // a silently wrong reference. This is why the corner inserts on mouse down.
    const { handlers, onInsertRowReference, onInsertRowRangeReference, formulaHeaderDragStartRef, lastMousePosRef } =
      makeFormulaHandlers();
    formulaHeaderDragStartRef.current = { type: "row", index: 0 };
    lastMousePosRef.current = { x: CORNER.x, y: CORNER.y };

    handlers.handleFormulaHeaderMouseUp(vi.fn());

    expect(onInsertRowReference).toHaveBeenCalledWith(0);
    expect(onInsertRowRangeReference).not.toHaveBeenCalled();
  });
});

describe("normal mode: a corner click selects the whole sheet", () => {
  it("selects A1 to the last cell in ONE dispatch", async () => {
    const { handlers, onSelectCell } = makeSelectionHandlers();
    const event = makeEvent();

    expect(await handlers.handleSelectAllCornerMouseDown(CORNER.x, CORNER.y, event)).toBe(true);
    // One call, carrying endRow/endCol: a select-then-extend pair scrolls to the
    // end of the sheet on the way through.
    expect(onSelectCell).toHaveBeenCalledTimes(1);
    expect(onSelectCell).toHaveBeenCalledWith(0, 0, "cells", CONFIG.totalRows - 1, CONFIG.totalCols - 1);
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it("commits a pending edit BEFORE selecting", async () => {
    const { handlers, calls } = makeSelectionHandlers();
    await handlers.handleSelectAllCornerMouseDown(CORNER.x, CORNER.y, makeEvent());
    expect(calls).toEqual(["commit", "select"]);
  });

  it("declines a non-corner pixel", async () => {
    const { handlers, onSelectCell } = makeSelectionHandlers();
    expect(await handlers.handleSelectAllCornerMouseDown(CELL.x, CELL.y, makeEvent())).toBe(false);
    expect(onSelectCell).not.toHaveBeenCalled();
  });
});

describe("the whole-sheet highlight is bounded", () => {
  it("caps a 1,048,576-row reference to the painter's row budget", () => {
    // drawFormulaReferences measures the rectangle by adding up getRowHeight over
    // the whole extent, every frame; the hit test does the same on every mouse
    // move. Uncapped, one corner click costs a million lookups per repaint.
    expect(cappedHighlightEndRow(0, CONFIG.totalRows - 1)).toBe(MAX_FORMULA_REFERENCE_ROWS - 1);
  });

  it("caps the EXTENT, so an ordinary row drag keeps its own origin", () => {
    // A cap to an absolute row would drag a highlight of rows 5001-6000 up to
    // rows 1-1000 and point the user at the wrong data.
    expect(cappedHighlightEndRow(5000, 5999)).toBe(5999);
    expect(cappedHighlightEndRow(5000, 999999)).toBe(5000 + MAX_FORMULA_REFERENCE_ROWS - 1);
  });

  it("normalises a backwards range", () => {
    expect(cappedHighlightEndRow(9, 4)).toBe(9);
  });
});
