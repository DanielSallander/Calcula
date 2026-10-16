//! FILENAME: app/extensions/Pivot/lib/__tests__/pivotVisualCellSelection.test.ts
// PURPOSE: The canvas pivot box's inner cell selection store (D-CELLS, WP-A S5):
//          anchor / extend / set / clear / clamp, the normalized rectangle and
//          its hidden-grid mapping, the listeners -- and the SHEET_CHANGED rule:
//          a detail-less announcement on the SAME active sheet keeps the cells
//          (WP-B's hide/unhide of another page, a "sheets" refresh), a
//          different active sheet clears them.

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  clampPivotCellSelection,
  clearPivotCellSelection,
  clearPivotCellSelectionIfSheetChanged,
  extendPivotCellSelection,
  getPivotCellSelection,
  hasPivotCellSelection,
  isViewCellSelected,
  onPivotCellSelectionChanged,
  pivotCellGridRange,
  pivotCellRect,
  resetPivotCellSelection,
  setPivotCellAnchor,
  setPivotCellSelection,
  setPivotCellSheetSource,
} from "../pivotVisualCellSelection";

let activeSheet: number | undefined = 2;
let restoreSource: () => void = () => {};

beforeEach(() => {
  restoreSource();
  resetPivotCellSelection();
  activeSheet = 2;
  restoreSource = setPivotCellSheetSource(() => activeSheet);
});

describe("set / extend / clear", () => {
  it("an anchor is a one-cell selection; extend moves only the END; clear empties it", () => {
    expect(hasPivotCellSelection()).toBe(false);
    setPivotCellAnchor("p1", 3, 1);
    expect(getPivotCellSelection()).toEqual({ pivotId: "p1", anchorRow: 3, anchorCol: 1, endRow: 3, endCol: 1 });
    extendPivotCellSelection(1, 4);
    expect(getPivotCellSelection()).toEqual({ pivotId: "p1", anchorRow: 3, anchorCol: 1, endRow: 1, endCol: 4 });
    clearPivotCellSelection();
    expect(getPivotCellSelection()).toBeNull();
    expect(hasPivotCellSelection()).toBe(false);
  });

  it("extend without a selection does nothing; malformed indexes are refused", () => {
    extendPivotCellSelection(2, 2);
    expect(getPivotCellSelection()).toBeNull();
    setPivotCellAnchor("p1", -1, 0);
    setPivotCellAnchor("p1", 1.5, 0);
    setPivotCellAnchor("", 1, 0);
    expect(getPivotCellSelection()).toBeNull();
    setPivotCellAnchor("p1", 2, 2);
    extendPivotCellSelection(Number.NaN, 1);
    expect(getPivotCellSelection()?.endRow).toBe(2);
  });

  it("setPivotCellSelection replaces the whole selection, null clears", () => {
    setPivotCellSelection({ pivotId: "p1", anchorRow: 0, anchorCol: 0, endRow: 9, endCol: 3 });
    expect(pivotCellRect(getPivotCellSelection()!)).toEqual({ startRow: 0, startCol: 0, endRow: 9, endCol: 3 });
    setPivotCellSelection(null);
    expect(getPivotCellSelection()).toBeNull();
  });

  it("the getter hands out a COPY: writing to it changes nothing", () => {
    setPivotCellAnchor("p1", 1, 1);
    const got = getPivotCellSelection()!;
    got.endRow = 99;
    expect(getPivotCellSelection()!.endRow).toBe(1);
  });
});

describe("the rectangle", () => {
  it("is normalized whichever way the drag went, and isViewCellSelected reads it", () => {
    setPivotCellAnchor("p1", 5, 3);
    extendPivotCellSelection(2, 1);
    expect(pivotCellRect(getPivotCellSelection()!)).toEqual({ startRow: 2, startCol: 1, endRow: 5, endCol: 3 });
    expect(isViewCellSelected(2, 1)).toBe(true);
    expect(isViewCellSelected(5, 3)).toBe(true);
    expect(isViewCellSelected(4, 2)).toBe(true);
    expect(isViewCellSelected(6, 2)).toBe(false);
    expect(isViewCellSelected(3, 0)).toBe(false);
    clearPivotCellSelection();
    expect(isViewCellSelected(3, 2)).toBe(false);
  });

  it("maps to the hidden grid by the pivot's anchor cell (a box in column block 1)", () => {
    setPivotCellAnchor("p1", 4, 2);
    extendPivotCellSelection(1, 0);
    expect(pivotCellGridRange(getPivotCellSelection()!, 0, 1024)).toEqual({
      startRow: 1,
      startCol: 1024,
      endRow: 4,
      endCol: 1026,
    });
    expect(pivotCellGridRange(getPivotCellSelection()!, 3, 5)).toEqual({ startRow: 4, startCol: 5, endRow: 7, endCol: 7 });
  });
});

describe("clamp to a new view", () => {
  it("clamps the END into the new size and keeps the anchor", () => {
    setPivotCellAnchor("p1", 2, 1);
    extendPivotCellSelection(20, 6);
    clampPivotCellSelection("p1", 10, 4);
    expect(getPivotCellSelection()).toEqual({ pivotId: "p1", anchorRow: 2, anchorCol: 1, endRow: 9, endCol: 3 });
  });

  it("clears when the ANCHOR falls outside (the active cell no longer exists), or the view is empty", () => {
    setPivotCellAnchor("p1", 12, 1);
    clampPivotCellSelection("p1", 10, 4);
    expect(getPivotCellSelection()).toBeNull();
    setPivotCellAnchor("p1", 1, 5);
    clampPivotCellSelection("p1", 10, 4);
    expect(getPivotCellSelection()).toBeNull();
    setPivotCellAnchor("p1", 0, 0);
    clampPivotCellSelection("p1", 0, 0);
    expect(getPivotCellSelection()).toBeNull();
  });

  it("another pivot's view changes nothing", () => {
    setPivotCellAnchor("p1", 12, 1);
    clampPivotCellSelection("p2", 1, 1);
    expect(getPivotCellSelection()?.anchorRow).toBe(12);
  });
});

describe("listeners", () => {
  it("hear every CHANGE once, and nothing for a no-op", () => {
    const heard = vi.fn();
    const off = onPivotCellSelectionChanged(heard);
    setPivotCellAnchor("p1", 1, 1);
    setPivotCellAnchor("p1", 1, 1); // same: silent
    extendPivotCellSelection(2, 2);
    extendPivotCellSelection(2, 2); // same: silent
    clampPivotCellSelection("p1", 50, 50); // unchanged: silent
    clearPivotCellSelection();
    clearPivotCellSelection(); // nothing to clear: silent
    expect(heard).toHaveBeenCalledTimes(3);
    off();
    setPivotCellAnchor("p1", 3, 3);
    expect(heard).toHaveBeenCalledTimes(3);
  });

  it("a throwing listener does not stop the others", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const second = vi.fn();
    const offA = onPivotCellSelectionChanged(() => {
      throw new Error("boom");
    });
    const offB = onPivotCellSelectionChanged(second);
    setPivotCellAnchor("p1", 0, 0);
    expect(second).toHaveBeenCalledTimes(1);
    offA();
    offB();
    err.mockRestore();
  });

  it("reset clears and tells the listeners, who stay subscribed", () => {
    const heard = vi.fn();
    const off = onPivotCellSelectionChanged(heard);
    setPivotCellAnchor("p1", 0, 0);
    resetPivotCellSelection();
    expect(getPivotCellSelection()).toBeNull();
    expect(heard).toHaveBeenCalledTimes(2);
    setPivotCellAnchor("p1", 1, 0);
    expect(heard).toHaveBeenCalledTimes(3);
    off();
  });
});

describe("SHEET_CHANGED: clear only when the ACTIVE sheet changed", () => {
  it("a detail-less announcement on the SAME active sheet keeps the cells", () => {
    setPivotCellAnchor("p1", 2, 2);
    extendPivotCellSelection(4, 3);
    // No index in the event: the source (the grid snapshot) says sheet 2 still.
    expect(clearPivotCellSelectionIfSheetChanged()).toBe(false);
    expect(getPivotCellSelection()).toEqual({ pivotId: "p1", anchorRow: 2, anchorCol: 2, endRow: 4, endCol: 3 });
    // An event that names the same index: kept too.
    expect(clearPivotCellSelectionIfSheetChanged(2)).toBe(false);
    expect(hasPivotCellSelection()).toBe(true);
  });

  it("a DIFFERENT active sheet clears them -- named in the event, or read from the source", () => {
    setPivotCellAnchor("p1", 2, 2);
    expect(clearPivotCellSelectionIfSheetChanged(3)).toBe(true);
    expect(getPivotCellSelection()).toBeNull();

    setPivotCellAnchor("p1", 2, 2);
    activeSheet = 0;
    expect(clearPivotCellSelectionIfSheetChanged()).toBe(true);
    expect(getPivotCellSelection()).toBeNull();
  });

  it("the sheet is the one the selection was MADE on (an extend does not re-stamp it)", () => {
    setPivotCellAnchor("p1", 1, 1);
    activeSheet = 5; // e.g. the snapshot moved on; the selection was made on 2
    extendPivotCellSelection(3, 3);
    expect(clearPivotCellSelectionIfSheetChanged(2)).toBe(false);
    expect(clearPivotCellSelectionIfSheetChanged(5)).toBe(true);
  });

  it("when the sheet cannot be told, the cells go (a selection must not outlive a page the user left)", () => {
    activeSheet = undefined;
    setPivotCellAnchor("p1", 1, 1);
    expect(clearPivotCellSelectionIfSheetChanged()).toBe(true);
    expect(getPivotCellSelection()).toBeNull();
  });

  it("nothing selected: nothing to clear", () => {
    expect(clearPivotCellSelectionIfSheetChanged(7)).toBe(false);
  });
});
