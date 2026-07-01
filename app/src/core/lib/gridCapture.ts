//! FILENAME: app/src/core/lib/gridCapture.ts
// PURPOSE: Capture a cell-range region of the live main grid canvas as ImageData
//          (RGBA), for exporting an animated grid selection (e.g. to GIF).
// CONTEXT: Extensions cannot reach the grid canvas React ref, so GridCanvas
//   registers a capturer here (it owns the canvas + config/dimensions/viewport/
//   zoom needed to map a cell range to backing-store pixels). captureGridRegion()
//   delegates to it; @api re-exports captureGridRegion for capture/export pipelines.

export interface CaptureRange {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

export type GridRegionCapturer = (range: CaptureRange) => ImageData | null;

let capturer: GridRegionCapturer | null = null;

/** GridCanvas registers its capturer on mount, and null on unmount. */
export function setGridCapturer(fn: GridRegionCapturer | null): void {
  capturer = fn;
}

/** True once a grid canvas has registered a capturer. */
export function isGridCaptureReady(): boolean {
  return capturer !== null;
}

/**
 * Capture the on-screen pixels covering `range` as ImageData, or null if no grid
 * is mounted / the range is off-screen / capture failed. Pixel dimensions are in
 * the canvas backing store (device pixels), stable across frames for a fixed range
 * and scroll.
 */
export function captureGridRegion(range: CaptureRange): ImageData | null {
  return capturer ? capturer(range) : null;
}

// ---------------------------------------------------------------------------
// Live canvas element (for captureStream-based recording, e.g. WebM export).
// GridCanvas registers its element on mount; consumers must not retain it past
// unmount (it is nulled on unmount).
// ---------------------------------------------------------------------------

let gridCanvasEl: HTMLCanvasElement | null = null;

/** GridCanvas registers its canvas element on mount, and null on unmount. */
export function setGridCanvas(el: HTMLCanvasElement | null): void {
  gridCanvasEl = el;
}

/** The live main grid canvas element, or null if no grid is mounted. */
export function getGridCanvas(): HTMLCanvasElement | null {
  return gridCanvasEl;
}
