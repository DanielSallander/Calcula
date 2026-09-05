//! FILENAME: app/extensions/Controls/lib/regionPublication.ts
// PURPOSE: One announcement, made every time the floating store republishes its
//          overlay regions, carrying the ids that are painted FROM NOW ON — so
//          the per-control DOM a renderer parks outside the canvas (a shape's
//          `ui.html` iframe, the pointer-claiming shims over it) can be released
//          for the controls that are no longer painted.
// CONTEXT: Every release path a shape's hit shims had ran either from INSIDE the
//          render pass (`updateHtmlOverlay`'s hidden branch, the two off-screen
//          early-outs, the "no html content" branch) or from an explicit
//          teardown (delete, unmount, deactivate). Nothing ran when a control
//          simply STOPPED BEING RENDERED. A sheet switch swaps the store
//          (`removeFloatingControlsForSheet` + `loadFloatingControls`), the
//          departing sheet's control loses its overlay region, and
//          `renderFloatingShape` is never called for it again — so its shims
//          stayed at the canvas pixels the shape used to occupy, still
//          `pointer-events: auto`, swallowing every click on the NEW sheet's
//          bare grid. Design Mode did not rescue the user either: the suspension
//          lives in `syncShapeHitDom`, which is exactly the function that is
//          no longer called. Publishing the region set and releasing the DOM are
//          now ONE fact instead of two that can drift.
//
//          WHY A LISTENER RATHER THAN A DIRECT CALL. The store cannot import the
//          shape renderer: that would drag `@api`, the control API and the
//          selection store into the module graph of every floatingStore
//          consumer, and the store has no business knowing which renderers park
//          DOM. So the store ANNOUNCES and the painters subscribe — the
//          extension's own inversion-of-control rule. This module is deliberately
//          a LEAF with no imports at all, so subscribing costs a painter nothing.

/** Told the ids that are painted from now on; everything else is released. */
export type RegionPublicationListener = (paintedIds: ReadonlySet<string>) => void;

const listeners = new Set<RegionPublicationListener>();

/**
 * Subscribe to region publication. Returns an unsubscribe.
 *
 * Subscribing at MODULE SCOPE is what makes this safe: a painter's DOM can only
 * exist once its module has been loaded, so a listener registered on import is
 * always in place before there is anything to release.
 */
export function onFloatingControlRegionsPublished(
  listener: RegionPublicationListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Announce the ids the store just published.
 *
 * One listener throwing must not stop the rest: a half-swept publication would
 * leave exactly the residue this announcement exists to remove, and the caller
 * (the store) has no way to recover from a painter's failure.
 */
export function announceFloatingControlRegions(paintedIds: ReadonlySet<string>): void {
  for (const listener of listeners) {
    try {
      listener(paintedIds);
    } catch (err) {
      console.error("[Controls] A region-publication listener failed:", err);
    }
  }
}
