//! FILENAME: app/extensions/TimelineSlicer/lib/timelineKeys.ts
// PURPOSE: The keyboard INSIDE a selected timeline (M8 S8; BUG-0258 design
//          part 2, "Enter goes into a selected slicer or timeline and the
//          arrow keys move between items"). Before this a selected timeline
//          lost every key: on a worksheet an arrow moved the cell cursor and
//          the selection change deselected the timeline; on a canvas the
//          arrows nudged it. The Slicer's twin is Slicer/lib/slicerKeys.ts.
// CONTEXT: Calcula's choices, labelled as such (Excel's timeline has no
//          documented keyboard route into its periods):
//
//            - Enter goes in only when exactly ONE object is selected and it
//              is a timeline (KD1). The focus starts on the first period of
//              the range shown, or -- unfiltered -- on the first VISIBLE
//              period (`periodIndexNear`, the drag's own clamp).
//            - Inside: Left / Right move a focus ring one period, Home / End
//              to the first / last period, PageUp / PageDown by the number of
//              whole periods the timeline shows; the periods scroll to keep
//              the ring visible. NONE wraps, and every one is consumed even at
//              the edge (the Charts CI-10 rule). Up and Down are consumed and
//              do nothing: Excel has no keyboard reference for changing the
//              level (later work).
//            - Shift with those keys grows a PREVIEW from an ANCHOR -- the
//              period the focus was on when the Shift run began -- to the
//              focus: shown, never written (timelineGestureView.ts, the
//              keyboard's own slot). A plain move ends the run and drops the
//              preview. (Excel's own Shift+arrow on cells anchors the same
//              way.)
//            - Space or Enter commits ONCE through the commit rule the range
//              drag uses (timelineCommit.ts `commitTimelineSpan`): the preview,
//              or the focused period alone. One backend command, one undo
//              step; dates that already are the range write nothing. The run
//              ends there, and its anchor is remembered for a later mouse
//              Shift+click (the drag's memory). A held key commits once.
//            - Escape drops a preview first; the next Escape leaves, and the
//              timeline stays selected. Alt+C clears the filter -- only while
//              the timeline is filtered, also without going in. Tab is NOT
//              claimed: it goes on to the next object (a canvas) or cell (a
//              worksheet), and that selection change ends the focus.
//            - The focus is VIEW state (lib/timelineKeyFocus.ts, KD2).
//            - Every focus move, every preview and every landed commit is
//              announced through the polite live region (@api/announce). DOM
//              focus never moves: the grid keeps it, and Tab order is
//              unchanged.
//
//          THE CELL BEHIND. On a WORKSHEET Core's active cell stays where it
//          was, hidden behind the timeline, and Core's own doors act on it: a
//          typed character, F2 or Backspace opened an edit there, Delete
//          cleared it (the dispatcher's Clear Contents, which runs before this
//          listener), Alt+Down opened its validation list -- all under the
//          focus ring, announced nowhere (M8 review, finding 1). So while the
//          keyboard is inside, the timeline CLAIMS the selection
//          (@api/selectionOwner, the floating grid's seam): every door that
//          writes Core's selection refuses with one sentence, and nothing of
//          the timeline takes typing. Not on a canvas: it has no cell to
//          protect. The Slicer's keyboard claims the same way.
//
//          A FOCUS THAT LOST ITS GROUND -- a level change (an undo, a script,
//          the ribbon), or a refresh that removed the focused period -- ends
//          AT ONCE, announced ("Left <name>"): the store says when what it
//          holds changed (TimelineSlicerEvents.TIMELINE_DATA_CHANGED). Ending
//          it lazily, at the next key, left ownsKey claiming the arrow
//          meanwhile: on a canvas that arrow was lost, on a worksheet it moved
//          the cell cursor, and nothing was said (M8 review, findings 4 and
//          9). A key that still finds the focus stale (a change no refresh
//          announced) ends it the same way and is CONSUMED -- it was typed for
//          the inside, never for the cell behind -- except Tab, and Enter
//          (which goes in again, at the new level) or Alt+C when they act
//          outside.
//
//          THE LISTENER. One WINDOW-CAPTURE keydown, installed for the
//          extension's life (`installTimelineKeys`, from index.ts activate).
//          It claims NOTHING until Enter has gone in -- except Alt+C on a
//          single selected, filtered timeline -- and it stands down, in this
//          order, when:
//            1. the key is claimed by a surface stacked on the grid
//               (`isKeyClaimed`, core/lib/pointerClaims.ts);
//            2. `defaultPrevented`: the keybinding dispatcher (a window-capture
//               listener installed earlier, on the same target and phase) or
//               the Slicer's keyboard already took it;
//            3. the target is an INPUT, a TEXTAREA or contentEditable;
//            4. a cell edit is live (`isCellEditInProgress`): Core's own, or
//               a floating grid's -- an EXTERNAL session, parked on another
//               sheet with the keyboard on the grid container -- whose Enter
//               commits the edit and is never the timeline's;
//            5. the grid is not focused (`isGridFocused`: a dialog, a task
//               pane, the ribbon, a menu that took focus);
//            6. a timeline content gesture is live (a held range drag owns
//               Escape: timelineRangeDrag.ts);
//            7. the timeline's right-click menu is open
//               (`isTimelineContextMenuOpen`, M8 verification C12);
//            8. an object's grip menu is open (@api/objectPosition
//               `isObjectGripMenuOpen`).
//          The same gates as the Slicer's keyboard, in the same order.
//
//          Every key it claims gets preventDefault AND stopPropagation: the
//          grid's own keyboard listens on the focus container (bubble) and
//          would otherwise move the cell cursor. stopPropagation does NOT stop
//          another listener on the same target and phase; those stand down on
//          `defaultPrevented`.
//
//          On a canvas the dispatcher's Escape and arrow-nudge bindings run
//          BEFORE this listener; they stand down because the timeline's
//          object-selection provider owns 'Escape' and 'Arrow' while the focus
//          lives (timelineObjectSelection.ts `ownsKey`).
//
//          THE FOCUS ENDS on Escape (without a preview); on any change that
//          leaves the selection other than exactly this one timeline (a
//          deselect, another object selected or added, Tab, a click on a
//          cell, the timeline deleted: every family's chokepoint notifies
//          @api/objectSelection); on the next pointer press on an object
//          (`floatingObject:selected`, `floatingObject:bodyDragStart`); on a
//          RIGHT press anywhere but this timeline (a slicer's menu opens
//          without selecting the slicer, so the timeline stayed the sole
//          selection and its inside took the menu's first Escape, and Enter
//          or Space committed a range behind the open menu; M8 review,
//          finding 7); on a sheet switch (index.ts); on deactivation; and --
//          at once, from the store's change event -- on a level change or a
//          refresh that removes the focused period (`resolveTimelineFocus`).

import { isKeyClaimed } from "@api/pointerClaims";
import { isCellEditInProgress } from "@api/editing";
import { isGridFocused } from "@api/keybindings";
import { announce } from "@api/announce";
import { requestOverlayRedraw } from "@api/gridOverlays";
import { getSelectedObjectRegions, onObjectSelectionChanged } from "@api/objectSelection";
import { isObjectGripMenuOpen } from "@api/objectPosition";
import { notifySelectionOwnershipChanged, registerSelectionOwner } from "@api/selectionOwner";
import { getGridStateSnapshot } from "@api/state";
import { getCachedTimelineData, getTimelineById, updateTimelineSelectionAsync } from "./timelineSlicerStore";
import { TimelineSlicerEvents } from "./timelineSlicerEvents";
import { clientToTimelineCanvas, timelineAtCanvasPoint } from "./timelineCanvasGeometry";
import { getScrollOffset, liveTimelineZoneInput, setScrollOffset } from "./timelineView";
import { showTimelineKeyPreview } from "./timelineGestureView";
import { commitTimelineSpan } from "./timelineCommit";
import { isTimelineContentGestureActive } from "./timelineRangeDrag";
import {
  clampScroll,
  computeTimelineLayout,
  isTimelineFiltered,
  periodIndexNear,
  type TimelineLayout,
  type TimelineSpan,
} from "./timelineZones";
import { isTimelineContextMenuOpen } from "../handlers/timelineSlicerContextMenu";
import { isTimelineSelected } from "../handlers/selectionHandler";
import { TIMELINE_REGION_TYPE, timelineIdOf } from "./timelineObjectSelection";
import {
  getTimelineKeyFocus,
  leaveTimelineKeyFocus,
  onTimelineKeyFocusChange,
  resetTimelineKeyFocus,
  resolveTimelineFocus,
  setTimelineKeyFocus,
  type TimelineKeyFocus,
} from "./timelineKeyFocus";
import type { TimelinePeriod, TimelineSlicer } from "./timelineSlicerTypes";

/** What Alt+C announces once the filter is clear. */
export const TIMELINE_FILTER_CLEARED_SENTENCE = "Filter cleared";
/** What Escape announces when it drops a preview (the focus stays). */
export const TIMELINE_PREVIEW_CANCELLED_SENTENCE = "Preview cancelled";

/** The id the keyboard's inside claims the selection under (@api/selectionOwner). */
export const TIMELINE_KEY_FOCUS_OWNER_ID = "timelineKeyFocus";

/** The ONE sentence every door refused while the keyboard is inside a timeline shows. */
export function timelineKeyFocusRefusal(action: string): string {
  return `${action} is not available while the keyboard is inside a timeline. Press Escape to leave it. Nothing was changed.`;
}

/**
 * The claim (see "THE CELL BEHIND" above): the keyboard is inside a timeline
 * on a WORKSHEET, whose active cell is hidden behind it. Asked by every door,
 * every time -- never cached.
 */
export function timelineKeyFocusOwnsSelection(): boolean {
  return getTimelineKeyFocus() !== null && getGridStateSnapshot()?.surface !== "canvas";
}

/** The keys that move the focus (with Shift: grow the preview). */
type TimelineFocusKey = "ArrowLeft" | "ArrowRight" | "Home" | "End" | "PageUp" | "PageDown";

const FOCUS_KEYS: ReadonlySet<string> = new Set<TimelineFocusKey>([
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

/** Consumed inside, and do nothing (a keyboard level change is later work). */
const INERT_KEYS: ReadonlySet<string> = new Set(["ArrowUp", "ArrowDown"]);

// ============================================================================
// Queries and words
// ============================================================================

/**
 * The id of the ONE selected object when it is a timeline (plan KD1) -- across
 * every family (a slicer selected beside it makes two) -- or null.
 */
export function soleSelectedTimelineId(): string | null {
  const selected = getSelectedObjectRegions();
  if (selected.length !== 1 || selected[0].type !== TIMELINE_REGION_TYPE) return null;
  const id = timelineIdOf(selected[0]);
  return id !== null && isTimelineSelected(id) && getTimelineById(id) !== undefined ? id : null;
}

/** A timeline as the keyboard sees it. */
interface TimelineSnapshot {
  timeline: TimelineSlicer;
  periods: readonly TimelinePeriod[];
  layout: TimelineLayout;
}

function snapshotOf(timelineId: string): TimelineSnapshot | null {
  const timeline = getTimelineById(timelineId);
  if (!timeline) return null;
  const periods = getCachedTimelineData(timelineId)?.periods ?? [];
  return { timeline, periods, layout: computeTimelineLayout(timeline, periods.length) };
}

/** A period as a screen reader says it: "Feb 2026", "Q1 2026", "2026", "5 Jan 2026". */
export function timelinePeriodName(p: Pick<TimelinePeriod, "label" | "groupLabel">): string {
  return p.groupLabel ? `${p.label} ${p.groupLabel}` : p.label;
}

/** A run of periods as a screen reader says it: "Feb 2026 to Apr 2026", or one period's name. */
export function timelineSpanName(periods: readonly TimelinePeriod[], span: TimelineSpan): string {
  const first = periods[span.first];
  const last = periods[span.last];
  if (!first || !last) return "";
  return span.first === span.last ? timelinePeriodName(first) : `${timelinePeriodName(first)} to ${timelinePeriodName(last)}`;
}

/**
 * What a screen reader hears for period `index`: "<period>, <n> of <total>",
 * then -- while the timeline filters -- ", selected" or ", not selected", and
 * ", no data" for a period the timeline paints dimmed.
 */
export function timelinePeriodSentence(
  timeline: Pick<TimelineSlicer, "selectionStart">,
  periods: readonly TimelinePeriod[],
  index: number,
): string {
  const position = `${index + 1} of ${periods.length}`;
  const p = periods[index];
  if (!p) return position;
  const state = isTimelineFiltered(timeline) ? (p.isSelected ? ", selected" : ", not selected") : "";
  const noData = p.hasData ? "" : ", no data";
  return `${timelinePeriodName(p)}, ${position}${state}${noData}`;
}

/** What a Shift+arrow preview says: "Feb 2026 to Apr 2026 previewed, 3 periods". */
function previewSentence(periods: readonly TimelinePeriod[], span: TimelineSpan): string {
  const count = span.last - span.first + 1;
  return `${timelineSpanName(periods, span)} previewed, ${count} ${count === 1 ? "period" : "periods"}`;
}

function spanBetween(a: number, b: number): TimelineSpan {
  return { first: Math.min(a, b), last: Math.max(a, b) };
}

/**
 * The scroll offset that brings period `index` fully into view with the least
 * scroll (its LEFT edge wins when a period is wider than the timeline).
 */
export function timelineScrollToShow(layout: TimelineLayout, scrollOffset: number, index: number): number {
  const current = clampScroll(layout, scrollOffset);
  const left = index * layout.periodWidth;
  const right = left + layout.periodWidth;
  if (left < current) return left;
  if (right > current + layout.viewportWidth) return Math.min(left, right - layout.viewportWidth);
  return current;
}

/** Where key `key` moves the focus from period `from` (clamped: nothing wraps). */
export function timelineFocusStep(layout: TimelineLayout, periodCount: number, from: number, key: TimelineFocusKey): number {
  const page = Math.max(1, Math.floor(layout.viewportWidth / layout.periodWidth));
  let to = from;
  switch (key) {
    case "ArrowLeft":
      to = from - 1;
      break;
    case "ArrowRight":
      to = from + 1;
      break;
    case "Home":
      to = 0;
      break;
    case "End":
      to = periodCount - 1;
      break;
    case "PageUp":
      to = from - page;
      break;
    case "PageDown":
      to = from + page;
      break;
  }
  return Math.max(0, Math.min(to, periodCount - 1));
}

// ============================================================================
// The listener
// ============================================================================

function isTextTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el !== "object") return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable === true;
}

function isAltC(e: KeyboardEvent): boolean {
  return e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.code === "KeyC" || e.key === "c" || e.key === "C");
}

function isApplyKey(e: KeyboardEvent): boolean {
  return !e.altKey && (e.key === " " || e.key === "Spacebar" || e.key === "Enter");
}

/** The key is the timeline's: nothing else -- the grid's keyboard, the dispatcher's later passes -- acts on it. */
function consume(e: KeyboardEvent): void {
  e.preventDefault();
  e.stopPropagation();
}

/**
 * The window-capture keydown (see the header for the gates and the keys).
 * Exported for the unit tier; `installTimelineKeys` binds it.
 */
export function handleTimelineKeyDown(e: KeyboardEvent): void {
  if (isKeyClaimed(e)) return;
  if (e.defaultPrevented) return;
  if (isTextTarget(e.target)) return;
  if (isCellEditInProgress()) return;
  if (!isGridFocused()) return;
  if (isTimelineContentGestureActive()) return;
  if (isTimelineContextMenuOpen()) return;
  if (isObjectGripMenuOpen()) return;

  const focus = getTimelineKeyFocus();
  if (focus !== null) {
    if (soleSelectedTimelineId() === focus.timelineId) {
      keyInside(e, focus);
      return;
    }
    // The selection moved on without a notification reaching us: the focus
    // is stale, and the key is judged as if the keyboard were outside.
    leaveTimelineKeyFocus();
  }
  keyOutside(e);
}

/** Outside a timeline: only Enter (go in) and Alt+C (clear), on ONE selected timeline. */
function keyOutside(e: KeyboardEvent): void {
  if (isAltC(e)) {
    const id = soleSelectedTimelineId();
    if (id === null) return;
    const tl = getTimelineById(id);
    if (!tl || !isTimelineFiltered(tl)) return;
    consume(e);
    clearFromKeyboard(id);
    return;
  }
  if (e.key !== "Enter" || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
  const id = soleSelectedTimelineId();
  if (id === null) return;
  if (!enterTimeline(id)) return;
  consume(e);
}

/** A modifier pressed on its own (the start of a combination): never the timeline's key. */
function isBareModifier(e: KeyboardEvent): boolean {
  return e.key === "Shift" || e.key === "Control" || e.key === "Alt" || e.key === "Meta" || e.key === "AltGraph";
}

/**
 * The focus lost its ground and nothing ended it yet (a change no refresh
 * announced): end it, say so, and -- because this key was typed for the inside
 * -- let it reach nothing behind: Enter and Alt+C may still act outside (go in
 * again at the new level, clear); Tab moves on as always; every other key is
 * consumed.
 */
function keyOnStaleFocus(e: KeyboardEvent, name: string | null): void {
  leaveTimelineKeyFocus();
  announce(`Left ${name ?? "the timeline"}`);
  if (e.key === "Tab") return;
  keyOutside(e);
  if (!e.defaultPrevented) consume(e);
}

/** Inside a timeline: move, preview, commit, clear, leave. Every other key (Tab first) is not the timeline's. */
function keyInside(e: KeyboardEvent, focus: TimelineKeyFocus): void {
  if (isBareModifier(e)) return;
  const s = snapshotOf(focus.timelineId);
  const at = s ? resolveTimelineFocus(focus, s.timeline.level, s.periods.map((p) => p.startDate)) : null;
  if (s === null || at === null) {
    // The level changed, or a refresh removed the focused period (no nearest
    // period across levels), or the timeline is gone.
    keyOnStaleFocus(e, s?.timeline.name ?? null);
    return;
  }
  // A preview whose anchor period is gone (a refresh) is dropped.
  let current = focus;
  if (focus.anchorStart !== null && at.anchorIndex === null) {
    current = { ...focus, anchorStart: null };
    setTimelineKeyFocus(current);
  }

  if (e.key === "Escape") {
    consume(e);
    if (current.anchorStart !== null) {
      // The preview goes first; the focus stays where it is.
      setTimelineKeyFocus({ ...current, anchorStart: null });
      announce(TIMELINE_PREVIEW_CANCELLED_SENTENCE);
      return;
    }
    leaveTimelineKeyFocus();
    announce(`Left ${s.timeline.name}`);
    return;
  }
  if (FOCUS_KEYS.has(e.key)) {
    // Consumed EVEN at the edge: the grid behind must never see the key.
    consume(e);
    moveFocus(s, current, at.index, at.anchorIndex, e.key as TimelineFocusKey, e.shiftKey);
    return;
  }
  if (INERT_KEYS.has(e.key)) {
    consume(e);
    return;
  }
  if (isApplyKey(e)) {
    consume(e);
    // A held key repeats: one press commits once.
    if (e.repeat) return;
    commitFocused(s, current, at.index, current.anchorStart !== null ? at.anchorIndex : null);
    return;
  }
  if (isAltC(e) && isTimelineFiltered(s.timeline)) {
    consume(e);
    if (current.anchorStart !== null) setTimelineKeyFocus({ ...current, anchorStart: null });
    clearFromKeyboard(focus.timelineId);
  }
}

// ============================================================================
// What the keys do
// ============================================================================

/** Go into timeline `timelineId`: the first period of the range shown, else the first visible one. */
function enterTimeline(timelineId: string): boolean {
  const s = snapshotOf(timelineId);
  const input = liveTimelineZoneInput(timelineId);
  if (s === null || input === null || s.periods.length === 0) return false;
  const index = input.selected?.first ?? periodIndexNear(input, 0);
  if (index === null || index < 0 || index >= s.periods.length) return false;
  setTimelineKeyFocus({
    timelineId,
    level: s.timeline.level,
    periodStart: s.periods[index].startDate,
    anchorStart: null,
  });
  showPeriod(s, index);
  announce(`${s.timeline.name}: ${timelinePeriodSentence(s.timeline, s.periods, index)}`);
  return true;
}

/**
 * Move the focus. With Shift the move grows the preview from its anchor (the
 * focus BEFORE the first Shift move of the run); without, it ends the run.
 */
function moveFocus(
  s: TimelineSnapshot,
  focus: TimelineKeyFocus,
  from: number,
  anchorIndex: number | null,
  key: TimelineFocusKey,
  shift: boolean,
): void {
  const to = timelineFocusStep(s.layout, s.periods.length, from, key);
  if (to === from) return;
  const periodStart = s.periods[to].startDate;
  if (shift) {
    const anchor = focus.anchorStart !== null && anchorIndex !== null ? anchorIndex : from;
    setTimelineKeyFocus({ ...focus, periodStart, anchorStart: s.periods[anchor].startDate });
    showPeriod(s, to);
    announce(previewSentence(s.periods, spanBetween(anchor, to)));
    return;
  }
  setTimelineKeyFocus({ ...focus, periodStart, anchorStart: null });
  showPeriod(s, to);
  announce(timelinePeriodSentence(s.timeline, s.periods, to));
}

/** Scroll the periods so period `index` shows, and repaint the ring. */
function showPeriod(s: TimelineSnapshot, index: number): void {
  const id = s.timeline.id;
  setScrollOffset(id, timelineScrollToShow(s.layout, getScrollOffset(id), index));
  requestOverlayRedraw();
}

/**
 * Space / Enter: commit the preview (anchor..focus) or the focused period
 * alone, ONCE, through the drag's commit rule -- and, once it has LANDED as
 * those dates, say so.
 */
function commitFocused(s: TimelineSnapshot, focus: TimelineKeyFocus, index: number, anchorIndex: number | null): void {
  const timelineId = s.timeline.id;
  const span = anchorIndex !== null ? spanBetween(anchorIndex, index) : { first: index, last: index };
  const start = s.periods[span.first].startDate;
  const end = s.periods[span.last].endDate;
  const name = timelineSpanName(s.periods, span);
  // The run ends here: the preview goes, and the commit's own landing range
  // (timelineGestureView.ts) shows the span until it lands.
  if (focus.anchorStart !== null) setTimelineKeyFocus({ ...focus, anchorStart: null });
  void commitTimelineSpan(timelineId, span, anchorIndex ?? index).then(() => {
    const tl = getTimelineById(timelineId);
    if (tl && tl.selectionStart === start && tl.selectionEnd === end) announce(`${name} selected`);
  });
  requestOverlayRedraw();
}

/**
 * Alt+C: clear the filter -- the clear button's own door (asking before an
 * overwrite, one undo step) -- and say so once it is clear.
 */
function clearFromKeyboard(timelineId: string): void {
  void updateTimelineSelectionAsync(timelineId, null, null, { askBeforeOverwrite: true }).then(() => {
    const tl = getTimelineById(timelineId);
    if (tl && !isTimelineFiltered(tl)) announce(TIMELINE_FILTER_CLEARED_SENTENCE);
  });
}

// ============================================================================
// The preview follows the focus
// ============================================================================

/**
 * Show the preview the focus holds -- anchor..focus while a Shift run is live
 * -- or none. Called on every change of the focus, so whatever ends the focus
 * or the run (a key, a selection change, a sheet switch) drops the preview
 * with it. Only the keyboard's own slot is touched: a drag's range is never.
 */
function syncKeyPreview(): void {
  const f = getTimelineKeyFocus();
  if (f === null || f.anchorStart === null) {
    showTimelineKeyPreview(null);
    return;
  }
  const s = snapshotOf(f.timelineId);
  const at = s ? resolveTimelineFocus(f, s.timeline.level, s.periods.map((p) => p.startDate)) : null;
  if (at === null || at.anchorIndex === null) {
    showTimelineKeyPreview(null);
    return;
  }
  showTimelineKeyPreview({ timelineId: f.timelineId, span: spanBetween(at.anchorIndex, at.index) });
}

// ============================================================================
// Installation
// ============================================================================

/**
 * The store re-read (TimelineSlicerEvents.TIMELINE_DATA_CHANGED): a focus
 * that no longer resolves -- another level, its period gone, the timeline
 * gone -- ends NOW, announced, so ownsKey stops claiming the arrows at the
 * moment the ring disappears and the next arrow is the surface's again (a
 * canvas nudges; a worksheet moves the cell cursor).
 */
function endIfStale(): void {
  const focus = getTimelineKeyFocus();
  if (focus === null) return;
  const s = snapshotOf(focus.timelineId);
  if (s !== null && resolveTimelineFocus(focus, s.timeline.level, s.periods.map((p) => p.startDate)) !== null) return;
  leaveTimelineKeyFocus();
  // A timeline that is gone was deleted: its own route ended the focus first,
  // and there is no name to say.
  if (s !== null) announce(`Left ${s.timeline.name}`);
}

/**
 * A RIGHT press anywhere but the focused timeline ends the focus (M8 review,
 * finding 7): another object's menu (a slicer's selects nothing) or the
 * grid's opens with the timeline still the sole selection, and its keys are
 * then the menu's. A right press ON the timeline keeps the keyboard inside:
 * its own menu takes the keys while it is open (gate 7). Window capture, so
 * no object's handler can stop it first (the Slicer's contextmenu handler
 * stops a right-click on a slicer before a timeline listener on the same
 * event would hear it); it reads the press and prevents nothing. Bound only
 * while the keyboard is inside a timeline (`installTimelineKeys`): a press's
 * modifiers are never read here (timelinePressWiring.test.ts).
 */
function endOnForeignRightPress(e: MouseEvent): void {
  if (e.button !== 2) return;
  const focus = getTimelineKeyFocus();
  if (focus === null) return;
  const point = clientToTimelineCanvas(e.clientX, e.clientY);
  const under = point ? timelineAtCanvasPoint(point.x, point.y) : null;
  if (under?.id === focus.timelineId) return;
  leaveTimelineKeyFocus();
}

/**
 * Bind the keyboard for the extension's life: the window-capture keydown, the
 * claim on the selection while inside (a worksheet), the ends of the focus (a
 * pointer press on an object; a right press anywhere else; any selection
 * change that leaves something other than exactly the focused timeline
 * selected; a refresh or level change it no longer resolves against), and the
 * preview and the ring following every change of the focus. Returns the
 * cleanup, which also drops the focus, its preview and the claim.
 */
export function installTimelineKeys(): () => void {
  const endOnPress = (): void => {
    leaveTimelineKeyFocus();
  };
  // The right-press end lives exactly as long as the inner focus does.
  let rightPressBound = false;
  const bindRightPress = (inside: boolean): void => {
    if (inside === rightPressBound) return;
    rightPressBound = inside;
    if (inside) window.addEventListener("mousedown", endOnForeignRightPress, true);
    else window.removeEventListener("mousedown", endOnForeignRightPress, true);
  };
  window.addEventListener("keydown", handleTimelineKeyDown, true);
  window.addEventListener("floatingObject:selected", endOnPress);
  window.addEventListener("floatingObject:bodyDragStart", endOnPress);
  window.addEventListener(TimelineSlicerEvents.TIMELINE_DATA_CHANGED, endIfStale);
  const releaseClaim = registerSelectionOwner({
    id: TIMELINE_KEY_FOCUS_OWNER_ID,
    label: "a timeline's periods",
    ownsSelection: timelineKeyFocusOwnsSelection,
    refusal: timelineKeyFocusRefusal,
    // Nothing of the timeline takes typing: a Ctrl+Alt character is read as
    // the shortcut it collides with, never typed into the hidden cell (W17).
    receivesTyping: () => false,
  });
  const offSelection = onObjectSelectionChanged(() => {
    const focus = getTimelineKeyFocus();
    if (focus !== null && soleSelectedTimelineId() !== focus.timelineId) leaveTimelineKeyFocus();
  });
  const offChange = onTimelineKeyFocusChange(() => {
    bindRightPress(getTimelineKeyFocus() !== null);
    syncKeyPreview();
    requestOverlayRedraw();
    // Going in or leaving starts or ends the claim with no selection change:
    // a surface that follows the claim (a contextual tab) re-asks.
    notifySelectionOwnershipChanged();
  });
  return () => {
    window.removeEventListener("keydown", handleTimelineKeyDown, true);
    bindRightPress(false);
    window.removeEventListener("floatingObject:selected", endOnPress);
    window.removeEventListener("floatingObject:bodyDragStart", endOnPress);
    window.removeEventListener(TimelineSlicerEvents.TIMELINE_DATA_CHANGED, endIfStale);
    offSelection();
    offChange();
    resetTimelineKeyFocus();
    showTimelineKeyPreview(null);
    releaseClaim();
  };
}
