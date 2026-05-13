//! FILENAME: app/extensions/Charts/rendering/quickAccessButtons.ts
// PURPOSE: Quick Access Buttons that float to the right of selected charts.
// CONTEXT: Three buttons appear when a chart is selected:
//   1. "+" (Chart Elements) - toggle title, legend, data labels, gridlines, data table
//   2. Paintbrush (Chart Styles) - quick-apply color palettes
//   3. Funnel (Chart Filters) - toggle series/category visibility
//
// Buttons are drawn on the main canvas (not OffscreenCanvas) so they appear
// outside the chart bounds. Hit-testing extends beyond chart rect to cover buttons.

// ============================================================================
// Types
// ============================================================================

export type QuickAccessButtonType = "elements" | "styles" | "filters";

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
}

/** State tracking which button popup is open */
let activePopup: { chartId: number; buttonType: QuickAccessButtonType; screenX: number; screenY: number } | null = null;

// ============================================================================
// Button Layout
// ============================================================================

const BUTTON_SIZE = 26;
const BUTTON_GAP = 4;
const BUTTON_OFFSET_X = 8; // Gap between chart right edge and buttons

/**
 * Compute button positions for the right side of a selected chart.
 * Returns 3 buttons positioned vertically: Elements, Styles, Filters.
 */
export function computeQuickAccessButtons(
  chartCanvasX: number,
  chartCanvasY: number,
  chartWidth: number,
  _chartHeight: number,
): QuickAccessButton[] {
  const x = chartCanvasX + chartWidth + BUTTON_OFFSET_X;
  const startY = chartCanvasY + 4;

  return [
    {
      type: "elements",
      x,
      y: startY,
      width: BUTTON_SIZE,
      height: BUTTON_SIZE,
      icon: "+",
      tooltip: "Chart Elements",
    },
    {
      type: "styles",
      x,
      y: startY + BUTTON_SIZE + BUTTON_GAP,
      width: BUTTON_SIZE,
      height: BUTTON_SIZE,
      icon: "\u{1F3A8}", // paintbrush
      tooltip: "Chart Styles",
    },
    {
      type: "filters",
      x,
      y: startY + (BUTTON_SIZE + BUTTON_GAP) * 2,
      width: BUTTON_SIZE,
      height: BUTTON_SIZE,
      icon: "\u25BD", // funnel
      tooltip: "Chart Filters",
    },
  ];
}

// ============================================================================
// Drawing
// ============================================================================

/** Currently hovered button type (for visual feedback) */
let hoveredButton: QuickAccessButtonType | null = null;

export function setHoveredButton(type: QuickAccessButtonType | null): void {
  hoveredButton = type;
}

export function getHoveredButton(): QuickAccessButtonType | null {
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
    const isHovered = hoveredButton === btn.type;
    const isActive = activePopup?.buttonType === btn.type;
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
): QuickAccessButtonType | null {
  for (const btn of buttons) {
    if (
      canvasX >= btn.x &&
      canvasX <= btn.x + btn.width &&
      canvasY >= btn.y &&
      canvasY <= btn.y + btn.height
    ) {
      return btn.type;
    }
  }
  return null;
}

/**
 * Check if a canvas position is within the extended chart area
 * (chart bounds + quick access button area to the right).
 */
export function isInQuickAccessArea(
  canvasX: number,
  canvasY: number,
  chartCanvasX: number,
  chartCanvasY: number,
  chartWidth: number,
  chartHeight: number,
): boolean {
  const extendedWidth = chartWidth + BUTTON_OFFSET_X + BUTTON_SIZE + 4;
  return (
    canvasX >= chartCanvasX &&
    canvasX <= chartCanvasX + extendedWidth &&
    canvasY >= chartCanvasY &&
    canvasY <= chartCanvasY + chartHeight
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
  chartId: number,
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
