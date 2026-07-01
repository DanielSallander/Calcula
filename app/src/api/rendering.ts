//! FILENAME: app/src/api/rendering.ts
// PURPOSE: Feature-neutral rendering / frame-capture facade.
// CONTEXT: The on-screen render of a chart is owned by the Charts extension (its
//   OffscreenCanvas cache). A capture/export pipeline (e.g. the Animation GIF/WebM
//   exporter) needs to (a) wait until the render has SETTLED to a current frame and
//   (b) grab that frame's bitmap. This facade exposes those as generic capabilities;
//   the Charts extension provides the implementation via registerChartRenderingApi
//   (IoC), so this facade imports NO extension (No First-Class Citizens / A2).

/** The chart-render capture surface, implemented by the Charts extension. */
export interface ChartRenderingApi {
  /** A PNG blob of the chart's current cached raster, or null if it has none. */
  getChartFrameBitmap(chartId: string): Promise<Blob | null>;
  /** The chart's current cached raster as ImageData (RGBA), or null if it has none. */
  getChartFrameImageData(chartId: string): ImageData | null;
  /** True while an async render for this chart is in flight. */
  isChartRenderPending(chartId: string): boolean;
  /** True when the chart's cached raster is at its latest requested version (not stale). */
  isChartRenderCurrent(chartId: string): boolean;
  /** Coarse global signal: no chart render is currently in flight. */
  chartsIdle(): boolean;
}

let registered: ChartRenderingApi | null = null;

/**
 * Provide the chart-rendering implementation. Called once by the Charts extension
 * in activate(), and with `null` on deactivate. Inverts the dependency so this
 * facade never imports the Charts extension.
 */
export function registerChartRenderingApi(impl: ChartRenderingApi | null): void {
  registered = impl;
}

export function getChartRenderingApi(): ChartRenderingApi | null {
  return registered;
}

/** Capture a chart's current raster as a PNG blob (null if charts unavailable / not cached). */
export async function getChartFrameBitmap(chartId: string): Promise<Blob | null> {
  return registered ? registered.getChartFrameBitmap(chartId) : null;
}

/** Capture a chart's current raster as ImageData (null if charts unavailable / not cached). */
export function getChartFrameImageData(chartId: string): ImageData | null {
  return registered ? registered.getChartFrameImageData(chartId) : null;
}

/** True while an async render for this chart is in flight (false if no charts API). */
export function isChartRenderPending(chartId: string): boolean {
  return registered ? registered.isChartRenderPending(chartId) : false;
}

/** True when the chart's raster is current — or when no charts API is registered. */
export function isChartRenderCurrent(chartId: string): boolean {
  return registered ? registered.isChartRenderCurrent(chartId) : true;
}

/** Coarse global signal: no chart render in flight — or no charts API registered. */
export function chartsIdle(): boolean {
  return registered ? registered.chartsIdle() : true;
}

// Generic grid-canvas region capture (implemented by Core; GridCanvas registers
// the capturer on mount). Used by capture/export to grab a cell range's on-screen
// pixels as ImageData (e.g. animating a grid selection to GIF).
export { captureGridRegion, isGridCaptureReady, getGridCanvas, type CaptureRange } from "../core/lib/gridCapture";

export interface RenderSettleOptions {
  /** Wait for THIS chart to be current + not pending; omit for the coarse global gate. */
  chartId?: string;
  /** Max frames to wait before giving up (default 120 ≈ 2s @ 60fps). */
  maxFrames?: number;
}

/**
 * Resolve once the on-screen render has settled and a subsequent paint has flushed
 * (double rAF). With `chartId`, waits until that chart's raster is current and not
 * rendering; otherwise waits for the coarse global idle. Degrades to a paint-flush
 * when no charts API is registered. Used by capture/export to grab a stable frame.
 */
export async function awaitRenderSettled(options: RenderSettleOptions = {}): Promise<void> {
  const maxFrames = options.maxFrames ?? 120;
  const settled = (): boolean => {
    if (!registered) return true;
    if (options.chartId) {
      return (
        registered.isChartRenderCurrent(options.chartId) &&
        !registered.isChartRenderPending(options.chartId)
      );
    }
    return registered.chartsIdle();
  };

  await new Promise<void>((resolve) => {
    let frames = 0;
    const tick = (): void => {
      if (settled() || frames >= maxFrames) {
        resolve();
        return;
      }
      frames += 1;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  // Double rAF so the post-settle composite has painted before we capture.
  await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
}
