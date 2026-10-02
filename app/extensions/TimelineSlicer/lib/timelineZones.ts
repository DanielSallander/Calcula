//! FILENAME: app/extensions/TimelineSlicer/lib/timelineZones.ts
// PURPOSE: The timeline's ZONE TABLE (BUG-0258): which part of a timeline a
//          point is on, and whether a press there belongs to the timeline's
//          CONTENT (it works: select a range, press a button, drag the
//          scrollbar) or to its FRAME (Core moves the object). PURE -- no
//          store, no DOM, no clock -- so the same answer can drive the press
//          and the pointer shape, and a test can walk every point.
// CONTEXT: Owner decision 2026-09-29 (design "Button Code and Moving Objects",
//          Part 2): the frame moves an object, its content does its own job,
//          and the pointer shape says which is which. Before this, the whole
//          timeline was frame: the cursor promised a hand over the month
//          tiles and a sideways arrow over the range ends, while a drag from
//          either MOVED the timeline (BUG-0258), so a date range could not be
//          dragged at all.
//
//          THE TABLE (TIMELINE_ZONE_TABLE below):
//            content  the month tiles ('pointer'), the two range-end markers
//                     ('ew-resize'), the clear-filter button WHILE there is a
//                     filter to clear and the level buttons ('pointer': a
//                     button acts on RELEASE over itself), the scrollbar
//                     ('default')
//            frame    the header (including the clear button's corner while
//                     the timeline is unfiltered: the button is painted
//                     dimmed and does nothing), the year-label strip above
//                     the tiles (owner decision: it moves the timeline, as
//                     Excel's "upper part" does), the empty space under and
//                     beside the tiles, and the gaps in the level row
//          A frame zone has NO cursor of its own: Core's answer applies
//          ('move' where the timeline can move, 'default' where it is locked
//          or on a subscribed page), because Core decides what a press there
//          does. A content zone always names its cursor.
//          `timelineZones.test.ts` holds the registration's ONE zone answer
//          (`zoneAt`, timelineView.ts `timelineOverlayZoneAt`) to this table
//          over a grid of points.
//
//          The renderer paints from `computeTimelineLayout`, so the zones are
//          measured on the geometry that is painted, never on a copy of it.

import type { TimelineLevel } from "./timelineSlicerTypes";

// ============================================================================
// Geometry constants (the renderer paints with these)
// ============================================================================

export const TIMELINE_HEADER_HEIGHT = 28;
export const TIMELINE_GROUP_LABEL_HEIGHT = 18;
export const TIMELINE_PERIOD_HEIGHT = 28;
export const TIMELINE_LEVEL_SELECTOR_HEIGHT = 24;
export const TIMELINE_SCROLLBAR_HEIGHT = 8;
export const TIMELINE_CLEAR_BUTTON_SIZE = 18;
/** Gap between the clear-filter button and the timeline's right edge. */
export const TIMELINE_CLEAR_BUTTON_MARGIN = 4;
export const TIMELINE_LEVEL_BUTTON_WIDTH = 68;
export const TIMELINE_LEVEL_BUTTON_GAP = 4;
/** The level buttons, left to right. */
export const TIMELINE_LEVELS: readonly TimelineLevel[] = ["years", "quarters", "months", "days"];
/** Half the width of a range-end marker's grab band, either side of the range edge. */
export const TIMELINE_RANGE_MARKER_HALF_WIDTH = 6;

const PERIOD_MIN_WIDTH = 40;
const SCROLLBAR_MIN_THUMB_WIDTH = 20;

// ============================================================================
// Layout
// ============================================================================

/** The parts of a timeline's configuration its layout depends on. */
export interface TimelineShape {
  width: number;
  height: number;
  showHeader: boolean;
  showLevelSelector: boolean;
  showScrollbar: boolean;
  level: TimelineLevel;
}

/**
 * A timeline's layout. Every `...Top` / `...Bottom` is measured from the
 * timeline's own top edge (0 = the top of the object).
 */
export interface TimelineLayout {
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
  /** Top of the year-label strip (= the header's height). */
  yearStripTop: number;
  /** Top of the month-tile row (the year strip's bottom). */
  tileTop: number;
  /** Bottom of the month-tile row. */
  tileBottom: number;
  /** Bottom of the area the strip and the tiles are painted in (clipped there). */
  periodAreaBottom: number;
  /** Top of the level-button row (meaningful only when it is shown). */
  levelTop: number;
  /** Top of the scrollbar strip (meaningful only when it is shown). */
  scrollbarTop: number;
}

/** The width of one period tile at a level. */
export function periodWidthFor(level: TimelineLevel): number {
  switch (level) {
    case "years":
      return Math.max(PERIOD_MIN_WIDTH, 80);
    case "quarters":
      return Math.max(PERIOD_MIN_WIDTH, 60);
    case "months":
      return Math.max(PERIOD_MIN_WIDTH, 50);
    case "days":
      return Math.max(PERIOD_MIN_WIDTH - 10, 30);
    default:
      return PERIOD_MIN_WIDTH;
  }
}

export function computeTimelineLayout(shape: TimelineShape, periodCount: number): TimelineLayout {
  const headerH = shape.showHeader ? TIMELINE_HEADER_HEIGHT : 0;
  const groupLabelH = TIMELINE_GROUP_LABEL_HEIGHT;
  const periodH = TIMELINE_PERIOD_HEIGHT;
  const levelSelectorH = shape.showLevelSelector ? TIMELINE_LEVEL_SELECTOR_HEIGHT : 0;
  const scrollbarH = shape.showScrollbar ? TIMELINE_SCROLLBAR_HEIGHT : 0;
  const periodWidth = periodWidthFor(shape.level);
  const contentWidth = periodCount * periodWidth;
  const viewportWidth = shape.width;
  const tileTop = headerH + groupLabelH;
  return {
    headerH,
    groupLabelH,
    periodH,
    levelSelectorH,
    scrollbarH,
    periodWidth,
    contentWidth,
    viewportWidth,
    viewportTop: headerH,
    needsScroll: contentWidth > viewportWidth,
    totalPeriods: periodCount,
    yearStripTop: headerH,
    tileTop,
    tileBottom: tileTop + periodH,
    periodAreaBottom: shape.height - levelSelectorH - scrollbarH,
    levelTop: shape.height - levelSelectorH - scrollbarH,
    scrollbarTop: shape.height - scrollbarH,
  };
}

/** How far the periods can scroll (0 when they all fit). */
export function maxScrollOf(layout: TimelineLayout): number {
  return Math.max(0, layout.contentWidth - layout.viewportWidth);
}

/** A scroll offset kept inside [0, max]. */
export function clampScroll(layout: TimelineLayout, offset: number): number {
  return Math.max(0, Math.min(offset, maxScrollOf(layout)));
}

/** The left edge of level button `i`, measured from the timeline's left edge. */
export function levelButtonLeft(width: number, i: number): number {
  const n = TIMELINE_LEVELS.length;
  const total = n * TIMELINE_LEVEL_BUTTON_WIDTH + (n - 1) * TIMELINE_LEVEL_BUTTON_GAP;
  return (width - total) / 2 + i * (TIMELINE_LEVEL_BUTTON_WIDTH + TIMELINE_LEVEL_BUTTON_GAP);
}

/** The scrollbar thumb: its left edge (from the timeline's left edge) and width. */
export function scrollbarThumbOf(layout: TimelineLayout, scrollOffset: number): { x: number; width: number } {
  const track = layout.viewportWidth;
  const content = Math.max(layout.contentWidth, 1);
  const width = Math.max(SCROLLBAR_MIN_THUMB_WIDTH, track * (track / content));
  const scrollRange = layout.contentWidth - track;
  const thumbRange = track - width;
  const x = scrollRange > 0 ? (clampScroll(layout, scrollOffset) / scrollRange) * thumbRange : 0;
  return { x, width };
}

/** The scroll offset that puts the thumb's left edge at `thumbX`. */
export function scrollOffsetForThumbX(layout: TimelineLayout, thumbX: number): number {
  const { width } = scrollbarThumbOf(layout, 0);
  const thumbRange = layout.viewportWidth - width;
  const scrollRange = layout.contentWidth - layout.viewportWidth;
  if (thumbRange <= 0 || scrollRange <= 0) return 0;
  return Math.max(0, Math.min(1, thumbX / thumbRange)) * scrollRange;
}

// ============================================================================
// Selected span
// ============================================================================

/** A run of periods, first and last index inclusive. */
export interface TimelineSpan {
  first: number;
  last: number;
}

/** The first and last selected period, or null when none is. */
export function selectedSpanOf(periods: readonly { isSelected: boolean }[]): TimelineSpan | null {
  const first = periods.findIndex((p) => p.isSelected);
  if (first < 0) return null;
  let last = first;
  for (let i = periods.length - 1; i > first; i--) {
    if (periods[i].isSelected) {
      last = i;
      break;
    }
  }
  return { first, last };
}

// ============================================================================
// The zone table
// ============================================================================

/** Every part of a timeline a point can be on. */
export type TimelineZonePart =
  | "header"
  | "clearButton"
  | "yearStrip"
  | "period"
  | "rangeStart"
  | "rangeEnd"
  | "empty"
  | "levelButton"
  | "levelGap"
  | "scrollbar";

export type TimelineZoneKind = "frame" | "content";

export interface TimelineZoneRule {
  kind: TimelineZoneKind;
  /** The pointer shape. Null on the frame: Core's answer applies ('move', or 'default' where it cannot move). */
  cursor: string | null;
}

/**
 * THE table. The registration's ONE zone answer (`zoneAt`, timelineView.ts)
 * is read from here -- the kind, and the cursor of a content zone -- and Core
 * derives both the press and the pointer shape from that one answer, so they
 * cannot drift apart again.
 */
export const TIMELINE_ZONE_TABLE: Readonly<Record<TimelineZonePart, TimelineZoneRule>> = {
  header: { kind: "frame", cursor: null },
  clearButton: { kind: "content", cursor: "pointer" },
  yearStrip: { kind: "frame", cursor: null },
  period: { kind: "content", cursor: "pointer" },
  rangeStart: { kind: "content", cursor: "ew-resize" },
  rangeEnd: { kind: "content", cursor: "ew-resize" },
  empty: { kind: "frame", cursor: null },
  levelButton: { kind: "content", cursor: "pointer" },
  levelGap: { kind: "frame", cursor: null },
  scrollbar: { kind: "content", cursor: "default" },
};

/** The part under a point, with the table's answer for it. */
export interface TimelineZone extends TimelineZoneRule {
  part: TimelineZonePart;
  /** The period under the point ("period" only). */
  periodIndex?: number;
  /** The level the button sets ("levelButton" only). */
  level?: TimelineLevel;
}

/** Everything the zone answer depends on. */
export interface TimelineZoneInput extends TimelineShape {
  periodCount: number;
  /**
   * The range as PAINTED -- where the range-end markers are: a released
   * drag's range while its commit lands, else the committed one -- or null.
   */
  selected: TimelineSpan | null;
  /** Whether there is a filter to clear (the clear button is live). */
  filtered: boolean;
  /** The periods' horizontal scroll (clamped here). */
  scrollOffset: number;
}

/**
 * Whether a timeline carries a filter -- the ONE predicate the renderer
 * (the clear button lit or dimmed), the zone table (the button is content or
 * header) and the button's release all read.
 */
export function isTimelineFiltered(timeline: { selectionStart: string | null }): boolean {
  return timeline.selectionStart !== null;
}

/**
 * Build the zone input from a timeline, its periods and its scroll.
 * `shownSpan` is the range the renderer paints instead of the committed one
 * (a released drag's, until its commit lands); the markers are placed on it,
 * so what is painted is what a press hits.
 */
export function zoneInputOf(
  timeline: TimelineShape & { selectionStart: string | null },
  periods: readonly { isSelected: boolean }[],
  scrollOffset: number,
  shownSpan: TimelineSpan | null = null,
): TimelineZoneInput {
  return {
    width: timeline.width,
    height: timeline.height,
    showHeader: timeline.showHeader,
    showLevelSelector: timeline.showLevelSelector,
    showScrollbar: timeline.showScrollbar,
    level: timeline.level,
    periodCount: periods.length,
    selected: shownSpan ?? selectedSpanOf(periods),
    filtered: isTimelineFiltered(timeline),
    scrollOffset,
  };
}

function zone(part: TimelineZonePart, extra: Partial<Pick<TimelineZone, "periodIndex" | "level">> = {}): TimelineZone {
  return { part, ...TIMELINE_ZONE_TABLE[part], ...extra };
}

/**
 * The zone at a point measured from the timeline's top-left corner. Earlier
 * rows win where they overlap: header, level row, scrollbar, then the period
 * area (year strip, tile row, empty space) -- the order the painter layers them.
 */
export function timelineZoneAt(input: TimelineZoneInput, relX: number, relY: number): TimelineZone {
  const layout = computeTimelineLayout(input, input.periodCount);
  const scroll = clampScroll(layout, input.scrollOffset);

  if (input.showHeader && relY < layout.headerH) {
    // The clear button works only while there is a filter; unfiltered it is
    // painted dimmed and inert, so its corner is the header's (Core's move).
    return input.filtered && relX > input.width - TIMELINE_CLEAR_BUTTON_SIZE - TIMELINE_CLEAR_BUTTON_MARGIN
      ? zone("clearButton")
      : zone("header");
  }

  if (input.showLevelSelector && relY >= layout.levelTop && relY < layout.levelTop + TIMELINE_LEVEL_SELECTOR_HEIGHT) {
    for (let i = 0; i < TIMELINE_LEVELS.length; i++) {
      const lx = levelButtonLeft(input.width, i);
      if (relX >= lx && relX <= lx + TIMELINE_LEVEL_BUTTON_WIDTH) {
        return zone("levelButton", { level: TIMELINE_LEVELS[i] });
      }
    }
    return zone("levelGap");
  }

  if (layout.needsScroll && input.showScrollbar && relY >= layout.scrollbarTop) {
    return zone("scrollbar");
  }

  if (relY < layout.tileTop) return zone("yearStrip");

  if (relY < layout.tileBottom && relY < layout.periodAreaBottom) {
    if (input.selected) {
      const startX = input.selected.first * layout.periodWidth - scroll;
      const endX = (input.selected.last + 1) * layout.periodWidth - scroll;
      if (Math.abs(relX - startX) < TIMELINE_RANGE_MARKER_HALF_WIDTH) return zone("rangeStart");
      if (Math.abs(relX - endX) < TIMELINE_RANGE_MARKER_HALF_WIDTH) return zone("rangeEnd");
    }
    const periodIndex = Math.floor((relX + scroll) / layout.periodWidth);
    if (periodIndex >= 0 && periodIndex < input.periodCount) return zone("period", { periodIndex });
  }

  return zone("empty");
}

// ============================================================================
// Range drag helpers
// ============================================================================

/**
 * The period a range drag is over at `relX` -- any height, and clamped to the
 * VISIBLE periods, so a pointer that has left the timeline sideways holds the
 * first or last one on screen (auto-scroll then brings more). Null when there
 * are no periods.
 */
export function periodIndexNear(input: TimelineZoneInput, relX: number): number | null {
  if (input.periodCount <= 0) return null;
  const layout = computeTimelineLayout(input, input.periodCount);
  const scroll = clampScroll(layout, input.scrollOffset);
  const x = Math.max(0, Math.min(relX, input.width - 1));
  const index = Math.floor((x + scroll) / layout.periodWidth);
  return Math.max(0, Math.min(index, input.periodCount - 1));
}

/** How close to a side edge (px) a range drag starts scrolling the periods. */
export const TIMELINE_AUTOSCROLL_EDGE = 16;
const AUTOSCROLL_MIN_STEP = 6;
const AUTOSCROLL_MAX_STEP = 40;

/**
 * The scroll step (px per tick) for a range drag's pointer at `relX`:
 * negative near or past the left edge, positive near or past the right edge,
 * faster the further out, 0 in between.
 */
export function timelineAutoScrollStep(relX: number, width: number): number {
  const edge = TIMELINE_AUTOSCROLL_EDGE;
  if (relX < edge) {
    return -Math.min(AUTOSCROLL_MAX_STEP, AUTOSCROLL_MIN_STEP + Math.round((edge - relX) / 2));
  }
  if (relX > width - edge) {
    return Math.min(AUTOSCROLL_MAX_STEP, AUTOSCROLL_MIN_STEP + Math.round((relX - (width - edge)) / 2));
  }
  return 0;
}
