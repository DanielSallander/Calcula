//! FILENAME: app/extensions/TimelineSlicer/lib/timelineRangeDrag.ts
// PURPOSE: The timeline's CONTENT gesture (BUG-0258): a press on the month
//          tiles drags out a date range, a press on a range-end marker moves
//          that end, a press on the clear or a level button acts when it is
//          RELEASED over the same button, and a press on the scrollbar drags
//          the periods. Nothing here moves the timeline -- its frame does that
//          (lib/timelineZones.ts), through Core.
// CONTEXT: Core asks the registration's `zoneAt` ONCE per press, BEFORE the
//          press selects anything (overlayMoveHandlers.ts `pressZone`), and
//          for a content zone it selects the timeline as a plain press and
//          dispatches `floatingObject:bodyDragStart` -- never a move, whatever
//          the lock or the subscription. index.ts hands that press here, the
//          way the chart brush takes its in-plot drag (Charts/index.ts). So
//          the FIRST press on an unselected timeline already selects a range,
//          as in Excel, and filtering keeps working on a locked timeline and
//          on a subscribed canvas page (owner decision 2026-09-29: filtering
//          is reading the report, not editing it; only moving and resizing
//          obey the lock).
//
//          THE RULES THIS FILE KEEPS:
//            - ONE commit, at release, through `updateTimelineSelectionAsync`
//              with `askBeforeOverwrite` -- one undo step for the range and
//              the pivots it filters, one overwrite question. While the
//              pointer moves, only a TRANSIENT preview changes, which only
//              the screen reads -- the renderer and the zone hooks (no
//              backend write, no dirty flag).
//            - A release with no movement (Core's 3px threshold) selects the
//              ONE period pressed. A press on a range-end marker anchors the
//              OPPOSITE end, and a marker released in place commits nothing.
//              A range whose DATES are already the committed ones commits
//              nothing -- the dates, never the periods' `isSelected` flags:
//              the backend flags a period by OVERLAP and a level change keeps
//              the dates, so Apr 5-20 flags all of April, and judging by the
//              flags made a click on April do nothing at all.
//            - What the gesture SHOWS -- the range to paint and hit-test --
//              is published to timelineGestureView.ts, which the renderer and
//              the zone input read. The pointer it owns while the button is
//              held is held through Core's seam (`holdContentGestureCursor`
//              under the region Core pressed) and released on EVERY end path:
//              release, Escape, blur, a lost release, the next press.
//            - The window listeners live only as long as the gesture: bound
//              at the press, removed at release, Escape, window blur, a move
//              with the primary button UP (a release this page never heard),
//              or a release of another button with the primary one up (a
//              MIDDLE press starts a gesture too: Core hands every
//              non-secondary press over; BUG-0258 M7 review). A period click once armed a "drag" that a bare
//              mousemove grew and the next unrelated mouseup committed
//              (found live 2026-09-29, e2e fixall-pivot WF-D3);
//              timelineNoPhantomDrag.test.ts scans this file for that shape.
//            - Escape belongs to the gesture: it cancels with no commit, and
//              the timeline's object-selection provider owns Escape meanwhile
//              (`isTimelineContentGestureActive`), so a canvas does not also
//              deselect the timeline under the drag.
//            - Shift+press on a period EXTENDS the range shown (design phase
//              2) from its ANCHOR: the period the last range gesture on this
//              timeline started at -- a plain click, a drag's press, or the
//              end a marker drag left in place -- and a Shift+press keeps it
//              (the Windows list convention: click July, Shift+click February,
//              Shift+click April gives April..July). The anchor is remembered
//              for the session with the DATES its gesture left, and used only
//              while the range shown still is exactly those dates at the same
//              level; a range no gesture of ours left (the backend's, a
//              script's, a refresh's) falls back to the range's POSITION: a
//              press at or after its first period anchors that first period, a
//              press before it anchors the last. With no range it is a plain
//              click; markers, buttons and the scrollbar ignore Shift; the
//              release still commits ONCE. Core hands the raw Shift over on
//              `bodyDragStart` only: on content it never reaches the object
//              selection, so a canvas does not toggle the timeline out of its
//              selection. Excel's own timeline Shift+click was never checked
//              in Excel.

import { holdContentGestureCursor, requestOverlayRedraw } from "@api/gridOverlays";
import {
  getTimelineById,
  updateTimelineAsync,
  updateTimelineSelectionAsync,
} from "./timelineSlicerStore";
import { getScrollOffset, liveTimelineZoneInput, setScrollOffset } from "./timelineView";
import { resetTimelineGestureView, showTimelineGesture } from "./timelineGestureView";
import { commitTimelineSpan, rememberedTimelineAnchor, resetTimelineCommit } from "./timelineCommit";
import {
  TIMELINE_ZONE_TABLE,
  computeTimelineLayout,
  isTimelineFiltered,
  periodIndexNear,
  scrollOffsetForThumbX,
  scrollbarThumbOf,
  timelineAutoScrollStep,
  timelineZoneAt,
  type TimelineSpan,
  type TimelineZoneInput,
} from "./timelineZones";
import type { TimelineLevel } from "./timelineSlicerTypes";

// The range to paint lives in timelineGestureView.ts (the renderer and the
// zone input read it there); re-exported for the callers that know this file.
export { getTimelineRangePreview } from "./timelineGestureView";

// ============================================================================
// Types
// ============================================================================

export interface CanvasRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CanvasPoint {
  x: number;
  y: number;
}

/** A content press, as index.ts hands it over from `floatingObject:bodyDragStart`. */
export interface TimelineContentPress {
  timelineId: string;
  /**
   * The grid region Core pressed (its `regionId`): the gesture holds Core's
   * pointer over THAT region while the button is held.
   */
  regionId: string;
  /** Where the press landed, in logical canvas px (Core's own basis). */
  canvasX: number;
  canvasY: number;
  /**
   * Shift was held: a press on a period extends the range shown instead of
   * starting a new one. The raw modifier Core hands the content.
   */
  extend?: boolean;
  /** The timeline's canvas rectangle NOW (the grid may scroll mid-gesture). */
  boundsOf: () => CanvasRect | null;
  /** A window mouse event's point in logical canvas px; null before mount. */
  clientToCanvas: (clientX: number, clientY: number) => CanvasPoint | null;
  /** Runs once when the gesture is RELEASED (never on a cancel), before it acts. */
  onRelease?: () => void;
}

/** Core's click-vs-drag threshold (logical px, either axis). */
export const TIMELINE_DRAG_THRESHOLD_PX = 3;
/** How often an edge auto-scroll steps while the pointer stays out there. */
export const TIMELINE_AUTOSCROLL_INTERVAL_MS = 30;
/** The pointer a range drag shows once it is under way (a range end is moving). */
const MOVING_RANGE_CURSOR = TIMELINE_ZONE_TABLE.rangeEnd.cursor ?? "ew-resize";

interface SessionBase {
  timelineId: string;
  press: TimelineContentPress;
  /** The zone table's pointer for the part pressed (the gesture keeps it). */
  pressCursor: string;
  detach: () => void;
  /** Lets go of Core's pointer this gesture holds (every end path runs it). */
  releaseCursor: () => void;
}

interface RangeSession extends SessionBase {
  mode: "range";
  /** The end that stays put. */
  anchor: number;
  /** The end under the pointer. */
  current: number;
  /** Pressed on a range-end marker (released in place, it changes nothing). */
  fromMarker: boolean;
  /** The pointer has left the click dead zone. */
  moved: boolean;
  /** The last pointer x, from the timeline's left edge (auto-scroll re-reads it). */
  lastRelX: number;
  autoScroll: ReturnType<typeof setInterval> | null;
}

interface ButtonSession extends SessionBase {
  mode: "button";
  part: "clearButton" | "levelButton";
  level?: TimelineLevel;
}

interface ScrollSession extends SessionBase {
  mode: "scroll";
  /** Where on the thumb it was grabbed (px from the thumb's left edge). */
  grab: number;
}

type Session = RangeSession | ButtonSession | ScrollSession;

let session: Session | null = null;

// The Shift+press anchor memory (what the last range gesture on a timeline
// left, by start date) and the ONE commit rule live in timelineCommit.ts: the
// keyboard inside a timeline (timelineKeys.ts, M8 S8) commits through them too.

// ============================================================================
// Queries (the object-selection provider)
// ============================================================================

/** Whether a content gesture on some timeline is live (it owns Escape). */
export function isTimelineContentGestureActive(): boolean {
  return session !== null;
}

function spanOf(s: RangeSession): TimelineSpan {
  return { first: Math.min(s.anchor, s.current), last: Math.max(s.anchor, s.current) };
}

/**
 * Publish what the live gesture shows: its range (timelineGestureView.ts)
 * and its pointer (held over the pressed region through Core's seam, so
 * Core's hover shows it wherever on that timeline the pointer is). Called at
 * every change to either, and with null when the gesture ends -- the
 * pointer itself is let go by `endSession`, on every end path.
 */
function show(s: Session | null): void {
  if (s === null) {
    showTimelineGesture(null);
    return;
  }
  showTimelineGesture({
    timelineId: s.timelineId,
    span: s.mode === "range" ? spanOf(s) : null,
  });
  // Holding again for the same region updates the pointer and keeps the one
  // hold, so the latest release is the release of the whole gesture.
  s.releaseCursor = holdContentGestureCursor(
    s.press.regionId,
    s.mode === "range" && s.moved ? MOVING_RANGE_CURSOR : s.pressCursor,
  );
}

// ============================================================================
// The gesture
// ============================================================================

/**
 * Start the content gesture for a press Core handed over. Returns false (and
 * binds nothing) when the press is not on the timeline's content after all --
 * the timeline vanished, or its data changed under the pointer.
 */
export function beginTimelineContentPress(press: TimelineContentPress): boolean {
  // A gesture whose release was never heard ends here, with no commit.
  cancelTimelineContentPress();

  const bounds = press.boundsOf();
  const input = liveTimelineZoneInput(press.timelineId);
  if (!bounds || !input) return false;
  const relX = press.canvasX - bounds.x;
  const relY = press.canvasY - bounds.y;
  const zone = timelineZoneAt(input, relX, relY);
  if (zone.kind !== "content") return false;

  const base: SessionBase = {
    timelineId: press.timelineId,
    press,
    pressCursor: zone.cursor ?? "default",
    detach: () => {},
    releaseCursor: () => {},
  };
  let started: Session;
  switch (zone.part) {
    case "period": {
      if (zone.periodIndex == null) return false;
      // Shift extends the range SHOWN (a released drag's while its commit
      // lands) from its anchor -- the last gesture's, while that range still
      // stands, else by position -- and the press becomes the moving end.
      const shown = press.extend === true ? input.selected : null;
      const anchor = shown
        ? rememberedTimelineAnchor(press.timelineId, input.level, shown) ??
          (zone.periodIndex >= shown.first ? shown.first : shown.last)
        : zone.periodIndex;
      started = rangeSession(base, anchor, zone.periodIndex, relX, false);
      break;
    }
    case "rangeStart":
    case "rangeEnd": {
      // The range as SHOWN (a released drag's while its commit lands).
      const shown = input.selected;
      if (!shown) return false;
      // The marker pressed follows the pointer; the OTHER end stays.
      started =
        zone.part === "rangeStart"
          ? rangeSession(base, shown.last, shown.first, relX, true)
          : rangeSession(base, shown.first, shown.last, relX, true);
      break;
    }
    case "clearButton":
      started = { ...base, mode: "button", part: "clearButton" };
      break;
    case "levelButton":
      started = { ...base, mode: "button", part: "levelButton", level: zone.level };
      break;
    case "scrollbar": {
      const layout = computeTimelineLayout(input, input.periodCount);
      const thumb = scrollbarThumbOf(layout, input.scrollOffset);
      const onThumb = relX >= thumb.x && relX <= thumb.x + thumb.width;
      started = { ...base, mode: "scroll", grab: onThumb ? relX - thumb.x : thumb.width / 2 };
      if (!onThumb) {
        // A press on the track brings the thumb under the pointer.
        setScrollOffset(press.timelineId, scrollOffsetForThumbX(layout, relX - started.grab));
      }
      break;
    }
    default:
      return false;
  }

  window.addEventListener("mousemove", onSessionMove);
  window.addEventListener("mouseup", onSessionUp);
  window.addEventListener("keydown", onSessionKey, true);
  window.addEventListener("blur", onSessionBlur);
  started.detach = () => {
    window.removeEventListener("mousemove", onSessionMove);
    window.removeEventListener("mouseup", onSessionUp);
    window.removeEventListener("keydown", onSessionKey, true);
    window.removeEventListener("blur", onSessionBlur);
  };
  session = started;
  show(started);
  requestOverlayRedraw();
  return true;
}

/** End the live gesture WITHOUT acting (Escape, blur, a lost release, deactivation). */
export function cancelTimelineContentPress(): void {
  endSession(null);
}

/** Drop every trace, for deactivation and tests. */
export function resetTimelineContentPress(): void {
  cancelTimelineContentPress();
  resetTimelineGestureView();
  resetTimelineCommit();
}

function rangeSession(
  base: SessionBase,
  anchor: number,
  current: number,
  relX: number,
  fromMarker: boolean,
): RangeSession {
  return { ...base, mode: "range", anchor, current, fromMarker, moved: false, lastRelX: relX, autoScroll: null };
}

// ============================================================================
// Window listeners (bound only while a gesture lives)
// ============================================================================

const onSessionMove = (e: MouseEvent): void => {
  const s = session;
  if (!s) return;
  // The gesture exists only while the primary button is HELD: a move with it
  // up means the release was never heard, and following the bare pointer is
  // exactly the phantom drag this file must never be again. Nothing commits.
  if ((e.buttons & 1) === 0) {
    endSession(null);
    return;
  }
  const at = pointerAt(s, e);
  if (!at) return;
  if (s.mode === "range") {
    trackRange(s, at);
  } else if (s.mode === "scroll") {
    trackScroll(s, at);
  }
};

const onSessionUp = (e: MouseEvent): void => {
  const s = session;
  if (!s) return;
  if (e.button !== 0) {
    // Another button let go. With the primary one still held the gesture goes
    // on; with it up this was never a primary press (a MIDDLE press starts a
    // gesture too), and it ends here with no commit.
    if ((e.buttons & 1) === 0) endSession(null);
    return;
  }
  const at = pointerAt(s, e);
  if (s.mode === "range" && at) trackRange(s, at);
  endSession(at ?? { relX: Number.NaN, relY: Number.NaN, width: 0 });
};

const onSessionKey = (e: KeyboardEvent): void => {
  if (!session || e.key !== "Escape") return;
  // The Escape is the gesture's: nothing else acts on it too.
  e.preventDefault();
  e.stopPropagation();
  endSession(null);
};

const onSessionBlur = (): void => {
  endSession(null);
};

interface RelPoint {
  relX: number;
  relY: number;
  width: number;
}

function pointerAt(s: Session, e: MouseEvent): RelPoint | null {
  const p = s.press.clientToCanvas(e.clientX, e.clientY);
  const bounds = s.press.boundsOf();
  if (!p || !bounds) return null;
  return { relX: p.x - bounds.x, relY: p.y - bounds.y, width: bounds.width };
}

// ============================================================================
// Range
// ============================================================================

function trackRange(s: RangeSession, at: RelPoint): void {
  s.lastRelX = at.relX;
  if (!s.moved) {
    const bounds = s.press.boundsOf();
    const pressRelX = s.press.canvasX - (bounds?.x ?? 0);
    const pressRelY = s.press.canvasY - (bounds?.y ?? 0);
    const dx = Math.abs(at.relX - pressRelX);
    const dy = Math.abs(at.relY - pressRelY);
    if (dx <= TIMELINE_DRAG_THRESHOLD_PX && dy <= TIMELINE_DRAG_THRESHOLD_PX) return;
    s.moved = true;
    show(s);
  }
  followPointer(s);
  syncAutoScroll(s, at.width);
}

/** Put the moving end under the pointer; repaint when it changed. */
function followPointer(s: RangeSession): void {
  const input = liveTimelineZoneInput(s.timelineId);
  if (!input) return;
  const index = periodIndexNear(input, s.lastRelX);
  if (index === null || index === s.current) return;
  s.current = index;
  show(s);
  requestOverlayRedraw();
}

function syncAutoScroll(s: RangeSession, width: number): void {
  const step = timelineAutoScrollStep(s.lastRelX, width);
  if (step === 0) {
    stopAutoScroll(s);
    return;
  }
  if (s.autoScroll !== null) return;
  s.autoScroll = setInterval(() => {
    if (session !== s) {
      stopAutoScroll(s);
      return;
    }
    const bounds = s.press.boundsOf();
    const now = timelineAutoScrollStep(s.lastRelX, bounds?.width ?? width);
    if (now === 0) {
      stopAutoScroll(s);
      return;
    }
    const before = getScrollOffset(s.timelineId);
    setScrollOffset(s.timelineId, before + now);
    if (getScrollOffset(s.timelineId) !== before) requestOverlayRedraw();
    followPointer(s);
  }, TIMELINE_AUTOSCROLL_INTERVAL_MS);
}

function stopAutoScroll(s: Session): void {
  if (s.mode !== "range" || s.autoScroll === null) return;
  clearInterval(s.autoScroll);
  s.autoScroll = null;
}

/**
 * The ONE commit of a released range drag, through the rule the keyboard
 * shares (timelineCommit.ts `commitTimelineSpan`: the DATES decide "already
 * the range", one undo step, the anchor remembered, the range held on screen
 * until it lands).
 */
function commitRange(s: RangeSession): void {
  // A range end grabbed and let go in place changes nothing -- not even a
  // range whose dates start or end INSIDE a period, which a commit of the
  // span would quietly round out to whole periods.
  if (s.fromMarker && !s.moved) return;
  void commitTimelineSpan(s.timelineId, spanOf(s), s.anchor);
}

// ============================================================================
// Scrollbar
// ============================================================================

function trackScroll(s: ScrollSession, at: RelPoint): void {
  const input: TimelineZoneInput | null = liveTimelineZoneInput(s.timelineId);
  if (!input) return;
  const layout = computeTimelineLayout(input, input.periodCount);
  const before = getScrollOffset(s.timelineId);
  setScrollOffset(s.timelineId, scrollOffsetForThumbX(layout, at.relX - s.grab));
  if (getScrollOffset(s.timelineId) !== before) requestOverlayRedraw();
}

// ============================================================================
// Buttons
// ============================================================================

/** A button acts only when it is released over ITSELF. */
function releaseButton(s: ButtonSession, at: RelPoint): void {
  const input = liveTimelineZoneInput(s.timelineId);
  if (!input || !Number.isFinite(at.relX) || !Number.isFinite(at.relY)) return;
  if (at.relX < 0 || at.relY < 0 || at.relX > input.width || at.relY > input.height) return;
  const zone = timelineZoneAt(input, at.relX, at.relY);
  if (zone.part !== s.part || zone.level !== s.level) return;

  if (s.part === "clearButton") {
    const tl = getTimelineById(s.timelineId);
    if (tl && isTimelineFiltered(tl)) {
      void updateTimelineSelectionAsync(s.timelineId, null, null, { askBeforeOverwrite: true });
    }
    return;
  }
  if (s.level) {
    void updateTimelineAsync(s.timelineId, { level: s.level })
      .then(() => requestOverlayRedraw())
      .catch(console.error);
  }
}

// ============================================================================
// End
// ============================================================================

/**
 * End the live gesture. `release` is where the pointer was released (the
 * gesture ACTS), or null for a cancel (nothing is committed).
 */
function endSession(release: RelPoint | null): void {
  const s = session;
  if (!s) return;
  session = null;
  show(null);
  s.releaseCursor();
  s.detach();
  stopAutoScroll(s);
  if (release) {
    s.press.onRelease?.();
    if (s.mode === "range") commitRange(s);
    else if (s.mode === "button") releaseButton(s, release);
  }
  requestOverlayRedraw();
}
