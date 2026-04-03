//! FILENAME: app/extensions/TimelineSlicer/rendering/timelineSlicerRenderer.ts
// PURPOSE: Canvas rendering and hit testing for timeline slicer overlay objects.
// CONTEXT: Renders a horizontal scrollable timeline with a header bar,
//          period cells (years/quarters/months/days), group labels,
//          a level selector, and optional scrollbar.

import {
  overlaySheetToCanvas,
  type OverlayRenderContext,
  type OverlayHitTestContext,
  type OverlayCursorFn,
} from "@api/gridOverlays";
import { getTimelineById, getCachedTimelineData } from "../lib/timelineSlicerStore";
import { isTimelineSelected } from "../handlers/selectionHandler";
import { TIMELINE_STYLES_BY_ID } from "../components/TimelineSlicerStylesGallery";
import type { TimelineSlicer, TimelinePeriod, TimelineLevel } from "../lib/timelineSlicerTypes";

// ============================================================================
// Style Constants
// ============================================================================

const HEADER_HEIGHT = 28;
const GROUP_LABEL_HEIGHT = 18;
const PERIOD_HEIGHT = 28;
const LEVEL_SELECTOR_HEIGHT = 24;
const SCROLLBAR_HEIGHT = 8;
const PERIOD_MIN_WIDTH = 40;
const BORDER_RADIUS = 3;
const FONT_FAMILY = "Calibri, Segoe UI, sans-serif";
const CLEAR_BUTTON_SIZE = 18;

interface TimelineStyleColors {
  bg: string;
  headerBg: string;
  headerFg: string;
  selectedBg: string;
  selectedFg: string;
  periodBg: string;
  periodFg: string;
  noDataFg: string;
  groupFg: string;
  border: string;
  levelBg: string;
  levelFg: string;
  levelActiveBg: string;
  levelActiveFg: string;
  selectionBarBg: string;
}

const DEFAULT_COLORS: TimelineStyleColors = {
  bg: "#FFFFFF",
  headerBg: "#4472C4",
  headerFg: "#FFFFFF",
  selectedBg: "#4472C4",
  selectedFg: "#FFFFFF",
  periodBg: "#F5F5F5",
  periodFg: "#333333",
  noDataFg: "#CCCCCC",
  groupFg: "#666666",
  border: "#8FAADC",
  levelBg: "#E8E8E8",
  levelFg: "#666666",
  levelActiveBg: "#4472C4",
  levelActiveFg: "#FFFFFF",
  selectionBarBg: "rgba(68, 114, 196, 0.3)",
};

const LEGACY_STYLES: Record<string, TimelineStyleColors> = {
  TimelineStyleLight1: DEFAULT_COLORS,
  TimelineStyleLight2: {
    ...DEFAULT_COLORS,
    headerBg: "#ED7D31",
    selectedBg: "#ED7D31",
    border: "#F4B183",
    levelActiveBg: "#ED7D31",
    selectionBarBg: "rgba(237, 125, 49, 0.3)",
  },
  TimelineStyleLight3: {
    ...DEFAULT_COLORS,
    headerBg: "#548235",
    selectedBg: "#548235",
    border: "#A9D18E",
    levelActiveBg: "#548235",
    selectionBarBg: "rgba(84, 130, 53, 0.3)",
  },
  TimelineStyleDark1: {
    bg: "#333333",
    headerBg: "#4472C4",
    headerFg: "#FFFFFF",
    selectedBg: "#4472C4",
    selectedFg: "#FFFFFF",
    periodBg: "#444444",
    periodFg: "#EEEEEE",
    noDataFg: "#666666",
    groupFg: "#AAAAAA",
    border: "#555555",
    levelBg: "#444444",
    levelFg: "#AAAAAA",
    levelActiveBg: "#4472C4",
    levelActiveFg: "#FFFFFF",
    selectionBarBg: "rgba(68, 114, 196, 0.4)",
  },
};

function getStyleColors(preset: string): TimelineStyleColors {
  const galleryStyle = TIMELINE_STYLES_BY_ID.get(preset);
  if (galleryStyle) {
    return galleryStyle.colors;
  }
  return LEGACY_STYLES[preset] || DEFAULT_COLORS;
}

// ============================================================================
// Layout Computation
// ============================================================================

interface TimelineLayout {
  headerH: number;
  groupLabelH: number;
  periodH: number;
  levelSelectorH: number;
  scrollbarH: number;
  periodWidth: number;
  contentWidth: number;
  viewportWidth: number;
  viewportTop: number;
  needsScroll: boolean;
  totalPeriods: number;
}

function computeLayout(
  tl: TimelineSlicer,
  periodCount: number,
): TimelineLayout {
  const headerH = tl.showHeader ? HEADER_HEIGHT : 0;
  const groupLabelH = GROUP_LABEL_HEIGHT;
  const periodH = PERIOD_HEIGHT;
  const levelSelectorH = tl.showLevelSelector ? LEVEL_SELECTOR_HEIGHT : 0;
  const scrollbarH = tl.showScrollbar ? SCROLLBAR_HEIGHT : 0;

  const viewportWidth = tl.width;
  const viewportTop = headerH;

  // Calculate period width based on level and available space
  let periodWidth: number;
  switch (tl.level) {
    case "years":
      periodWidth = Math.max(PERIOD_MIN_WIDTH, 80);
      break;
    case "quarters":
      periodWidth = Math.max(PERIOD_MIN_WIDTH, 60);
      break;
    case "months":
      periodWidth = Math.max(PERIOD_MIN_WIDTH, 50);
      break;
    case "days":
      periodWidth = Math.max(PERIOD_MIN_WIDTH - 10, 30);
      break;
    default:
      periodWidth = PERIOD_MIN_WIDTH;
  }

  const contentWidth = periodCount * periodWidth;
  const needsScroll = contentWidth > viewportWidth;

  return {
    headerH,
    groupLabelH,
    periodH,
    levelSelectorH,
    scrollbarH,
    periodWidth,
    contentWidth,
    viewportWidth,
    viewportTop,
    needsScroll,
    totalPeriods: periodCount,
  };
}

// ============================================================================
// Scroll State
// ============================================================================

const scrollOffsets = new Map<number, number>();

export function getScrollOffset(timelineId: number): number {
  return scrollOffsets.get(timelineId) ?? 0;
}

export function setScrollOffset(timelineId: number, offset: number): void {
  const max = getMaxScrollOffset(timelineId);
  scrollOffsets.set(timelineId, Math.max(0, Math.min(offset, max)));
}

export function getMaxScrollOffset(timelineId: number): number {
  const tl = getTimelineById(timelineId);
  if (!tl) return 0;

  const data = getCachedTimelineData(timelineId);
  if (!data) return 0;

  const layout = computeLayout(tl, data.periods.length);
  return Math.max(0, layout.contentWidth - layout.viewportWidth);
}

export function resetScrollOffsets(): void {
  scrollOffsets.clear();
}

// ============================================================================
// Renderer
// ============================================================================

export function renderTimelineSlicer(ctx: OverlayRenderContext): void {
  const timelineId = ctx.region.data?.timelineId as number | undefined;
  if (timelineId == null) return;

  const tl = getTimelineById(timelineId);
  if (!tl) return;

  const data = getCachedTimelineData(timelineId);
  const periods = data?.periods ?? [];
  const c = ctx.ctx;
  const colors = getStyleColors(tl.stylePreset);

  const { canvasX, canvasY } = overlaySheetToCanvas(ctx, tl.x, tl.y);
  const w = tl.width;
  const h = tl.height;
  const layout = computeLayout(tl, periods.length);
  const scrollVal = Math.min(getScrollOffset(timelineId), Math.max(0, layout.contentWidth - layout.viewportWidth));

  // Clip to bounds
  c.save();
  c.beginPath();
  c.roundRect(canvasX, canvasY, w, h, BORDER_RADIUS);
  c.clip();

  // Background
  c.fillStyle = colors.bg;
  c.fillRect(canvasX, canvasY, w, h);

  // Header bar
  if (tl.showHeader) {
    c.fillStyle = colors.headerBg;
    c.fillRect(canvasX, canvasY, w, HEADER_HEIGHT);

    c.fillStyle = colors.headerFg;
    c.font = `bold 11px ${FONT_FAMILY}`;
    c.textAlign = "left";
    c.textBaseline = "middle";
    c.fillText(
      tl.headerText ?? tl.name,
      canvasX + 8,
      canvasY + HEADER_HEIGHT / 2,
      w - CLEAR_BUTTON_SIZE - 20,
    );

    // Clear filter button
    const isFiltered = tl.selectionStart !== null;
    const btnX = canvasX + w - CLEAR_BUTTON_SIZE - 4;
    const btnY = canvasY + (HEADER_HEIGHT - CLEAR_BUTTON_SIZE) / 2;
    drawClearFilterButton(c, btnX, btnY, CLEAR_BUTTON_SIZE, isFiltered, colors.headerFg);
  }

  // Period area
  const periodAreaTop = canvasY + layout.headerH;
  const periodAreaH = h - layout.headerH - layout.levelSelectorH - layout.scrollbarH;

  // Clip period area
  c.save();
  c.beginPath();
  c.rect(canvasX, periodAreaTop, w, periodAreaH);
  c.clip();

  // Draw group labels and periods
  let lastGroupLabel = "";
  let groupStartX = 0;

  for (let i = 0; i < periods.length; i++) {
    const period = periods[i];
    const px = canvasX + i * layout.periodWidth - scrollVal;

    // Skip off-screen periods
    if (px + layout.periodWidth < canvasX) continue;
    if (px > canvasX + w) break;

    // Group label row (e.g., year label above months)
    if (period.groupLabel && period.groupLabel !== lastGroupLabel) {
      // Draw previous group separator
      if (lastGroupLabel !== "") {
        c.strokeStyle = colors.border;
        c.lineWidth = 0.5;
        c.beginPath();
        c.moveTo(px, periodAreaTop);
        c.lineTo(px, periodAreaTop + layout.groupLabelH);
        c.stroke();
      }

      // Draw group label
      c.fillStyle = colors.groupFg;
      c.font = `10px ${FONT_FAMILY}`;
      c.textAlign = "left";
      c.textBaseline = "middle";
      c.fillText(
        period.groupLabel,
        px + 4,
        periodAreaTop + layout.groupLabelH / 2,
      );

      lastGroupLabel = period.groupLabel;
      groupStartX = px;
    }

    // Period cell
    const cellTop = periodAreaTop + layout.groupLabelH;
    const cellH = layout.periodH;

    // Selection highlight
    if (period.isSelected) {
      c.fillStyle = colors.selectionBarBg;
      c.fillRect(px, cellTop, layout.periodWidth, cellH);
    }

    // Period label
    if (period.hasData) {
      c.fillStyle = period.isSelected ? colors.selectedFg : colors.periodFg;
    } else {
      c.fillStyle = colors.noDataFg;
    }
    c.font = `11px ${FONT_FAMILY}`;
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText(
      period.label,
      px + layout.periodWidth / 2,
      cellTop + cellH / 2,
      layout.periodWidth - 4,
    );

    // Period separator
    c.strokeStyle = colors.border;
    c.lineWidth = 0.3;
    c.globalAlpha = 0.3;
    c.beginPath();
    c.moveTo(px + layout.periodWidth, cellTop);
    c.lineTo(px + layout.periodWidth, cellTop + cellH);
    c.stroke();
    c.globalAlpha = 1.0;
  }

  // Selection bar (thick bar across selected range)
  const firstSelected = periods.findIndex((p) => p.isSelected);
  const lastSelected = periods.length - 1 - [...periods].reverse().findIndex((p) => p.isSelected);
  if (firstSelected >= 0 && lastSelected >= firstSelected) {
    const selX = canvasX + firstSelected * layout.periodWidth - scrollVal;
    const selW = (lastSelected - firstSelected + 1) * layout.periodWidth;
    const barTop = periodAreaTop + layout.groupLabelH + layout.periodH - 4;

    c.fillStyle = colors.selectedBg;
    c.fillRect(selX, barTop, selW, 4);

    // Selection handles (small circles at start and end)
    c.beginPath();
    c.arc(selX, barTop + 2, 3, 0, Math.PI * 2);
    c.fill();
    c.beginPath();
    c.arc(selX + selW, barTop + 2, 3, 0, Math.PI * 2);
    c.fill();
  }

  c.restore(); // restore period clip

  // Level selector
  if (tl.showLevelSelector) {
    const levelTop = canvasY + h - layout.levelSelectorH - layout.scrollbarH;
    const levels: TimelineLevel[] = ["years", "quarters", "months", "days"];
    const levelLabels = ["YEARS", "QUARTERS", "MONTHS", "DAYS"];
    const levelBtnWidth = 68;
    const levelGap = 4;
    const totalLevelWidth = levels.length * levelBtnWidth + (levels.length - 1) * levelGap;
    const levelStartX = canvasX + (w - totalLevelWidth) / 2;

    for (let i = 0; i < levels.length; i++) {
      const lx = levelStartX + i * (levelBtnWidth + levelGap);
      const isActive = levels[i] === tl.level;

      c.fillStyle = isActive ? colors.levelActiveBg : colors.levelBg;
      c.beginPath();
      c.roundRect(lx, levelTop + 2, levelBtnWidth, LEVEL_SELECTOR_HEIGHT - 4, 3);
      c.fill();

      c.fillStyle = isActive ? colors.levelActiveFg : colors.levelFg;
      c.font = `bold 9px ${FONT_FAMILY}`;
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText(levelLabels[i], lx + levelBtnWidth / 2, levelTop + LEVEL_SELECTOR_HEIGHT / 2);
    }
  }

  // Scrollbar
  if (layout.needsScroll && tl.showScrollbar) {
    const sbTop = canvasY + h - layout.scrollbarH;
    drawHScrollbar(c, canvasX, sbTop, w, SCROLLBAR_HEIGHT, scrollVal, layout.contentWidth);
  }

  // Border
  c.strokeStyle = colors.border;
  c.lineWidth = 1;
  c.beginPath();
  c.roundRect(canvasX, canvasY, w, h, BORDER_RADIUS);
  c.stroke();

  // Selection highlight border
  if (isTimelineSelected(timelineId)) {
    c.strokeStyle = "#0078D4";
    c.lineWidth = 2;
    c.beginPath();
    c.roundRect(canvasX - 0.5, canvasY - 0.5, w + 1, h + 1, BORDER_RADIUS + 1);
    c.stroke();
  }

  c.restore(); // restore outer clip
}

// ============================================================================
// Scrollbar
// ============================================================================

function drawHScrollbar(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  trackWidth: number,
  height: number,
  scrollOffset: number,
  contentWidth: number,
): void {
  c.fillStyle = "rgba(0, 0, 0, 0.05)";
  c.fillRect(x, y, trackWidth, height);

  const thumbRatio = trackWidth / contentWidth;
  const thumbWidth = Math.max(20, trackWidth * thumbRatio);
  const scrollRange = contentWidth - trackWidth;
  const thumbRange = trackWidth - thumbWidth;
  const thumbX = scrollRange > 0 ? x + (scrollOffset / scrollRange) * thumbRange : x;

  c.fillStyle = "rgba(0, 0, 0, 0.25)";
  c.beginPath();
  c.roundRect(thumbX, y + 1, thumbWidth, height - 2, (height - 2) / 2);
  c.fill();
}

// ============================================================================
// Clear Filter Button
// ============================================================================

function drawClearFilterButton(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  isActive: boolean,
  headerFg: string,
): void {
  const cx = x + size / 2;
  const cy = y + size / 2;
  const sc = size * 0.4;

  if (isActive) {
    c.strokeStyle = headerFg;
    c.fillStyle = headerFg;
    c.globalAlpha = 1.0;
  } else {
    c.strokeStyle = headerFg;
    c.fillStyle = headerFg;
    c.globalAlpha = 0.3;
  }

  c.lineWidth = 1.5;
  c.beginPath();
  c.moveTo(cx - sc, cy - sc * 0.8);
  c.lineTo(cx + sc, cy - sc * 0.8);
  c.lineTo(cx + sc * 0.2, cy + sc * 0.1);
  c.lineTo(cx + sc * 0.2, cy + sc * 0.8);
  c.lineTo(cx - sc * 0.2, cy + sc * 0.8);
  c.lineTo(cx - sc * 0.2, cy + sc * 0.1);
  c.closePath();
  c.fill();

  if (isActive) {
    c.globalAlpha = 1.0;
    c.strokeStyle = "#FF4444";
    c.lineWidth = 2;
    const xOff = sc * 0.6;
    c.beginPath();
    c.moveTo(cx - xOff, cy - xOff);
    c.lineTo(cx + xOff, cy + xOff);
    c.moveTo(cx + xOff, cy - xOff);
    c.lineTo(cx - xOff, cy + xOff);
    c.stroke();
  }

  c.globalAlpha = 1.0;
}

// ============================================================================
// Hit Testing
// ============================================================================

export interface TimelineHitResult {
  type:
    | "header"
    | "clearButton"
    | "period"
    | "levelButton"
    | "scrollbar"
    | "body"
    | "selectionHandleStart"
    | "selectionHandleEnd";
  periodIndex?: number;
  level?: TimelineLevel;
}

export function hitTestTimeline(ctx: OverlayHitTestContext): boolean {
  if (!ctx.floatingCanvasBounds) return false;

  const { x, y, width, height } = ctx.floatingCanvasBounds;
  return (
    ctx.canvasX >= x &&
    ctx.canvasX <= x + width &&
    ctx.canvasY >= y &&
    ctx.canvasY <= y + height
  );
}

export function getTimelineHitDetail(
  canvasX: number,
  canvasY: number,
  bounds: { x: number; y: number; width: number; height: number },
  timelineId: number,
): TimelineHitResult | null {
  const tl = getTimelineById(timelineId);
  if (!tl) return null;

  const data = getCachedTimelineData(timelineId);
  const periods = data?.periods ?? [];
  const layout = computeLayout(tl, periods.length);

  const relX = canvasX - bounds.x;
  const relY = canvasY - bounds.y;

  // Header area
  if (tl.showHeader && relY < HEADER_HEIGHT) {
    if (relX > bounds.width - CLEAR_BUTTON_SIZE - 4) {
      return { type: "clearButton" };
    }
    return { type: "header" };
  }

  // Level selector area
  if (tl.showLevelSelector) {
    const levelTop = bounds.height - layout.levelSelectorH - layout.scrollbarH;
    if (relY >= levelTop && relY < levelTop + LEVEL_SELECTOR_HEIGHT) {
      const levels: TimelineLevel[] = ["years", "quarters", "months", "days"];
      const levelBtnWidth = 68;
      const levelGap = 4;
      const totalLevelWidth = levels.length * levelBtnWidth + (levels.length - 1) * levelGap;
      const levelStartX = (bounds.width - totalLevelWidth) / 2;

      for (let i = 0; i < levels.length; i++) {
        const lx = levelStartX + i * (levelBtnWidth + levelGap);
        if (relX >= lx && relX <= lx + levelBtnWidth) {
          return { type: "levelButton", level: levels[i] };
        }
      }
      return { type: "body" };
    }
  }

  // Scrollbar area
  if (layout.needsScroll && tl.showScrollbar) {
    const sbTop = bounds.height - layout.scrollbarH;
    if (relY >= sbTop) {
      return { type: "scrollbar" };
    }
  }

  // Period area
  const periodAreaTop = layout.headerH;
  if (relY >= periodAreaTop) {
    const scrollVal = getScrollOffset(timelineId);
    const periodIndex = Math.floor((relX + scrollVal) / layout.periodWidth);

    if (periodIndex >= 0 && periodIndex < periods.length) {
      // Check for selection handle hits
      const firstSelected = periods.findIndex((p) => p.isSelected);
      const lastSelected = periods.length - 1 - [...periods].reverse().findIndex((p) => p.isSelected);

      if (firstSelected >= 0) {
        const handleStartX = firstSelected * layout.periodWidth - scrollVal;
        const handleEndX = (lastSelected + 1) * layout.periodWidth - scrollVal;

        if (Math.abs(relX - handleStartX) < 6) {
          return { type: "selectionHandleStart" };
        }
        if (Math.abs(relX - handleEndX) < 6) {
          return { type: "selectionHandleEnd" };
        }
      }

      return { type: "period", periodIndex };
    }
  }

  return { type: "body" };
}

export const getTimelineCursor: OverlayCursorFn = (ctx) => {
  if (!ctx.floatingCanvasBounds) return null;

  const timelineId = ctx.region.data?.timelineId as number | undefined;
  if (timelineId == null) return null;

  const hit = getTimelineHitDetail(
    ctx.canvasX,
    ctx.canvasY,
    ctx.floatingCanvasBounds,
    timelineId,
  );
  if (!hit) return null;

  switch (hit.type) {
    case "period":
    case "clearButton":
    case "levelButton":
      return "pointer";
    case "selectionHandleStart":
    case "selectionHandleEnd":
      return "ew-resize";
    default:
      return null;
  }
};
