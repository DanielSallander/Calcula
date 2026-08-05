//! FILENAME: app/src/shell/registries/__tests__/gridHideMenuItems.test.ts
// PURPOSE: The right-click Hide/Unhide items must drive the BACKEND authority,
//          and Unhide must offer itself only for USER hides.
// CONTEXT: All four used to dispatch a window CustomEvent into the grid reducer
//          and nothing else, so the hide never reached the file, was not
//          undoable, and left the document clean.

import { describe, it, expect, vi, beforeEach } from "vitest";

const applyRowsHidden = vi.fn().mockResolvedValue(true);
const applyColsHidden = vi.fn().mockResolvedValue(true);

vi.mock("../../../core/lib/hiddenRowsCols", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../core/lib/hiddenRowsCols")>();
  return {
    ...actual,
    applyRowsHidden: (...args: unknown[]) => applyRowsHidden(...args),
    applyColsHidden: (...args: unknown[]) => applyColsHidden(...args),
  };
});

import { gridExtensions, registerCoreGridContextMenu, type GridMenuContext } from "../gridExtensions";
import { createEmptyDimensionOverrides } from "../../../core/types";
import type { DimensionOverrides, Selection } from "../../../core/types";

function context(
  selection: Selection | null,
  dimensions: Partial<DimensionOverrides> = {}
): GridMenuContext {
  return {
    selection,
    clickedCell: selection ? { row: selection.startRow, col: selection.startCol } : null,
    isWithinSelection: true,
    sheetIndex: 0,
    sheetName: "Sheet1",
    dimensions: { ...createEmptyDimensionOverrides(), ...dimensions },
  };
}

function rowSelection(startRow: number, endRow: number): Selection {
  return { startRow, endRow, startCol: 0, endCol: 0, type: "rows" };
}

function colSelection(startCol: number, endCol: number): Selection {
  return { startRow: 0, endRow: 0, startCol, endCol, type: "columns" };
}

function item(id: string) {
  const found = gridExtensions.getContextMenuItems().find((i) => i.id === id);
  if (!found) throw new Error(`menu item ${id} not registered`);
  return found;
}

function isVisible(id: string, ctx: GridMenuContext): boolean {
  const { visible } = item(id);
  if (visible === undefined) return true;
  return typeof visible === "function" ? visible(ctx) : visible;
}

beforeEach(() => {
  vi.clearAllMocks();
  gridExtensions.clear();
  registerCoreGridContextMenu();
});

describe("Hide rows / columns", () => {
  it("Hide rows sends the whole selected span to the backend", async () => {
    await item("core:hideRows").onClick(context(rowSelection(3, 6)));

    expect(applyRowsHidden).toHaveBeenCalledTimes(1);
    expect(applyRowsHidden.mock.calls[0][0]).toEqual([3, 4, 5, 6]);
    expect(applyRowsHidden.mock.calls[0][1]).toBe(true);
  });

  it("Hide rows normalizes a bottom-up selection", async () => {
    await item("core:hideRows").onClick(context(rowSelection(6, 3)));

    expect(applyRowsHidden.mock.calls[0][0]).toEqual([3, 4, 5, 6]);
  });

  it("Hide columns sends the whole selected span to the backend", async () => {
    await item("core:hideCols").onClick(context(colSelection(1, 2)));

    expect(applyColsHidden).toHaveBeenCalledTimes(1);
    expect(applyColsHidden.mock.calls[0][0]).toEqual([1, 2]);
    expect(applyColsHidden.mock.calls[0][1]).toBe(true);
  });

  it("Unhide rows sends hidden:false for the span", async () => {
    await item("core:unhideRows").onClick(
      context(rowSelection(1, 3), { manuallyHiddenRows: new Set([2]) })
    );

    expect(applyRowsHidden.mock.calls[0][0]).toEqual([1, 2, 3]);
    expect(applyRowsHidden.mock.calls[0][1]).toBe(false);
  });

  it("Unhide columns sends hidden:false for the span", async () => {
    await item("core:unhideCols").onClick(
      context(colSelection(0, 4), { manuallyHiddenCols: new Set([2]) })
    );

    expect(applyColsHidden.mock.calls[0][0]).toEqual([0, 1, 2, 3, 4]);
    expect(applyColsHidden.mock.calls[0][1]).toBe(false);
  });

  it("no backend call without a row/column selection", async () => {
    await item("core:hideRows").onClick(context(null));
    await item("core:hideCols").onClick(context(null));

    expect(applyRowsHidden).not.toHaveBeenCalled();
    expect(applyColsHidden).not.toHaveBeenCalled();
  });
});

describe("Unhide visibility predicate reads the user-hidden mirror", () => {
  it("hidden only for a rows selection", () => {
    expect(isVisible("core:hideRows", context(rowSelection(0, 0)))).toBe(true);
    expect(isVisible("core:hideRows", context(colSelection(0, 0)))).toBe(false);
    expect(isVisible("core:hideCols", context(colSelection(0, 0)))).toBe(true);
    expect(isVisible("core:hideCols", context(rowSelection(0, 0)))).toBe(false);
  });

  it("Unhide hides itself when nothing is user-hidden", () => {
    expect(isVisible("core:unhideRows", context(rowSelection(0, 9)))).toBe(false);
    expect(isVisible("core:unhideCols", context(colSelection(0, 9)))).toBe(false);
  });

  it("Unhide appears for a user-hidden row inside the span", () => {
    const ctx = context(rowSelection(0, 9), { manuallyHiddenRows: new Set([5]) });
    expect(isVisible("core:unhideRows", ctx)).toBe(true);
  });

  it("Unhide appears for a row sandwiched between two selected rows", () => {
    // Excel: select rows 1 and 3 to unhide row 2.
    const ctx = context(rowSelection(0, 2), { manuallyHiddenRows: new Set([1]) });
    expect(isVisible("core:unhideRows", ctx)).toBe(true);
  });

  it("Unhide stays hidden for a user hide OUTSIDE the span", () => {
    const ctx = context(rowSelection(0, 3), { manuallyHiddenRows: new Set([50]) });
    expect(isVisible("core:unhideRows", ctx)).toBe(false);
  });

  it("Unhide is NOT offered for a filter-hidden row — clearing the filter is", () => {
    const ctx = context(rowSelection(0, 9), {
      filterHiddenRows: new Set([5]),
      hiddenRows: new Set([5]),
    });
    expect(isVisible("core:unhideRows", ctx)).toBe(false);
  });

  it("Unhide is NOT offered for an outline-collapsed row", () => {
    const ctx = context(rowSelection(0, 9), {
      groupHiddenRows: new Set([5]),
      hiddenRows: new Set([5]),
    });
    expect(isVisible("core:unhideRows", ctx)).toBe(false);
  });

  it("columns: user-hidden inside the span shows Unhide, group-hidden does not", () => {
    expect(
      isVisible("core:unhideCols", context(colSelection(0, 5), { manuallyHiddenCols: new Set([3]) }))
    ).toBe(true);
    expect(
      isVisible("core:unhideCols", context(colSelection(0, 5), {
        groupHiddenCols: new Set([3]),
        hiddenCols: new Set([3]),
      }))
    ).toBe(false);
  });
});
