//! FILENAME: app/extensions/Slicer/lib/slicerGestureView.ts
// PURPOSE: What a slicer's CONTENT gesture shows while it lives, and while its
//          commit lands: the run of items a drag across them covers. State
//          only -- a leaf with no runtime imports.
// CONTEXT: BUG-0258 design phase 4. A drag across a slicer's items selects the
//          run (owner decision D4) and commits it ONCE, at release
//          (lib/slicerItemDrag.ts). While the button is held nothing is
//          written; the renderer paints the run from here instead
//          (rendering/slicerRenderer.ts, through
//          `selectionShownDuringRun`, so the paint is exactly what the release
//          commits). A released run stays on screen until its commit has
//          LANDED -- otherwise the old selection flashes back between the
//          release and the refreshed item flags (the timeline's lesson,
//          TimelineSlicer/lib/timelineGestureView.ts).
//          The POINTER the gesture owns is not here: it is held through Core's
//          own seam (@api/gridOverlays `holdContentGestureCursor`), so the zone
//          answer (`slicerZoneAt`) stays pure. slicerItemDrag.ts is the only
//          writer; it imports the renderer, which reads this -- so this state
//          cannot live in either of them without a cycle.

/** A drag's run as the screen shows it. */
export interface SlicerGestureView {
  slicerId: string;
  /** The run the drag covers, in sweep order (the last is under the pointer). */
  values: readonly string[];
  /** Ctrl was held: the run is added to the selection. */
  additive: boolean;
}

let live: SlicerGestureView | null = null;

/** Released runs kept on screen until their commit lands, per slicer. */
const landing = new Map<string, SlicerGestureView>();

/** Show (or, with null, stop showing) the live drag's run. The drag's only. */
export function showSlicerGesture(view: SlicerGestureView | null): void {
  live = view;
}

/** Hold a released run on screen until its commit lands. The drag's only. */
export function holdLandingRun(view: SlicerGestureView): void {
  landing.set(view.slicerId, view);
}

/** Let go of a landed run -- only if a newer release has not replaced it. */
export function releaseLandingRun(view: SlicerGestureView): void {
  if (landing.get(view.slicerId) === view) landing.delete(view.slicerId);
}

/**
 * The run to PAINT for a slicer instead of its committed selection: the live
 * drag's, or a released drag's until its commit lands. Null otherwise.
 */
export function getSlicerRunPreview(slicerId: string): SlicerGestureView | null {
  if (live && live.slicerId === slicerId) return live;
  return landing.get(slicerId) ?? null;
}

/** Forget everything (deactivation, tests). */
export function resetSlicerGestureView(): void {
  live = null;
  landing.clear();
}
