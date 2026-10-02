//! FILENAME: app/src/core/lib/floatingChromeProbe.ts
// PURPOSE: The one slot through which Core's object CHROME that lies OUTSIDE
//          an object's rectangle -- today the six-dot grip
//          (core/lib/floatingGrip.ts, BUG-0258 design phase 5) -- answers
//          @api/gridOverlays `topFloatingRegionAt` ("which object owns this
//          point?"), so every family's right-click, wheel and hover lookup
//          agrees with Core's press on a visible grip (plan decision D6).
// CONTEXT: A LEAF with no runtime imports, read by the facade and written by the
//          grip module. The grip module imports the facade and the selection
//          seam, so the facade cannot import it back (the cycle
//          floatingHandleMetrics.ts describes); and the grip cannot register
//          through a function EXPORTED by the facade, because a test that
//          replaces the facade with a module mock lacking that export would
//          fail every file that loads the grid renderer. Both sides reach this
//          leaf instead -- the `registerGridReferencePickProbe` inversion.

import type { FloatingHitGeometry, GridRegion } from "../../api/gridOverlays";

/**
 * Given a logical canvas point, the geometry and the regions
 * `topFloatingRegionAt` was asked with: the object whose visible chrome is
 * there, or null.
 */
export type FloatingChromeHitProbe = (
  canvasX: number,
  canvasY: number,
  geo: FloatingHitGeometry,
  regions: readonly GridRegion[],
) => GridRegion | null;

let probe: FloatingChromeHitProbe | null = null;

/**
 * CORE-ONLY: hand `topFloatingRegionAt` a chrome hit test. Last registration
 * wins; the cleanup removes only what is still this probe.
 */
export function registerFloatingChromeHitProbe(p: FloatingChromeHitProbe): () => void {
  probe = p;
  return () => {
    if (probe === p) probe = null;
  };
}

/** The registered chrome probe, or null. */
export function floatingChromeHitProbe(): FloatingChromeHitProbe | null {
  return probe;
}
