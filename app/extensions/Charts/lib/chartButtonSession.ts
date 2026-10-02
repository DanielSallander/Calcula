//! FILENAME: app/extensions/Charts/lib/chartButtonSession.ts
// PURPOSE: The LIFE of a press on one of the chart's own buttons -- a selected
//          chart's quick-access button, a pivot chart's field button, a
//          selected chart's widget step or option (lib/chartButtonPress.ts is
//          the hit test). The press is armed at Core's
//          `floatingObject:bodyDragStart` and acts only when it is RELEASED over
//          the same button (index.ts `handleMouseUp` -> `releaseChartButton`);
//          this module keeps everything that must hold for exactly as long as
//          the press does (BUG-0258 design phase 4b; M7 review):
//            - Escape and a window blur END it with nothing done -- as every
//              other content press in phase 4 does (the slicer's items, the
//              pivot box's chrome, a run-mode button). An Escape is the
//              press's: stopped here (capture phase) and claimed through the
//              chart's object-selection provider meanwhile
//              (chartObjectSelection.ts `chartOwnsObjectKey`), so a canvas
//              does not also deselect the chart under the pointer;
//            - it holds Core's pointer over the chart
//              (`holdContentGestureCursor`, the slicer and timeline gestures'
//              seam): no grip shows and no resize handle answers under a held
//              button;
//            - the next press, a move with the primary button UP (a release
//              this page never heard), the release itself and the extension's
//              deactivation end it too (index.ts calls the doors below).
//          The window keydown and blur listeners are bound at the press and
//          removed on every one of those paths (core/lib/globalInputListeners.ts
//          calls the keydown session-scoped). The ONE mouseup stays index.ts's,
//          bound per press for the brush, the pending click and this press
//          alike (chartMouseupLifetime.test.ts).

import { holdContentGestureCursor, requestOverlayRedraw } from "@api/gridOverlays";
import type { ChartButtonPart } from "./chartButtonPress";

/** A held press on one of the chart's own buttons. */
export interface ChartButtonPressState {
  chartId: string;
  /** The grid region Core pressed (the chart's), or null when Core named none. */
  regionId: string | null;
  part: ChartButtonPart;
  /** Which button: the release must name the same one. */
  key: string;
  /** The press point, logical canvas px (Core's basis); the popup / menu anchor. */
  pressX: number;
  pressY: number;
}

interface Session {
  press: ChartButtonPressState;
  /** Lets go of Core's pointer this press holds (every end path runs it). */
  releaseCursor: () => void;
}

let session: Session | null = null;

/** Whether a chart-button press is held (it owns Escape). */
export function isChartButtonPressActive(): boolean {
  return session !== null;
}

/** Arm a press on a chart button. A press still held (its release never came) ends first, doing nothing. */
export function beginChartButtonPress(press: ChartButtonPressState): void {
  cancelChartButtonPress();
  session = {
    press,
    releaseCursor: press.regionId !== null ? holdContentGestureCursor(press.regionId, "pointer") : () => {},
  };
  window.addEventListener("keydown", onPressKey, true);
  window.addEventListener("blur", onPressBlur);
  // A canvas-selected chart's grip hides while the press holds the pointer.
  requestOverlayRedraw();
}

/**
 * The RELEASE: end the press and hand it back, for index.ts to act on when the
 * release names the same button. Null when no press is held.
 */
export function takeChartButtonPress(): ChartButtonPressState | null {
  const s = endPress();
  return s ? s.press : null;
}

/** End a held press WITHOUT acting (Escape, blur, a lost release, the next press, deactivation). */
export function cancelChartButtonPress(): void {
  endPress();
}

function endPress(): Session | null {
  const s = session;
  if (!s) return null;
  session = null;
  s.releaseCursor();
  window.removeEventListener("keydown", onPressKey, true);
  window.removeEventListener("blur", onPressBlur);
  requestOverlayRedraw();
  return s;
}

const onPressKey = (e: KeyboardEvent): void => {
  if (!session || e.key !== "Escape") return;
  // The Escape is the press's: nothing else acts on it too (the chart's own
  // Escape steps its sub-selection up one level).
  e.preventDefault();
  e.stopPropagation();
  cancelChartButtonPress();
};

const onPressBlur = (): void => {
  cancelChartButtonPress();
};
