//! FILENAME: app/extensions/Charts/rendering/quickAccessButtons.ts
// PURPOSE: Quick Access Buttons that float to the right of selected charts.
// CONTEXT: Three buttons appear when a chart is selected:
//   1. "+" (Chart Elements) - toggle title, legend, data labels, gridlines, data table
//   2. Paintbrush (Chart Styles) - quick-apply color palettes
//   3. Funnel (Chart Filters) - toggle series/category visibility
//
// Buttons are drawn on the main canvas (not OffscreenCanvas) so they appear
// outside the chart bounds. Hit-testing extends beyond chart rect to cover buttons.
//
// A fourth kind, "action", is CONTRIBUTED: another extension registers it
// through `@api/chartQuickActions` and this module decides everything about how
// it looks and where it sits. That is how Insights puts "points of interest"
// and its snapshot in the strip without either extension importing the other.
//
// THE STRIP IS AS TALL AS ITS BUTTONS. The click envelope used to be the
// chart own height, which silently swallowed any button hanging below a short
// chart; it is now computed from the buttons themselves.

import { chartQuickActionsFor, type ChartQuickActionIcon } from "@api/chartQuickActions";

// ============================================================================
// Types
// ============================================================================

export type QuickAccessButtonType = "elements" | "styles" | "filters" | "action";

export interface QuickAccessButton {
  type: QuickAccessButtonType;
  /** Canvas X coordinate (absolute) */
  x: number;
  /** Canvas Y coordinate (absolute) */
  y: number;
  width: number;
  height: number;
  /** Icon character or label */
  icon: string;
  /** Tooltip text */
  tooltip: string;
  /** Set only on a contributed button: which registered action it runs. */
  actionId?: string;
  /** Which icon the painter draws for a contributed button. */
  actionIcon?: ChartQuickActionIcon;
  /** Drawn pressed, as an open popup is. */
  active?: boolean;
}

/**
 * What identifies a button for hover and popup state.
 *
 * The three built-ins are one of a kind, so their type is enough; a contributed
 * button is one of many "action" buttons and is named by its action id.
 */
export function quickAccessButtonKey(button: QuickAccessButton): string {
  return button.actionId ?? button.type;
}

/** State tracking which button popup is open */
let activePopup: { chartId: string; buttonType: QuickAccessButtonType; screenX: number; screenY: number } | null = null;

// ============================================================================
// Button Layout
// ============================================================================

const BUTTON_SIZE = 26;
const BUTTON_GAP = 4;
const BUTTON_OFFSET_X = 8; // Gap between chart right edge and buttons

/**
 * Compute button positions for the right side of a selected chart.
 *
 * The three built-ins come first (Elements, Styles, Filters), followed by
 * whatever `@api/chartQuickActions` has registered and says is visible for THIS
 * chart, in its declared order. Every predicate is asked here, at paint time,
 * because "points of interest" is a toggle whose pressed state is per chart.
 *
 * `chartId` is optional so the built-in geometry can still be computed without
 * one; omitted, no contributed button is added.
 */
export function computeQuickAccessButtons(
  chartCanvasX: number,
  chartCanvasY: number,
  chartWidth: number,
  _chartHeight: number,
  chartId?: string,
): QuickAccessButton[] {
  const x = chartCanvasX + chartWidth + BUTTON_OFFSET_X;
  const startY = chartCanvasY + 4;
  const at = (i: number): number => startY + (BUTTON_SIZE + BUTTON_GAP) * i;

  const buttons: QuickAccessButton[] = [
    {
      type: "elements",
      x,
      y: at(0),
      width: BUTTON_SIZE,
      height: BUTTON_SIZE,
      icon: "+",
      tooltip: "Chart Elements",
    },
    {
      type: "styles",
      x,
      y: at(1),
      width: BUTTON_SIZE,
      height: BUTTON_SIZE,
      icon: "\u{1F3A8}", // paintbrush
      tooltip: "Chart Styles",
    },
    {
      type: "filters",
      x,
      y: at(2),
      width: BUTTON_SIZE,
      height: BUTTON_SIZE,
      icon: "\u25BD", // funnel
      tooltip: "Chart Filters",
    },
  ];

  if (chartId === undefined) return buttons;

  // A contributor predicate that throws costs that ONE button, never the
  // strip: the built-ins above are already in the array.
  for (const action of chartQuickActionsFor(chartId)) {
    let tooltip: string;
    let active: boolean;
    try {
      tooltip = action.tooltip(chartId);
      active = action.active !== undefined && action.active(chartId);
    } catch {
      continue;
    }
    buttons.push({
      type: "action",
      x,
      y: at(buttons.length),
      width: BUTTON_SIZE,
      height: BUTTON_SIZE,
      icon: "",
      tooltip,
      actionId: action.id,
      actionIcon: action.icon,
      active,
    });
  }

  return buttons;
}

/** The strip full height for a given number of buttons, measured from the chart top edge. */
export function quickAccessStripHeight(buttonCount: number): number {
  if (buttonCount <= 0) return 0;
  return 4 + buttonCount * BUTTON_SIZE + (buttonCount - 1) * BUTTON_GAP + 4;
}

// ============================================================================
// Drawing
// ============================================================================

/**
 * The hovered button KEY (see `quickAccessButtonKey`), for visual feedback.
 *
 * A key, not a type: every contributed button is of type "action", so hovering
 * one of them would light up all of them.
 */
let hoveredButton: string | null = null;

export function setHoveredButton(key: string | null): void {
  hoveredButton = key;
}

export function getHoveredButton(): string | null {
  return hoveredButton;
}

/**
 * Draw quick access buttons next to a selected chart.
 */
export function drawQuickAccessButtons(
  ctx: CanvasRenderingContext2D,
  buttons: QuickAccessButton[],
): void {
  ctx.save();

  for (const btn of buttons) {
    const key = quickAccessButtonKey(btn);
    const isHovered = hoveredButton === key;
    const isActive = btn.type === "action" ? btn.active === true : activePopup?.buttonType === btn.type;
    const r = 4; // border radius

    // Background
    ctx.fillStyle = isActive ? "#d6e4f0" : isHovered ? "#e8e8e8" : "#ffffff";
    ctx.beginPath();
    ctx.moveTo(btn.x + r, btn.y);
    ctx.lineTo(btn.x + btn.width - r, btn.y);
    ctx.arcTo(btn.x + btn.width, btn.y, btn.x + btn.width, btn.y + r, r);
    ctx.lineTo(btn.x + btn.width, btn.y + btn.height - r);
    ctx.arcTo(btn.x + btn.width, btn.y + btn.height, btn.x + btn.width - r, btn.y + btn.height, r);
    ctx.lineTo(btn.x + r, btn.y + btn.height);
    ctx.arcTo(btn.x, btn.y + btn.height, btn.x, btn.y + btn.height - r, r);
    ctx.lineTo(btn.x, btn.y + r);
    ctx.arcTo(btn.x, btn.y, btn.x + r, btn.y, r);
    ctx.closePath();
    ctx.fill();

    // Border
    ctx.strokeStyle = isActive ? "#a0c0e0" : isHovered ? "#c0c0c0" : "#d0d0d0";
    ctx.lineWidth = 1;
    ctx.stroke();

    // Shadow
    if (isHovered || isActive) {
      ctx.shadowColor = "rgba(0,0,0,0.1)";
      ctx.shadowBlur = 4;
      ctx.shadowOffsetY = 1;
    }

    // Icon
    ctx.fillStyle = isActive ? "#005fb8" : "#444";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    if (btn.type === "elements") {
      // Draw "+" icon
      ctx.font = "bold 16px sans-serif";
      ctx.fillText("+", btn.x + btn.width / 2, btn.y + btn.height / 2);
    } else if (btn.type === "styles") {
      // Draw paintbrush icon (simple brush shape)
      drawBrushIcon(ctx, btn.x + btn.width / 2, btn.y + btn.height / 2);
    } else if (btn.type === "filters") {
      // Draw funnel icon
      drawFunnelIcon(ctx, btn.x + btn.width / 2, btn.y + btn.height / 2);
    } else if (btn.actionIcon === "insight") {
      drawInsightIcon(ctx, btn.x + btn.width / 2, btn.y + btn.height / 2);
    } else if (btn.actionIcon === "camera") {
      drawCameraIcon(ctx, btn.x + btn.width / 2, btn.y + btn.height / 2);
    }

    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
  }

  ctx.restore();
}

function drawBrushIcon(ctx: CanvasRenderingContext2D, cx: number, cy: number): void {
  ctx.save();
  ctx.strokeStyle = ctx.fillStyle;
  ctx.lineWidth = 1.5;
  ctx.lineCap = "round";

  // Brush handle
  ctx.beginPath();
  ctx.moveTo(cx - 4, cy + 5);
  ctx.lineTo(cx + 2, cy - 1);
  ctx.stroke();

  // Brush head (filled triangle)
  ctx.beginPath();
  ctx.moveTo(cx + 1, cy - 1);
  ctx.lineTo(cx + 6, cy - 6);
  ctx.lineTo(cx + 4, cy - 8);
  ctx.lineTo(cx - 1, cy - 3);
  ctx.closePath();
  ctx.fill();

  // Color dots
  const dotR = 1.5;
  const colors = ["#4472C4", "#ED7D31", "#70AD47"];
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = colors[i];
    ctx.beginPath();
    ctx.arc(cx - 4 + i * 5, cy + 8, dotR, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

/**
 * "Points of interest": a datum ringed by the same box the overlay draws on a
 * bar, with a spark beside it. The box is the literal shape of the cue this
 * button turns on, so the button and its effect look like each other.
 */
function drawInsightIcon(ctx: CanvasRenderingContext2D, cx: number, cy: number): void {
  ctx.save();
  ctx.strokeStyle = ctx.fillStyle;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = "miter";

  // Three bars, the middle one ringed.
  ctx.beginPath();
  ctx.moveTo(cx - 6, cy + 6);
  ctx.lineTo(cx - 6, cy + 1);
  ctx.moveTo(cx + 6, cy + 6);
  ctx.lineTo(cx + 6, cy - 1);
  ctx.stroke();

  ctx.beginPath();
  ctx.rect(cx - 3, cy - 4, 6, 10);
  ctx.stroke();

  // The spark above the marked bar.
  ctx.beginPath();
  ctx.moveTo(cx, cy - 8);
  ctx.lineTo(cx, cy - 6);
  ctx.moveTo(cx - 4, cy - 7);
  ctx.lineTo(cx - 3, cy - 6);
  ctx.moveTo(cx + 4, cy - 7);
  ctx.lineTo(cx + 3, cy - 6);
  ctx.stroke();

  ctx.restore();
}

/** "Snapshot": a camera body with a lens. */
function drawCameraIcon(ctx: CanvasRenderingContext2D, cx: number, cy: number): void {
  ctx.save();
  ctx.strokeStyle = ctx.fillStyle;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = "round";

  ctx.beginPath();
  ctx.rect(cx - 7, cy - 4, 14, 10);
  ctx.stroke();

  // The viewfinder bump on top.
  ctx.beginPath();
  ctx.moveTo(cx - 3, cy - 4);
  ctx.lineTo(cx - 2, cy - 7);
  ctx.lineTo(cx + 2, cy - 7);
  ctx.lineTo(cx + 3, cy - 4);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(cx, cy + 1, 3, 0, Math.PI * 2);
  ctx.stroke();

  ctx.restore();
}

function drawFunnelIcon(ctx: CanvasRenderingContext2D, cx: number, cy: number): void {
  ctx.save();
  ctx.strokeStyle = ctx.fillStyle;
  ctx.lineWidth = 1.5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // Funnel shape
  ctx.beginPath();
  ctx.moveTo(cx - 6, cy - 5);
  ctx.lineTo(cx + 6, cy - 5);
  ctx.lineTo(cx + 1, cy + 1);
  ctx.lineTo(cx + 1, cy + 6);
  ctx.lineTo(cx - 1, cy + 6);
  ctx.lineTo(cx - 1, cy + 1);
  ctx.closePath();
  ctx.stroke();

  ctx.restore();
}

// ============================================================================
// Hit Testing
// ============================================================================

/**
 * Hit-test quick access buttons. Returns the button type if hit, null otherwise.
 */
export function hitTestQuickAccessButtons(
  canvasX: number,
  canvasY: number,
  buttons: QuickAccessButton[],
): QuickAccessButton | null {
  for (const btn of buttons) {
    if (
      canvasX >= btn.x &&
      canvasX <= btn.x + btn.width &&
      canvasY >= btn.y &&
      canvasY <= btn.y + btn.height
    ) {
      return btn;
    }
  }
  return null;
}

/**
 * Check if a canvas position is within the extended chart area
 * (chart bounds + quick access button area to the right).
 *
 * The vertical extent is the TALLER of the chart and its button strip. It used
 * to be the chart alone, so on a chart shorter than the strip the lowest
 * buttons were drawn, hovered nothing and swallowed no clicks: the grid under
 * them took the click instead and the chart was deselected. Three buttons made
 * that a 90px-tall corner case; a contributed fourth and fifth make it ordinary.
 */
export function isInQuickAccessArea(
  canvasX: number,
  canvasY: number,
  chartCanvasX: number,
  chartCanvasY: number,
  chartWidth: number,
  chartHeight: number,
  buttonCount = 3,
): boolean {
  const extendedWidth = chartWidth + BUTTON_OFFSET_X + BUTTON_SIZE + 4;
  const extendedHeight = Math.max(chartHeight, quickAccessStripHeight(buttonCount));
  const inStripColumn = canvasX > chartCanvasX + chartWidth;
  return (
    canvasX >= chartCanvasX &&
    canvasX <= chartCanvasX + extendedWidth &&
    canvasY >= chartCanvasY &&
    // Only the strip column may reach below the chart: the cells under a chart
    // belong to the grid, and claiming them would break clicking beside it.
    canvasY <= chartCanvasY + (inStripColumn ? extendedHeight : chartHeight)
  );
}

// ============================================================================
// Popup State
// ============================================================================

export function getActivePopup(): typeof activePopup {
  return activePopup;
}

export function setActivePopup(popup: typeof activePopup): void {
  activePopup = popup;
}

export function closePopup(): void {
  activePopup = null;
}

/**
 * Toggle popup for a button. If already open for this button, close it.
 * Returns the new popup state.
 */
export function togglePopup(
  chartId: string,
  buttonType: QuickAccessButtonType,
  screenX: number,
  screenY: number,
): typeof activePopup {
  if (activePopup && activePopup.chartId === chartId && activePopup.buttonType === buttonType) {
    activePopup = null;
  } else {
    activePopup = { chartId, buttonType, screenX, screenY };
  }
  return activePopup;
}
