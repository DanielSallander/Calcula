//! FILENAME: app/extensions/Charts/rendering/__tests__/quickAccessButtons.test.ts
// PURPOSE: Tests for quick access button computation and hit testing.

import { describe, it, expect, beforeEach } from "vitest";
import {
  computeQuickAccessButtons,
  hitTestQuickAccessButtons,
  isInQuickAccessArea,
  togglePopup,
  getActivePopup,
  closePopup,
  setHoveredButton,
  getHoveredButton,
} from "../quickAccessButtons";

// ============================================================================
// Button Computation Tests
// ============================================================================

describe("computeQuickAccessButtons", () => {
  it("returns exactly 3 buttons", () => {
    const buttons = computeQuickAccessButtons(100, 50, 400, 300);
    expect(buttons).toHaveLength(3);
  });

  it("positions buttons to the right of the chart", () => {
    const chartX = 100;
    const chartWidth = 400;
    const buttons = computeQuickAccessButtons(chartX, 50, chartWidth, 300);

    for (const btn of buttons) {
      expect(btn.x).toBeGreaterThan(chartX + chartWidth);
    }
  });

  it("creates elements, styles, and filters buttons in order", () => {
    const buttons = computeQuickAccessButtons(100, 50, 400, 300);
    expect(buttons[0].type).toBe("elements");
    expect(buttons[1].type).toBe("styles");
    expect(buttons[2].type).toBe("filters");
  });

  it("stacks buttons vertically", () => {
    const buttons = computeQuickAccessButtons(100, 50, 400, 300);
    expect(buttons[0].y).toBeLessThan(buttons[1].y);
    expect(buttons[1].y).toBeLessThan(buttons[2].y);
  });

  it("all buttons have the same x position", () => {
    const buttons = computeQuickAccessButtons(100, 50, 400, 300);
    expect(buttons[0].x).toBe(buttons[1].x);
    expect(buttons[1].x).toBe(buttons[2].x);
  });

  it("buttons have positive width and height", () => {
    const buttons = computeQuickAccessButtons(100, 50, 400, 300);
    for (const btn of buttons) {
      expect(btn.width).toBeGreaterThan(0);
      expect(btn.height).toBeGreaterThan(0);
    }
  });
});

// ============================================================================
// Hit Testing Tests
// ============================================================================

describe("hitTestQuickAccessButtons", () => {
  const buttons = computeQuickAccessButtons(100, 50, 400, 300);

  it("returns null when not over any button", () => {
    expect(hitTestQuickAccessButtons(0, 0, buttons)).toBeNull();
    expect(hitTestQuickAccessButtons(200, 200, buttons)).toBeNull();
  });

  it("detects hit on the elements button", () => {
    const btn = buttons[0];
    const result = hitTestQuickAccessButtons(btn.x + 5, btn.y + 5, buttons);
    expect(result).toBe("elements");
  });

  it("detects hit on the styles button", () => {
    const btn = buttons[1];
    const result = hitTestQuickAccessButtons(btn.x + 5, btn.y + 5, buttons);
    expect(result).toBe("styles");
  });

  it("detects hit on the filters button", () => {
    const btn = buttons[2];
    const result = hitTestQuickAccessButtons(btn.x + 5, btn.y + 5, buttons);
    expect(result).toBe("filters");
  });

  it("detects hit on button edges", () => {
    const btn = buttons[0];
    // Top-left corner
    expect(hitTestQuickAccessButtons(btn.x, btn.y, buttons)).toBe("elements");
    // Bottom-right corner
    expect(hitTestQuickAccessButtons(btn.x + btn.width, btn.y + btn.height, buttons)).toBe("elements");
  });

  it("returns null just outside button bounds", () => {
    const btn = buttons[0];
    expect(hitTestQuickAccessButtons(btn.x - 1, btn.y, buttons)).toBeNull();
    expect(hitTestQuickAccessButtons(btn.x, btn.y - 1, buttons)).toBeNull();
  });
});

// ============================================================================
// Extended Area Tests
// ============================================================================

describe("isInQuickAccessArea", () => {
  it("returns true within chart bounds", () => {
    expect(isInQuickAccessArea(150, 100, 100, 50, 400, 300)).toBe(true);
  });

  it("returns true in the button area to the right", () => {
    // Right of chart, where buttons are drawn
    expect(isInQuickAccessArea(510, 100, 100, 50, 400, 300)).toBe(true);
  });

  it("returns false outside the extended area", () => {
    // Way to the right, past buttons
    expect(isInQuickAccessArea(600, 100, 100, 50, 400, 300)).toBe(false);
    // Above the chart
    expect(isInQuickAccessArea(150, 30, 100, 50, 400, 300)).toBe(false);
  });
});

// ============================================================================
// Popup State Tests
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
    expect(getActivePopup()).not.toBeNull();
  });

  it("togglePopup closes when clicking the same button", () => {
    togglePopup(1, "elements", 500, 100);
    const result = togglePopup(1, "elements", 500, 100);
    expect(result).toBeNull();
    expect(getActivePopup()).toBeNull();
  });

  it("togglePopup switches to a different button", () => {
    togglePopup(1, "elements", 500, 100);
    const result = togglePopup(1, "styles", 500, 130);
    expect(result).not.toBeNull();
    expect(result!.buttonType).toBe("styles");
  });

  it("togglePopup switches to a different chart", () => {
    togglePopup(1, "elements", 500, 100);
    const result = togglePopup(2, "elements", 800, 100);
    expect(result).not.toBeNull();
    expect(result!.chartId).toBe(2);
  });

  it("closePopup clears the popup", () => {
    togglePopup(1, "filters", 500, 160);
    closePopup();
    expect(getActivePopup()).toBeNull();
  });
});

// ============================================================================
// Hover State Tests
// ============================================================================

describe("hover state", () => {
  it("starts with no hovered button", () => {
    setHoveredButton(null);
    expect(getHoveredButton()).toBeNull();
  });

  it("can set and get hovered button", () => {
    setHoveredButton("elements");
    expect(getHoveredButton()).toBe("elements");

    setHoveredButton("styles");
    expect(getHoveredButton()).toBe("styles");

    setHoveredButton(null);
    expect(getHoveredButton()).toBeNull();
  });
});
