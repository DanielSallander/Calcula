//! FILENAME: app/extensions/DataValidation/lib/__tests__/chevronGeometry.test.ts
// PURPOSE: The chevron rectangle is the contract between what is PAINTED and
//          what a click CLAIMS. These tests pin that rectangle.

import { describe, it, expect } from "vitest";
import {
  CHEVRON_BUTTON_MARGIN,
  CHEVRON_BUTTON_SIZE,
  getChevronRect,
  isPointInChevron,
  isPointInRect,
} from "../chevronGeometry";

const CELL = { x: 350, y: 64, width: 100, height: 20 };

describe("getChevronRect", () => {
  it("hugs the cell's right edge, inset by the margin", () => {
    const rect = getChevronRect(CELL);
    expect(rect).toEqual({
      x: 350 + 100 - CHEVRON_BUTTON_SIZE - CHEVRON_BUTTON_MARGIN,
      y: 64 + CHEVRON_BUTTON_MARGIN,
      width: CHEVRON_BUTTON_SIZE,
      height: 20 - CHEVRON_BUTTON_MARGIN * 2,
    });
  });

  it("is clamped to the cell for columns narrower than the button", () => {
    const rect = getChevronRect({ x: 10, y: 0, width: 8, height: 20 });
    expect(rect.x).toBe(10);
    expect(rect.width).toBe(7); // 8 - margin
    expect(rect.x + rect.width).toBeLessThanOrEqual(18);
  });

  it("collapses to an empty rectangle for a hidden (zero-height) row", () => {
    const rect = getChevronRect({ x: 0, y: 0, width: 100, height: 0 });
    expect(rect.height).toBe(0);
  });
});

describe("isPointInChevron", () => {
  it("claims a point inside the button", () => {
    expect(isPointInChevron(440, 70, CELL)).toBe(true);
  });

  it("claims the button's edges", () => {
    expect(isPointInChevron(431, 65, CELL)).toBe(true);
    expect(isPointInChevron(449, 83, CELL)).toBe(true);
  });

  it("does NOT claim the cell body left of the button", () => {
    expect(isPointInChevron(430, 70, CELL)).toBe(false);
    expect(isPointInChevron(351, 70, CELL)).toBe(false);
    expect(isPointInChevron(400, 74, CELL)).toBe(false);
  });

  it("does NOT claim points outside the cell", () => {
    expect(isPointInChevron(460, 70, CELL)).toBe(false);
    expect(isPointInChevron(440, 90, CELL)).toBe(false);
    expect(isPointInChevron(440, 60, CELL)).toBe(false);
  });

  it("never claims anything in a zero-height cell", () => {
    expect(isPointInChevron(440, 64, { ...CELL, height: 0 })).toBe(false);
  });
});

describe("isPointInRect", () => {
  it("rejects empty rectangles", () => {
    expect(isPointInRect(0, 0, { x: 0, y: 0, width: 0, height: 10 })).toBe(false);
    expect(isPointInRect(0, 0, { x: 0, y: 0, width: 10, height: 0 })).toBe(false);
  });
});
