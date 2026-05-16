//! FILENAME: app/extensions/Charts/rendering/__tests__/quickAccessButtons.deep.test.ts
// PURPOSE: Deep tests for quick access button layout, hit testing, and popup state.

import { describe, it, expect, beforeEach } from "vitest";
import {
  computeQuickAccessButtons,
  hitTestQuickAccessButtons,
  isInQuickAccessArea,
  togglePopup,
  closePopup,
  getActivePopup,
  setHoveredButton,
  getHoveredButton,
} from "../quickAccessButtons";

// ============================================================================
// computeQuickAccessButtons
// ============================================================================

describe("computeQuickAccessButtons", () => {
  it("returns exactly 3 buttons", () => {
    const buttons = computeQuickAccessButtons(100, 50, 400, 300);
    expect(buttons).toHaveLength(3);
  });

  it("positions buttons to the right of chart", () => {
    const buttons = computeQuickAccessButtons(100, 50, 400, 300);
    for (const btn of buttons) {
      expect(btn.x).toBeGreaterThan(100 + 400); // right of chart
    }
  });

  it("stacks buttons vertically", () => {
    const buttons = computeQuickAccessButtons(100, 50, 400, 300);
    expect(buttons[0].y).toBeLessThan(buttons[1].y);
    expect(buttons[1].y).toBeLessThan(buttons[2].y);
  });

  it("assigns correct types: elements, styles, filters", () => {
    const buttons = computeQuickAccessButtons(100, 50, 400, 300);
    expect(buttons[0].type).toBe("elements");
    expect(buttons[1].type).toBe("styles");
    expect(buttons[2].type).toBe("filters");
  });

  it("all buttons have same width and height", () => {
    const buttons = computeQuickAccessButtons(100, 50, 400, 300);
    const w = buttons[0].width;
    const h = buttons[0].height;
    for (const btn of buttons) {
      expect(btn.width).toBe(w);
      expect(btn.height).toBe(h);
    }
  });

  it("adjusts X position based on chart position and width", () => {
    const a = computeQuickAccessButtons(0, 0, 200, 200);
    const b = computeQuickAccessButtons(100, 0, 300, 200);
    expect(b[0].x).toBeGreaterThan(a[0].x);
  });
});

// ============================================================================
// hitTestQuickAccessButtons
// ============================================================================

describe("hitTestQuickAccessButtons", () => {
  const buttons = computeQuickAccessButtons(100, 50, 400, 300);

  it("returns 'elements' when clicking on first button", () => {
    const btn = buttons[0];
    const result = hitTestQuickAccessButtons(btn.x + 5, btn.y + 5, buttons);
    expect(result).toBe("elements");
  });

  it("returns 'styles' when clicking on second button", () => {
    const btn = buttons[1];
    const result = hitTestQuickAccessButtons(btn.x + 5, btn.y + 5, buttons);
    expect(result).toBe("styles");
  });

  it("returns 'filters' when clicking on third button", () => {
    const btn = buttons[2];
    const result = hitTestQuickAccessButtons(btn.x + 5, btn.y + 5, buttons);
    expect(result).toBe("filters");
  });

  it("returns null when clicking outside all buttons", () => {
    const result = hitTestQuickAccessButtons(0, 0, buttons);
    expect(result).toBeNull();
  });

  it("returns null for point between buttons (in gap)", () => {
    const btn0 = buttons[0];
    const btn1 = buttons[1];
    const gapY = btn0.y + btn0.height + 1; // just past first button
    if (gapY < btn1.y) {
      const result = hitTestQuickAccessButtons(btn0.x + 5, gapY, buttons);
      expect(result).toBeNull();
    }
  });

  it("detects hit at exact button edges", () => {
    const btn = buttons[0];
    expect(hitTestQuickAccessButtons(btn.x, btn.y, buttons)).toBe("elements");
    expect(hitTestQuickAccessButtons(btn.x + btn.width, btn.y + btn.height, buttons)).toBe("elements");
  });
});

// ============================================================================
// isInQuickAccessArea
// ============================================================================

describe("isInQuickAccessArea", () => {
  it("returns true for point within chart bounds", () => {
    expect(isInQuickAccessArea(200, 100, 100, 50, 400, 300)).toBe(true);
  });

  it("returns true for point in button area to the right", () => {
    // Button area extends past chart right edge
    expect(isInQuickAccessArea(510, 100, 100, 50, 400, 300)).toBe(true);
  });

  it("returns false for point above chart", () => {
    expect(isInQuickAccessArea(200, 40, 100, 50, 400, 300)).toBe(false);
  });

  it("returns false for point below chart", () => {
    expect(isInQuickAccessArea(200, 360, 100, 50, 400, 300)).toBe(false);
  });

  it("returns false for point to the left of chart", () => {
    expect(isInQuickAccessArea(90, 100, 100, 50, 400, 300)).toBe(false);
  });

  it("returns false for point far to the right of button area", () => {
    expect(isInQuickAccessArea(600, 100, 100, 50, 400, 300)).toBe(false);
  });
});

// ============================================================================
// Popup State Management
// ============================================================================

describe("popup state management", () => {
  beforeEach(() => {
    closePopup();
  });

  it("starts with no active popup", () => {
    expect(getActivePopup()).toBeNull();
  });

  it("togglePopup opens a popup", () => {
    const result = togglePopup(1, "elements", 500, 100);
    expect(result).not.toBeNull();
    expect(result!.chartId).toBe(1);
    expect(result!.buttonType).toBe("elements");
  });

  it("togglePopup closes popup when toggling same button", () => {
    togglePopup(1, "elements", 500, 100);
    const result = togglePopup(1, "elements", 500, 100);
    expect(result).toBeNull();
  });

  it("togglePopup switches to different button", () => {
    togglePopup(1, "elements", 500, 100);
    const result = togglePopup(1, "styles", 500, 130);
    expect(result!.buttonType).toBe("styles");
  });

  it("closePopup clears state", () => {
    togglePopup(1, "filters", 500, 160);
    closePopup();
    expect(getActivePopup()).toBeNull();
  });
});

// ============================================================================
// Hovered Button State
// ============================================================================

describe("hovered button state", () => {
  beforeEach(() => {
    setHoveredButton(null);
  });

  it("starts with no hovered button", () => {
    expect(getHoveredButton()).toBeNull();
  });

  it("tracks hovered button", () => {
    setHoveredButton("elements");
    expect(getHoveredButton()).toBe("elements");
  });

  it("clears hovered button", () => {
    setHoveredButton("styles");
    setHoveredButton(null);
    expect(getHoveredButton()).toBeNull();
  });
});
