//! FILENAME: app/extensions/ConditionalFormatting/lib/__tests__/cfStoreIconAlign.test.ts
// PURPOSE: BUG-0728 (icon part) -- after an evaluation the store reads the
//          horizontal alignment of every Show Icon Only cell, so the overlay
//          can place the icon as Excel does; nothing is read when no such cell
//          is in view, and an older read never overwrites a newer one.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  rules: [] as unknown[],
  cells: [] as unknown[],
  getViewportCells: vi.fn(),
  getStyle: vi.fn(),
  redraw: vi.fn(),
}));

vi.mock("@api", () => ({
  getAllConditionalFormats: async () => h.rules,
  evaluateConditionalFormats: async () => ({ cells: h.cells }),
  emitAppEvent: vi.fn(),
  AppEvents: {},
  addGridRegions: vi.fn(),
  removeGridRegionsByType: vi.fn(),
  requestOverlayRedraw: () => h.redraw(),
  markSheetDirty: vi.fn(),
}));
vi.mock("@api/lib", () => ({
  getViewportCells: (...a: unknown[]) => h.getViewportCells(...a),
  getStyle: (...a: unknown[]) => h.getStyle(...a),
}));

import { refreshRules, evaluateViewport, getIconAlignForCell, resetState } from "../cfStore";

const ICON_RULE = { id: 1, rule: { type: "iconSet" }, ranges: [{ startRow: 0, startCol: 0, endRow: 9, endCol: 9 }] };

beforeEach(async () => {
  resetState();
  h.rules = [ICON_RULE];
  h.cells = [];
  h.getViewportCells.mockReset();
  h.getStyle.mockReset();
  h.redraw.mockReset();
  h.getStyle.mockImplementation(async (i: number) => ({ textAlign: i === 5 ? "center" : i === 6 ? "right" : "general" }));
  await refreshRules();
});

describe("the Show Icon Only cells' alignment", () => {
  it("is read for icon-only cells and kept when it is centre or right", async () => {
    h.cells = [
      { row: 2, col: 3, format: {}, iconIndex: 1, iconSet: "threeArrows", hideValue: true },
      { row: 4, col: 3, format: {}, iconIndex: 0, iconSet: "threeArrows", hideValue: true },
      { row: 6, col: 3, format: {}, iconIndex: 0, iconSet: "threeArrows", hideValue: true },
    ];
    h.getViewportCells.mockResolvedValue([
      { row: 2, col: 3, styleIndex: 5 },
      { row: 4, col: 3, styleIndex: 6 },
      { row: 6, col: 3, styleIndex: 0 },
    ]);
    await evaluateViewport(0, 0, 9, 9);
    expect(h.getViewportCells).toHaveBeenCalledWith(2, 3, 6, 3);
    expect(getIconAlignForCell(2, 3)).toBe("center");
    expect(getIconAlignForCell(4, 3)).toBe("right");
    expect(getIconAlignForCell(6, 3)).toBeUndefined();
    expect(h.redraw).toHaveBeenCalled();
  });

  it("reads nothing when every icon shows its value", async () => {
    h.cells = [{ row: 2, col: 3, format: {}, iconIndex: 1, iconSet: "threeArrows" }];
    await evaluateViewport(0, 0, 9, 9);
    expect(h.getViewportCells).not.toHaveBeenCalled();
    expect(getIconAlignForCell(2, 3)).toBeUndefined();
  });

  it("an older, slower read never overwrites a newer one", async () => {
    h.cells = [{ row: 2, col: 3, format: {}, iconIndex: 1, iconSet: "threeArrows", hideValue: true }];
    let releaseFirst: (v: unknown) => void = () => {};
    h.getViewportCells
      .mockImplementationOnce(() => new Promise((r) => (releaseFirst = r)))
      .mockResolvedValueOnce([{ row: 2, col: 3, styleIndex: 6 }]);
    const first = evaluateViewport(0, 0, 9, 9);
    // Let the first evaluation reach its (held) read before the second starts.
    for (let i = 0; i < 50 && h.getViewportCells.mock.calls.length === 0; i++) await Promise.resolve();
    expect(h.getViewportCells).toHaveBeenCalledTimes(1);
    await evaluateViewport(0, 0, 9, 9);
    expect(getIconAlignForCell(2, 3)).toBe("right");
    releaseFirst([{ row: 2, col: 3, styleIndex: 5 }]);
    await first;
    expect(getIconAlignForCell(2, 3)).toBe("right");
  });
});
