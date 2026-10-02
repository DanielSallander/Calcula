//! FILENAME: app/extensions/Slicer/lib/slicerItemDrag.ts
// PURPOSE: The slicer's CONTENT gesture (BUG-0258 design phase 4): a press on
//          an item filters -- a click selects it (Ctrl+click toggles it), a
//          drag across items selects the RUN -- a press on "Select all" or on
//          the lit clear button acts when it is RELEASED over the same button,
//          and a press on the scrollbar drags the items. Nothing here moves
//          the slicer: its frame does that (the header, the gaps, a header-less
//          slicer's 4px band), through Core.
// CONTEXT: Core asks the registration's `zoneAt` ONCE per press
//          (rendering/slicerRenderer.ts `slicerZoneAt`), BEFORE the press
//          selects anything, and for a content zone it selects the slicer as a
//          PLAIN press -- Ctrl and Shift are the content's, so a Ctrl+click on
//          an item toggles the item and never toggles the slicer out of its
//          selection (the defect the Slicer's own capture mousedown caused) --
//          and dispatches `floatingObject:bodyDragStart` with the RAW
//          modifiers, never a move, whatever the lock or the subscription:
//          filtering is reading the report, not editing it (owner decision
//          2026-09-29). index.ts hands that press here; this is the timeline's
//          range drag again (TimelineSlicer/lib/timelineRangeDrag.ts).
//
//          THE RULES THIS FILE KEEPS:
//            - ONE commit, at release, QUEUED through the store
//              (`clickSlicerItem` for a click, `clickSlicerItemRun` for a
//              run, `clickSlicerClearFilter` for a button): one backend
//              command, one undo step for the slicer and every pivot it
//              filters, one overwrite question. While the pointer moves only
//              a TRANSIENT preview changes (slicerGestureView.ts), which only
//              the renderer reads -- no backend write, no dirty flag.
//            - A release with no movement (Core's 3px threshold, and still on
//              the pressed item) is a CLICK: the item's own rule (exclusive,
//              Ctrl toggles, 'multi' toggles). Past 3px, or on another item,
//              it is a RUN from the pressed item to the one under the pointer
//              (design D4: a plain drag selects exactly the run, Ctrl+drag adds
//              it, 'single' takes the item released on, 'multi' adds it).
//              Beyond the item area the run clamps to the visible edge item and
//              the items AUTO-SCROLL.
//            - "Select all" and the clear button act only when released over
//              the same button -- and where no other object covers it there
//              (@api/gridOverlays `isFloatingRegionCoveredAtClient`, the rule
//              every content press keeps); sliding off cancels. The scrollbar
//              moves the items (a thumb grab, or a jump on the track) and
//              writes nothing.
//            - The pointer the gesture owns while the button is held is held
//              through Core's seam (`holdContentGestureCursor` under the
//              region Core pressed) and released on EVERY end path: release,
//              Escape, blur, a lost release, the next press, deactivation.
//            - The window listeners live only as long as the gesture: bound at
//              the press, removed at release, Escape, window blur, a move with
//              the primary button UP (a release this page never heard -- the
//              timeline's phantom drag, found live 2026-09-29), or a release of
//              another button with the primary one up (a MIDDLE press starts a
//              gesture too: Core hands every non-secondary press over).
//              slicerNoPhantomDrag.test.ts scans this file for that shape.
//            - Escape belongs to the gesture: it cancels with no commit, and
//              the slicer's object-selection provider owns Escape meanwhile
//              (`isSlicerContentGestureActive`), so a canvas does not also
//              deselect the slicer under the drag.

import { holdContentGestureCursor, isFloatingRegionCoveredAtClient, requestOverlayRedraw } from "@api/gridOverlays";
import {
  clickSlicerClearFilter,
  clickSlicerItem,
  clickSlicerItemRun,
  getCachedItems,
  getSlicerById,
} from "./slicerStore";
import {
  getMaxScrollOffset,
  getScrollOffset,
  getSlicerHitDetail,
  setScrollOffset,
  slicerAutoScrollStep,
  slicerItemIndexNear,
  slicerScrollOffsetForThumb,
  slicerScrollThumb,
  slicerScrollTrack,
  slicerZoneOfHit,
} from "../rendering/slicerRenderer";
import {
  holdLandingRun,
  releaseLandingRun,
  resetSlicerGestureView,
  showSlicerGesture,
  type SlicerGestureView,
} from "./slicerGestureView";

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
export interface SlicerContentPress {
  slicerId: string;
  /** The grid region Core pressed: the gesture holds Core's pointer over it. */
  regionId: string;
  /** Where the press landed, in logical canvas px (Core's own basis). */
  canvasX: number;
  canvasY: number;
  /**
   * The part Core's zone answer named ('item', 'selectAll', 'clearButton',
   * 'scrollbar'). The gesture starts only when the part under the press is
   * that part -- a press Core resolved to anything else is not this one's.
   */
  part?: string;
  /** Ctrl was held: a click toggles the item, a drag ADDS the run. The raw modifier. */
  additive?: boolean;
  /** The slicer's canvas rectangle NOW (the grid may scroll mid-gesture). */
  boundsOf: () => CanvasRect | null;
  /** A window mouse event's point in logical canvas px; null before mount. */
  clientToCanvas: (clientX: number, clientY: number) => CanvasPoint | null;
  /** Runs once when the gesture is RELEASED (never on a cancel), before it acts. */
  onRelease?: () => void;
}

/** Core's click-vs-drag threshold (logical px, either axis). */
export const SLICER_DRAG_THRESHOLD_PX = 3;
/** How often an edge auto-scroll steps while the pointer stays out there. */
export const SLICER_AUTOSCROLL_INTERVAL_MS = 30;

interface SessionBase {
  slicerId: string;
  press: SlicerContentPress;
  /** The press point, from the slicer's top-left (stable if the grid scrolls). */
  pressRelX: number;
  pressRelY: number;
  detach: () => void;
  /** Lets go of Core's pointer this gesture holds (every end path runs it). */
  releaseCursor: () => void;
}

interface ItemsSession extends SessionBase {
  mode: "items";
  /** The pressed item, by VALUE (an index means another item after a refresh). */
  anchorValue: string;
  /** The item index under the pointer (the run's moving end). */
  current: number;
  /** The pointer has left the click dead zone, or reached another item. */
  moved: boolean;
  additive: boolean;
  lastRelX: number;
  lastRelY: number;
  autoScroll: ReturnType<typeof setInterval> | null;
}

interface ButtonSession extends SessionBase {
  mode: "button";
  part: "selectAll" | "clearButton";
}

interface ScrollSession extends SessionBase {
  mode: "scroll";
  /** Where on the thumb it was grabbed (px from the thumb's start). */
  grab: number;
}

type Session = ItemsSession | ButtonSession | ScrollSession;

let session: Session | null = null;

// ============================================================================
// Queries
// ============================================================================

/** Whether a content gesture on some slicer is live (it owns Escape). */
export function isSlicerContentGestureActive(): boolean {
  return session !== null;
}

// ============================================================================
// The gesture
// ============================================================================

/**
 * Start the content gesture for a press Core handed over. Returns false (and
 * binds nothing) when the press is not on the slicer's content after all --
 * the slicer vanished, its items changed under the pointer, or the part there
 * is not the one Core named.
 */
export function beginSlicerContentPress(press: SlicerContentPress): boolean {
  // A gesture whose release was never heard ends here, with no commit.
  cancelSlicerContentPress();

  const slicer = getSlicerById(press.slicerId);
  const bounds = press.boundsOf();
  if (!slicer || !bounds) return false;
  const items = getCachedItems(press.slicerId) ?? [];
  const hit = getSlicerHitDetail(press.canvasX, press.canvasY, bounds, press.slicerId);
  const zone = hit ? slicerZoneOfHit(slicer, hit) : null;
  if (!hit || zone?.kind !== "content") return false;
  if (press.part !== undefined && press.part !== zone.part) return false;

  const relX = press.canvasX - bounds.x;
  const relY = press.canvasY - bounds.y;
  const base: SessionBase = {
    slicerId: press.slicerId,
    press,
    pressRelX: relX,
    pressRelY: relY,
    detach: () => {},
    releaseCursor: () => {},
  };
  let started: Session;
  switch (hit.type) {
    case "item": {
      if (hit.itemIndex == null || hit.itemValue == null) return false;
      started = {
        ...base,
        mode: "items",
        anchorValue: hit.itemValue,
        current: hit.itemIndex,
        moved: false,
        additive: press.additive === true,
        lastRelX: relX,
        lastRelY: relY,
        autoScroll: null,
      };
      break;
    }
    case "selectAll":
    case "clearButton":
      started = { ...base, mode: "button", part: hit.type };
      break;
    case "scrollbar": {
      const track = slicerScrollTrack(slicer, items, bounds);
      if (!track) return false;
      const pos = track.axis === "y" ? relY : relX;
      const scroll = Math.min(getScrollOffset(press.slicerId), getMaxScrollOffset(press.slicerId));
      const thumb = slicerScrollThumb(track.start, track.length, track.contentExtent, scroll);
      const onThumb = pos >= thumb.start && pos <= thumb.start + thumb.length;
      started = { ...base, mode: "scroll", grab: onThumb ? pos - thumb.start : thumb.length / 2 };
      if (!onThumb) {
        // A press on the track brings the thumb under the pointer.
        setScrollOffset(press.slicerId, slicerScrollOffsetForThumb(track.start, track.length, track.contentExtent, pos - started.grab));
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
  started.releaseCursor = holdContentGestureCursor(press.regionId, zone.cursor);
  session = started;
  requestOverlayRedraw();
  return true;
}

/** End the live gesture WITHOUT acting (Escape, blur, a lost release, deactivation). */
export function cancelSlicerContentPress(): void {
  endSession(null);
}

/** Drop every trace, for deactivation and tests. */
export function resetSlicerContentPress(): void {
  cancelSlicerContentPress();
  resetSlicerGestureView();
}

// ============================================================================
// Window listeners (bound only while a gesture lives)
// ============================================================================

const onSessionMove = (e: MouseEvent): void => {
  const s = session;
  if (!s) return;
  // The gesture exists only while the primary button is HELD: a move with it
  // up means the release was never heard, and following the bare pointer is
  // exactly the phantom drag this file must never be. Nothing commits.
  if ((e.buttons & 1) === 0) {
    endSession(null);
    return;
  }
  const at = pointerAt(s, e);
  if (!at) return;
  if (s.mode === "items") {
    trackItems(s, at);
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
  if (s.mode === "items" && at) trackItems(s, at);
  endSession(
    at ?? {
      relX: Number.NaN,
      relY: Number.NaN,
      canvasX: Number.NaN,
      canvasY: Number.NaN,
      clientX: e.clientX,
      clientY: e.clientY,
      bounds: null,
    },
  );
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

interface PointerAt {
  /** From the slicer's top-left. */
  relX: number;
  relY: number;
  /** Logical canvas px. */
  canvasX: number;
  canvasY: number;
  /** The mouse event's own point (Core's occlusion question takes it). */
  clientX: number;
  clientY: number;
  bounds: CanvasRect | null;
}

function pointerAt(s: Session, e: MouseEvent): PointerAt | null {
  const p = s.press.clientToCanvas(e.clientX, e.clientY);
  const bounds = s.press.boundsOf();
  if (!p || !bounds) return null;
  return { relX: p.x - bounds.x, relY: p.y - bounds.y, canvasX: p.x, canvasY: p.y, clientX: e.clientX, clientY: e.clientY, bounds };
}

// ============================================================================
// Items: a click, or a run
// ============================================================================

/** The run from the pressed item to the one under the pointer, in sweep order; null when the pressed item is gone. */
function runOf(s: ItemsSession): string[] | null {
  const items = getCachedItems(s.slicerId) ?? [];
  const anchor = items.findIndex((i) => i.value === s.anchorValue);
  if (anchor < 0 || s.current < 0 || s.current >= items.length) return null;
  const run = items.slice(Math.min(anchor, s.current), Math.max(anchor, s.current) + 1).map((i) => i.value);
  return s.current < anchor ? run.reverse() : run;
}

/** Publish the run the drag shows (nothing until it has moved). */
function showRun(s: ItemsSession): void {
  const values = s.moved ? runOf(s) : null;
  showSlicerGesture(values ? { slicerId: s.slicerId, values, additive: s.additive } : null);
}

/** The item index nearest a point of the slicer (clamped to the visible items), or null. */
function itemNear(s: Session, relX: number, relY: number): number | null {
  const slicer = getSlicerById(s.slicerId);
  const items = getCachedItems(s.slicerId);
  const bounds = s.press.boundsOf();
  if (!slicer || !items || !bounds) return null;
  return slicerItemIndexNear(slicer, items, bounds, relX, relY);
}

/**
 * The item whose PAINTED button is under the pointer, or null (a gap, the
 * padding, outside). Inside the click dead zone only this ends the click: a
 * gap is not another item, though the clamped `itemNear` files it under one.
 */
function paintedItemUnder(s: Session, at: PointerAt): number | null {
  if (!at.bounds) return null;
  const hit = getSlicerHitDetail(at.canvasX, at.canvasY, at.bounds, s.slicerId);
  return hit?.type === "item" && hit.itemIndex != null ? hit.itemIndex : null;
}

function trackItems(s: ItemsSession, at: PointerAt): void {
  s.lastRelX = at.relX;
  s.lastRelY = at.relY;
  if (!s.moved) {
    const dx = Math.abs(at.relX - s.pressRelX);
    const dy = Math.abs(at.relY - s.pressRelY);
    const under = paintedItemUnder(s, at);
    if (dx <= SLICER_DRAG_THRESHOLD_PX && dy <= SLICER_DRAG_THRESHOLD_PX && (under === null || under === s.current)) {
      return;
    }
    s.moved = true;
    showRun(s);
    requestOverlayRedraw();
  }
  followPointer(s);
  syncAutoScroll(s);
}

/** Put the run's moving end under the pointer; repaint when it changed. */
function followPointer(s: ItemsSession): void {
  const index = itemNear(s, s.lastRelX, s.lastRelY);
  if (index === null || index === s.current) return;
  s.current = index;
  showRun(s);
  requestOverlayRedraw();
}

function syncAutoScroll(s: ItemsSession): void {
  if (autoScrollStep(s) === 0) {
    stopAutoScroll(s);
    return;
  }
  if (s.autoScroll !== null) return;
  s.autoScroll = setInterval(() => {
    const step = session === s ? autoScrollStep(s) : 0;
    if (step === 0) {
      stopAutoScroll(s);
      return;
    }
    const before = getScrollOffset(s.slicerId);
    setScrollOffset(s.slicerId, before + step);
    if (getScrollOffset(s.slicerId) !== before) requestOverlayRedraw();
    followPointer(s);
  }, SLICER_AUTOSCROLL_INTERVAL_MS);
}

function autoScrollStep(s: ItemsSession): number {
  const slicer = getSlicerById(s.slicerId);
  const items = getCachedItems(s.slicerId);
  const bounds = s.press.boundsOf();
  if (!slicer || !items || !bounds) return 0;
  return slicerAutoScrollStep(slicer, items, bounds, s.lastRelX, s.lastRelY);
}

function stopAutoScroll(s: Session): void {
  if (s.mode !== "items" || s.autoScroll === null) return;
  clearInterval(s.autoScroll);
  s.autoScroll = null;
}

/** The ONE commit of a released press on the items: a click, or a run. */
function commitItems(s: ItemsSession): void {
  const items = getCachedItems(s.slicerId) ?? [];
  if (!s.moved) {
    if (!items.some((i) => i.value === s.anchorValue)) return;
    void clickSlicerItem(s.slicerId, s.anchorValue, s.additive);
    return;
  }
  const values = runOf(s);
  if (!values) return;
  // The run stays on screen until its commit has landed (the item flags are
  // refreshed at the end of it), so the old selection never flashes back.
  const view: SlicerGestureView = { slicerId: s.slicerId, values, additive: s.additive };
  holdLandingRun(view);
  void clickSlicerItemRun(s.slicerId, values, s.additive).finally(() => {
    releaseLandingRun(view);
    requestOverlayRedraw();
  });
}

// ============================================================================
// Scrollbar
// ============================================================================

function trackScroll(s: ScrollSession, at: PointerAt): void {
  const slicer = getSlicerById(s.slicerId);
  const items = getCachedItems(s.slicerId) ?? [];
  if (!slicer || !at.bounds) return;
  const track = slicerScrollTrack(slicer, items, at.bounds);
  if (!track) return;
  const pos = track.axis === "y" ? at.relY : at.relX;
  const before = getScrollOffset(s.slicerId);
  setScrollOffset(s.slicerId, slicerScrollOffsetForThumb(track.start, track.length, track.contentExtent, pos - s.grab));
  if (getScrollOffset(s.slicerId) !== before) requestOverlayRedraw();
}

// ============================================================================
// Buttons
// ============================================================================

/**
 * "Select all" and the clear button act only when released over THEMSELVES:
 * the same part under the release, and no other object covering it there.
 */
function releaseButton(s: ButtonSession, at: PointerAt): void {
  const slicer = getSlicerById(s.slicerId);
  const b = at.bounds;
  if (!slicer || !b || !Number.isFinite(at.relX) || !Number.isFinite(at.relY)) return;
  if (at.relX < 0 || at.relY < 0 || at.relX > b.width || at.relY > b.height) return;
  const hit = getSlicerHitDetail(at.canvasX, at.canvasY, b, s.slicerId);
  const zone = hit ? slicerZoneOfHit(slicer, hit) : null;
  if (zone?.kind !== "content" || zone.part !== s.part) return;
  // A part of the button another object covers is not the button's to
  // release on: Core's press there would have gone to the cover.
  if (isFloatingRegionCoveredAtClient(s.press.regionId, at.clientX, at.clientY)) return;
  // Both clear the filter; a slicer that filters nothing is left alone
  // (the store's `selectionAfterClear`).
  void clickSlicerClearFilter(s.slicerId);
}

// ============================================================================
// End
// ============================================================================

/**
 * End the live gesture. `release` is where the pointer was released (the
 * gesture ACTS), or null for a cancel (nothing is committed).
 */
function endSession(release: PointerAt | null): void {
  const s = session;
  if (!s) return;
  session = null;
  showSlicerGesture(null);
  s.releaseCursor();
  s.detach();
  stopAutoScroll(s);
  if (release) {
    s.press.onRelease?.();
    if (s.mode === "items") commitItems(s);
    else if (s.mode === "button") releaseButton(s, release);
  }
  requestOverlayRedraw();
}
