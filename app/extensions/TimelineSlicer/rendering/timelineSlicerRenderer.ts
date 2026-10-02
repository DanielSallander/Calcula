//! FILENAME: app/extensions/TimelineSlicer/rendering/timelineSlicerRenderer.ts
// PURPOSE: Canvas rendering and hit testing for timeline slicer overlay objects.
// CONTEXT: Renders a horizontal scrollable timeline with a header bar,
//          period cells (years/quarters/months/days), group labels,
//          a level selector, and optional scrollbar.

import {
  overlaySheetToCanvas,
  type OverlayRenderContext,
  type OverlayHitTestContext,
} from "@api/gridOverlays";
import { getTimelineById, getCachedTimelineData } from "../lib/timelineSlicerStore";
import { TIMELINE_STYLES_BY_ID } from "../components/TimelineSlicerStylesGallery";
import type { TimelineLevel } from "../lib/timelineSlicerTypes";
import {
  TIMELINE_CLEAR_BUTTON_MARGIN,
  TIMELINE_CLEAR_BUTTON_SIZE,
  TIMELINE_HEADER_HEIGHT,
  TIMELINE_LEVELS,
  TIMELINE_LEVEL_SELECTOR_HEIGHT,
  TIMELINE_LEVEL_BUTTON_WIDTH,
  TIMELINE_SCROLLBAR_HEIGHT,
  clampScroll,
  computeTimelineLayout,
  isTimelineFiltered,
  levelButtonLeft,
  scrollbarThumbOf,
  selectedSpanOf,
  type TimelineLayout,
} from "../lib/timelineZones";
import { getScrollOffset, timelineZoneAtCanvas } from "../lib/timelineView";
import { getTimelineRangePreview } from "../lib/timelineGestureView";
import { getTimelineKeyFocus, resolveTimelineFocus } from "../lib/timelineKeyFocus";

// ============================================================================
// Style Constants
// ============================================================================

// The geometry (header, year strip, tiles, level row, scrollbar) is the zone
// table's (lib/timelineZones.ts): what is painted is what a press hits.
const HEADER_HEIGHT = TIMELINE_HEADER_HEIGHT;
const LEVEL_SELECTOR_HEIGHT = TIMELINE_LEVEL_SELECTOR_HEIGHT;
const SCROLLBAR_HEIGHT = TIMELINE_SCROLLBAR_HEIGHT;
const BORDER_RADIUS = 3;
const FONT_FAMILY = "Calibri, Segoe UI, sans-serif";
const CLEAR_BUTTON_SIZE = TIMELINE_CLEAR_BUTTON_SIZE;

/**
 * The keyboard focus ring (M8 S8, plan decision KD4; the Slicer's ring): a
 * 2px DARK outline with a 1px LIGHT line inside it, drawn inside the focused
 * period's tile. Two tones, so that whatever the fill under it -- a preset's
 * background, its translucent selection highlight, a dark preset's
 * near-black -- one of them reaches 3:1 against it (WCAG 2.2 SC 1.4.11).
 * timelineFocusRing.test.ts measures every preset.
 */
export const TIMELINE_FOCUS_RING_DARK = "#000000";
export const TIMELINE_FOCUS_RING_LIGHT = "#ffffff";

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
// Renderer
// ============================================================================
//
// The layout is `computeTimelineLayout` (lib/timelineZones.ts), and the
// periods' scroll is lib/timelineView.ts's -- the zone table measures presses
// on the same numbers.

export function renderTimelineSlicer(ctx: OverlayRenderContext): void {
  const timelineId = ctx.region.data?.timelineId as string | undefined;
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
  const layout: TimelineLayout = computeTimelineLayout(tl, periods.length);
  const scrollVal = clampScroll(layout, getScrollOffset(timelineId));

  // The range to paint: a live range drag's TRANSIENT preview (or a released
  // one's until its commit lands), else the committed range the backend
  // flagged. Nothing here is written anywhere. The zone input places the
  // range-end markers on this same range (lib/timelineView.ts).
  const preview = getTimelineRangePreview(timelineId);
  const isShownSelected = (i: number): boolean =>
    preview ? i >= preview.first && i <= preview.last : periods[i].isSelected;

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

    // Clear filter button: lit (and a press target, lib/timelineZones.ts)
    // only while there is a filter to clear.
    const isFiltered = isTimelineFiltered(tl);
    const btnX = canvasX + w - CLEAR_BUTTON_SIZE - TIMELINE_CLEAR_BUTTON_MARGIN;
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
    const shownSelected = isShownSelected(i);
    if (shownSelected) {
      c.fillStyle = colors.selectionBarBg;
      c.fillRect(px, cellTop, layout.periodWidth, cellH);
    }

    // Period label
    if (period.hasData) {
      c.fillStyle = shownSelected ? colors.selectedFg : colors.periodFg;
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
  const span = preview ?? selectedSpanOf(periods);
  if (span && span.last < periods.length) {
    const selX = canvasX + span.first * layout.periodWidth - scrollVal;
    const selW = (span.last - span.first + 1) * layout.periodWidth;
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

  // The keyboard's focus ring (M8 S8), on the period the next key acts on
  // (`resolveTimelineFocus`, which the key handler asks too), at the tile the
  // period loop above painted -- after the selection bar, so the bar does not
  // cover the ring's lower edge, and inside the period clip, so a focused
  // period scrolled out of view shows no ring.
  const keyFocus = getTimelineKeyFocus();
  if (keyFocus !== null && keyFocus.timelineId === timelineId) {
    const at = resolveTimelineFocus(
      keyFocus,
      tl.level,
      periods.map((p) => p.startDate),
    );
    if (at !== null) {
      const tileX = canvasX + at.index * layout.periodWidth - scrollVal;
      drawFocusRing(c, tileX, periodAreaTop + layout.groupLabelH, layout.periodWidth, layout.periodH);
    }
  }

  c.restore(); // restore period clip

  // Level selector
  if (tl.showLevelSelector) {
    const levelTop = canvasY + layout.levelTop;
    const levels: readonly TimelineLevel[] = TIMELINE_LEVELS;
    const levelLabels = ["YEARS", "QUARTERS", "MONTHS", "DAYS"];
    const levelBtnWidth = TIMELINE_LEVEL_BUTTON_WIDTH;

    for (let i = 0; i < levels.length; i++) {
      const lx = canvasX + levelButtonLeft(w, i);
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
    const sbTop = canvasY + layout.scrollbarTop;
    drawHScrollbar(c, canvasX, sbTop, w, SCROLLBAR_HEIGHT, scrollbarThumbOf(layout, scrollVal));
  }

  // Border
  c.strokeStyle = colors.border;
  c.lineWidth = 1;
  c.beginPath();
  c.roundRect(canvasX, canvasY, w, h, BORDER_RADIUS);
  c.stroke();

  // A selected timeline's outline and resize handles are Core's (core/lib/
  // gridRenderer/rendering/floatingObjectChrome.ts, BUG-0258 design phase 3):
  // the half-clipped border this drew is gone, and the handles are painted
  // exactly where Core's selection-gated resize answers.

  c.restore(); // restore outer clip
}

/** The focus ring inside a period's tile (x, y, w, h: the tile, in canvas px). */
function drawFocusRing(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  if (w < 6 || h < 6) return;
  c.save();
  c.strokeStyle = TIMELINE_FOCUS_RING_DARK;
  c.lineWidth = 2;
  c.beginPath();
  c.rect(x + 1, y + 1, w - 2, h - 2);
  c.stroke();
  c.strokeStyle = TIMELINE_FOCUS_RING_LIGHT;
  c.lineWidth = 1;
  c.beginPath();
  c.rect(x + 2.5, y + 2.5, w - 5, h - 5);
  c.stroke();
  c.restore();
}

/**
 * Every colour set the renderer can paint (`getStyleColors`): the gallery's
 * presets by id, the legacy ids the gallery does not shadow, and the fallback
 * for an unknown id -- for the focus ring's contrast test.
 */
export function timelinePresetColorSets(): Array<{ id: string; colors: TimelineStyleColors }> {
  const sets: Array<{ id: string; colors: TimelineStyleColors }> = [];
  for (const [id, style] of TIMELINE_STYLES_BY_ID) sets.push({ id, colors: style.colors });
  for (const [id, colors] of Object.entries(LEGACY_STYLES)) {
    if (!TIMELINE_STYLES_BY_ID.has(id)) sets.push({ id, colors });
  }
  sets.push({ id: "<unknown preset>", colors: DEFAULT_COLORS });
  return sets;
}

// ============================================================================
// Scrollbar
// ============================================================================

/** The track and thumb; the thumb is the zone table's (the drag grabs it there). */
function drawHScrollbar(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  trackWidth: number,
  height: number,
  thumb: { x: number; width: number },
): void {
  c.fillStyle = "rgba(0, 0, 0, 0.05)";
  c.fillRect(x, y, trackWidth, height);

  c.fillStyle = "rgba(0, 0, 0, 0.25)";
  c.beginPath();
  c.roundRect(x + thumb.x, y + 1, thumb.width, height - 2, (height - 2) / 2);
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

/**
 * What a point on a timeline IS, in the words the rest of the app (and the
 * live journeys) already use. An adapter over the zone table
 * (lib/timelineZones.ts) -- never a second geometry: the year-label strip, the
 * empty space and the level-row gaps, which are FRAME, answer "body"; only
 * the month-tile row answers "period".
 */
export function getTimelineHitDetail(
  canvasX: number,
  canvasY: number,
  bounds: { x: number; y: number; width: number; height: number },
  timelineId: string,
): TimelineHitResult | null {
  const zone = timelineZoneAtCanvas(timelineId, canvasX, canvasY, bounds);
  if (!zone) return getTimelineById(timelineId) ? { type: "body" } : null;
  switch (zone.part) {
    case "header":
      return { type: "header" };
    case "clearButton":
      return { type: "clearButton" };
    case "period":
      return { type: "period", periodIndex: zone.periodIndex };
    case "rangeStart":
      return { type: "selectionHandleStart" };
    case "rangeEnd":
      return { type: "selectionHandleEnd" };
    case "levelButton":
      return { type: "levelButton", level: zone.level };
    case "scrollbar":
      return { type: "scrollbar" };
    case "yearStrip":
    case "empty":
    case "levelGap":
      return { type: "body" };
  }
}
