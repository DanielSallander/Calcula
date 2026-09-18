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
  quickAccessButtonKey,
  quickAccessStripHeight,
} from "../quickAccessButtons";
import { registerChartQuickAction, resetChartQuickActions } from "@api/chartQuickActions";

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
    expect(result?.type).toBe("elements");
  });

  it("detects hit on the styles button", () => {
    const btn = buttons[1];
    const result = hitTestQuickAccessButtons(btn.x + 5, btn.y + 5, buttons);
    expect(result?.type).toBe("styles");
  });

  it("detects hit on the filters button", () => {
    const btn = buttons[2];
    const result = hitTestQuickAccessButtons(btn.x + 5, btn.y + 5, buttons);
    expect(result?.type).toBe("filters");
  });

  it("detects hit on button edges", () => {
    const btn = buttons[0];
    // Top-left corner
    expect(hitTestQuickAccessButtons(btn.x, btn.y, buttons)?.type).toBe("elements");
    // Bottom-right corner
    expect(hitTestQuickAccessButtons(btn.x + btn.width, btn.y + btn.height, buttons)?.type).toBe("elements");
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

// ============================================================================
// Contributed buttons (@api/chartQuickActions) and the click envelope
// ============================================================================

describe("contributed quick-access buttons", () => {
  beforeEach(() => {
    resetChartQuickActions();
  });

  it("appends registered actions below the three built-ins, in order, evenly spaced", () => {
    registerChartQuickAction({ id: "b", icon: "camera", order: 20, tooltip: () => "B", onSelect: () => undefined });
    registerChartQuickAction({ id: "a", icon: "insight", order: 10, tooltip: () => "A", onSelect: () => undefined });

    const buttons = computeQuickAccessButtons(100, 50, 400, 300, "chart-1");
    expect(buttons.map((b) => b.type)).toEqual(["elements", "styles", "filters", "action", "action"]);
    expect(buttons.slice(3).map((b) => b.actionId)).toEqual(["a", "b"]);
    expect(buttons.slice(3).map((b) => b.actionIcon)).toEqual(["insight", "camera"]);

    // The gap between consecutive buttons is the same all the way down.
    const gaps = buttons.slice(1).map((b, i) => b.y - buttons[i].y);
    expect(new Set(gaps).size).toBe(1);
    // And they all sit in the same column, at the same size.
    expect(new Set(buttons.map((b) => b.x)).size).toBe(1);
  });

  it("adds nothing when no chart id is given, so the built-in geometry is unchanged", () => {
    registerChartQuickAction({ id: "a", icon: "insight", order: 10, tooltip: () => "A", onSelect: () => undefined });
    expect(computeQuickAccessButtons(100, 50, 400, 300)).toHaveLength(3);
  });

  it("asks the action for THIS chart's tooltip and pressed state", () => {
    registerChartQuickAction({
      id: "toggle",
      icon: "insight",
      order: 10,
      tooltip: (id) => (id === "on" ? "Hide points of interest" : "Show points of interest"),
      active: (id) => id === "on",
      onSelect: () => undefined,
    });
    expect(computeQuickAccessButtons(0, 0, 100, 100, "on")[3]).toMatchObject({
      tooltip: "Hide points of interest",
      active: true,
    });
    expect(computeQuickAccessButtons(0, 0, 100, 100, "off")[3]).toMatchObject({
      tooltip: "Show points of interest",
      active: false,
    });
  });

  it("drops one action whose tooltip throws and keeps the rest of the strip", () => {
    registerChartQuickAction({ id: "bad", icon: "insight", order: 10, tooltip: () => { throw new Error("boom"); }, onSelect: () => undefined });
    registerChartQuickAction({ id: "good", icon: "camera", order: 20, tooltip: () => "Good", onSelect: () => undefined });
    const buttons = computeQuickAccessButtons(0, 0, 100, 100, "c1");
    expect(buttons).toHaveLength(4);
    expect(buttons[3].actionId).toBe("good");
  });

  it("hit-tests a contributed button and names it by its action id", () => {
    registerChartQuickAction({ id: "snap", icon: "camera", order: 10, tooltip: () => "Snap", onSelect: () => undefined });
    const buttons = computeQuickAccessButtons(100, 50, 400, 300, "c1");
    const contributed = buttons[3];
    const hit = hitTestQuickAccessButtons(contributed.x + 5, contributed.y + 5, buttons);
    expect(hit?.type).toBe("action");
    expect(hit && quickAccessButtonKey(hit)).toBe("snap");
    // Two contributed buttons are not the same button.
    expect(quickAccessButtonKey(buttons[0])).toBe("elements");
  });

  // The envelope used to be the chart's own height, so on a chart shorter than
  // the strip the lowest buttons drew, hovered nothing, and let the click fall
  // through to the grid — which deselected the chart they belonged to.
  it("extends the click envelope below a chart shorter than its strip", () => {
    const SHORT = 40;
    const buttons = computeQuickAccessButtons(100, 50, 400, SHORT);
    const last = buttons[buttons.length - 1];
    const belowLastButton = last.y + last.height - 2;
    expect(belowLastButton).toBeGreaterThan(50 + SHORT); // the premise: it hangs below

    expect(isInQuickAccessArea(last.x + 5, belowLastButton, 100, 50, 400, SHORT, buttons.length)).toBe(true);
    // Five buttons reach further down still, and the envelope follows.
    const five = isInQuickAccessArea(last.x + 5, 50 + quickAccessStripHeight(5) - 2, 100, 50, 400, SHORT, 5);
    expect(five).toBe(true);
    // But not beyond the strip.
    expect(isInQuickAccessArea(last.x + 5, 50 + quickAccessStripHeight(5) + 20, 100, 50, 400, SHORT, 5)).toBe(false);
  });

  // The cells UNDER a chart belong to the grid. Only the button column may
  // reach below it, or clicking beside a short chart would stop working.
  it("does not claim the space under the chart itself", () => {
    const SHORT = 40;
    const underTheChart = 50 + SHORT + 10;
    expect(isInQuickAccessArea(100 + 10, underTheChart, 100, 50, 400, SHORT, 5)).toBe(false);
    expect(isInQuickAccessArea(100 + 400 + 12, underTheChart, 100, 50, 400, SHORT, 5)).toBe(true);
  });
});
