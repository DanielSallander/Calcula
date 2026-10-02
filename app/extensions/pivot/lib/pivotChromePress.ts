//! FILENAME: app/extensions/Pivot/lib/pivotChromePress.ts
// PURPOSE: A press on a canvas pivot box's CHROME -- a +/-, a report-filter
//          combo, a Row/Column Labels filter button, the loading indicator's
//          Cancel -- ACTS WHEN IT IS RELEASED over the same piece of chrome
//          (BUG-0258 design phase 4, decision D5). Sliding off before the
//          release cancels it, as a Windows button does; so do Escape, a
//          window blur and a release this page never heard.
// CONTEXT: The chrome is CONTENT in the box's one zone answer
//          (pivotVisualOverlay.ts `pivotVisualZoneAt`), so Core hands the press
//          to `floatingObject:bodyDragStart` and never moves the box from it --
//          on a locked box and a subscribed page too (reading the report is not
//          editing it). That press used to ACT at once (`handlePivotVisualPress`
//          on the press), so a drag that happened to start on a +/- collapsed
//          the group, and a press the user meant to take back could not be.
//
//          THE RULES THIS FILE KEEPS:
//            - The chrome under the PRESS is recorded as its key
//              (`pressKey`: the same pivot, the same kind, the same icon /
//              field / header button). At the release the chrome under the
//              RELEASE point is hit-tested against the box as it is painted
//              then, and only when its key is the press's key -- and no other
//              object covers the box there (@api/gridOverlays
//              `isFloatingRegionCoveredAtClient`, the rule every content press
//              keeps) -- does `handlePivotVisualPress` run, once, at the
//              release point.
//            - The double-click guard is asked in `handlePivotVisualPress`
//              (pivotChromeRepeat.ts, REPEAT_PRESS_MS = 450 -- the one guard a
//              worksheet pivot's chrome asks too), at RELEASE time: the two
//              releases of a double-click on a +/- toggle it once, not twice
//              (back to where it was).
//            - The window listeners live only as long as the press: bound at
//              the press, removed at its release, Escape, window blur, a move
//              with the primary button UP (a release this page never heard), a
//              release of another button with the primary one up (a MIDDLE
//              press starts a press too), the next press, or the box's
//              teardown (`installPivotVisual`).
//            - While it is held the press holds Core's pointer over the box
//              (`holdContentGestureCursor`, the slicer and timeline gestures'
//              seam), released on EVERY end path: no grip shows and no resize
//              handle answers under a held press (BUG-0258 M7 review).
//            - Escape belongs to the press while it lives: it is stopped here
//              (capture phase), and the box's object-selection provider owns
//              it meanwhile (pivotVisualSelection.ts `ownsKey`), so a canvas
//              does not also deselect the box under the pointer.
//          Nothing here writes: the action is the chrome's own
//          (pivotChromeActions.ts), reached through `handlePivotVisualPress`.

import { holdContentGestureCursor, isFloatingRegionCoveredAtClient, requestOverlayRedraw } from "@api/gridOverlays";
import { getPivotVisualRecord, hitPivotVisualChrome } from "./pivotVisualHits";
import { handlePivotVisualPress, pressKey } from "./pivotVisualOverlay";
import { isPivotChromePressLive, setPivotChromePressLive } from "./pivotVisualMenuState";

/** A chrome press, as the box's bodyDragStart listener hands it over. */
export interface PivotChromePress {
  pivotId: string;
  /**
   * The grid region Core pressed (the box's): the press holds Core's pointer
   * over it, and a release where another object covers it acts on nothing.
   * Absent: neither (a caller with no region to name).
   */
  regionId?: string;
  /** Where the press landed, in logical canvas px (Core's own basis). */
  canvasX: number;
  canvasY: number;
  /** A window mouse event's point in logical canvas px; null before the grid mounts. */
  clientToCanvas: (clientX: number, clientY: number) => { x: number; y: number } | null;
}

interface Session {
  pivotId: string;
  regionId: string | null;
  /** The chrome under the press (`pressKey`). */
  key: string;
  clientToCanvas: PivotChromePress["clientToCanvas"];
  /** Lets go of Core's pointer this press holds (every end path runs it). */
  releaseCursor: () => void;
}

let session: Session | null = null;

/** Whether a chrome press is live (it owns Escape). */
export function isPivotChromePressActive(): boolean {
  return isPivotChromePressLive();
}

/**
 * Start a chrome press. Returns false (and binds nothing) when no chrome is
 * under the press after all -- the box repainted under the pointer, or the
 * pivot has no painted record. It never acts: the release does.
 */
export function beginPivotChromePress(press: PivotChromePress): boolean {
  // A press whose release was never heard ends here, with no action.
  cancelPivotChromePress();

  const record = getPivotVisualRecord(press.pivotId);
  const hit = record ? hitPivotVisualChrome(record, press.canvasX, press.canvasY) : null;
  if (!hit) return false;

  const regionId = press.regionId ?? null;
  session = {
    pivotId: press.pivotId,
    regionId,
    key: pressKey(press.pivotId, hit),
    clientToCanvas: press.clientToCanvas,
    releaseCursor: regionId !== null ? holdContentGestureCursor(regionId, "pointer") : () => {},
  };
  setPivotChromePressLive(true);
  window.addEventListener("mousemove", onPressMove);
  window.addEventListener("mouseup", onPressUp);
  window.addEventListener("keydown", onPressKey, true);
  window.addEventListener("blur", onPressBlur);
  // A canvas-selected box's grip hides while the press holds the pointer.
  requestOverlayRedraw();
  return true;
}

/** End a live press WITHOUT acting (Escape, blur, a lost release, teardown). */
export function cancelPivotChromePress(): void {
  endPress();
}

function endPress(): Session | null {
  const s = session;
  if (!s) return null;
  session = null;
  s.releaseCursor();
  setPivotChromePressLive(false);
  window.removeEventListener("mousemove", onPressMove);
  window.removeEventListener("mouseup", onPressUp);
  window.removeEventListener("keydown", onPressKey, true);
  window.removeEventListener("blur", onPressBlur);
  requestOverlayRedraw();
  return s;
}

const onPressMove = (e: MouseEvent): void => {
  if (!session) return;
  // The press exists only while the primary button is HELD: a move with it up
  // means its release was never heard. Nothing acts.
  if ((e.buttons & 1) === 0) endPress();
};

const onPressUp = (e: MouseEvent): void => {
  if (!session) return;
  if (e.button !== 0) {
    // Another button let go. With the primary one still held the press goes
    // on; with it up this was never a primary press (a MIDDLE press starts
    // one too), and it ends here, acting on nothing.
    if ((e.buttons & 1) === 0) endPress();
    return;
  }
  const s = endPress();
  if (!s) return;
  const at = s.clientToCanvas(e.clientX, e.clientY);
  if (!at) return;
  const record = getPivotVisualRecord(s.pivotId);
  const hit = record ? hitPivotVisualChrome(record, at.x, at.y) : null;
  // Released over the SAME piece of chrome it was pressed on, or nothing.
  if (!hit || pressKey(s.pivotId, hit) !== s.key) return;
  // ...and where no other object covers the box: Core's press there would
  // have gone to the cover.
  if (s.regionId !== null && isFloatingRegionCoveredAtClient(s.regionId, e.clientX, e.clientY)) return;
  handlePivotVisualPress(s.pivotId, at.x, at.y);
};

const onPressKey = (e: KeyboardEvent): void => {
  if (!session || e.key !== "Escape") return;
  // The Escape is the press's: nothing else acts on it too.
  e.preventDefault();
  e.stopPropagation();
  endPress();
};

const onPressBlur = (): void => {
  endPress();
};
