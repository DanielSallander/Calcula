//! FILENAME: app/src/core/lib/renderSignal.ts
// PURPOSE: A tiny, honest answer to "has the grid finished fetching and
//          repainting?" — the signal a screenshot must wait for.
// CONTEXT: Every capture helper in `e2e/helpers/screenshots.ts` used to wait a
//          FIXED 500 ms plus two `requestAnimationFrame` ticks and then
//          photograph whatever was on the canvas. That is a sleep, not a wait:
//          `GridCanvas.fetchCells` is async, it DEFERS a request that arrives
//          while another is in flight (re-issuing it afterwards through
//          `fetchGeneration`), and the repaint that shows the new cells happens
//          in a later effect. Nothing outside the component could observe any of
//          that, so a golden recorded while a fetch was still in flight is a
//          picture of the PREVIOUS state — and it passes or fails on how busy
//          the machine was. Two goldens in the visual suite differed between two
//          runs of the same suite for exactly this reason.
//
//          WHY A COUNTER PAIR AND NOT A BOOLEAN. "Idle" is not the question. The
//          question is "has a paint happened SINCE the data last changed", and a
//          boolean cannot express it: between `setCells` and the repaint the
//          component is idle by every other measure. `dataSeq` is bumped when
//          fetched data is committed to state and `paintedDataSeq` is stamped at
//          the end of each paint, so quiescence is the equality of two numbers
//          and cannot be faked by a lull.
//
//          WHY IT LIVES IN CORE. It is a property OF the renderer, published by
//          the renderer. This is the same shape as `__CALCULA_GRID_STATE__`
//          (GridContext.tsx), which Core already mirrors onto `window` for the
//          harness: Core depends on nothing, and the harness reads a value Core
//          was going to compute anyway. It costs four integer increments per
//          fetch/paint and no allocation.

/** What the harness reads. All counters are monotonic within a page lifetime. */
export interface GridRenderSignal {
  /** Bumped when fetched cell data is COMMITTED to component state. */
  dataSeq: number;
  /** How many viewport fetches are in flight right now. */
  fetchesInFlight: number;
  /** A fetch arrived while another was running and will be re-issued. */
  refetchQueued: boolean;
  /** Bumped at the end of every canvas paint. */
  paintSeq: number;
  /** The value of `dataSeq` as of the last completed paint. */
  paintedDataSeq: number;
}

const signal: GridRenderSignal = {
  dataSeq: 0,
  fetchesInFlight: 0,
  refetchQueued: false,
  paintSeq: 0,
  paintedDataSeq: 0,
};

/**
 * Mirror onto `window` so an out-of-process harness can read it.
 *
 * The SAME object, not a copy — a snapshot would go stale the moment it was
 * published, which is the failure mode this module exists to remove.
 */
function publish(): void {
  if (typeof window !== "undefined") {
    (window as unknown as Record<string, unknown>).__CALCULA_GRID_RENDER__ = signal;
  }
}
publish();

/** A viewport fetch has started. */
export function markFetchStarted(): void {
  signal.fetchesInFlight += 1;
  publish();
}

/** A viewport fetch has finished, successfully or not. */
export function markFetchSettled(): void {
  signal.fetchesInFlight = Math.max(0, signal.fetchesInFlight - 1);
  publish();
}

/** A fetch was deferred behind an in-flight one and will be re-issued. */
export function markRefetchQueued(queued: boolean): void {
  signal.refetchQueued = queued;
  publish();
}

/** Fetched data has been committed to state; a repaint is now owed. */
export function markDataCommitted(): void {
  signal.dataSeq += 1;
  publish();
}

/** A paint has completed, and it drew everything committed up to now. */
export function markPainted(): void {
  signal.paintSeq += 1;
  signal.paintedDataSeq = signal.dataSeq;
  publish();
}

/** The live signal (the same object the window mirror exposes). */
export function readGridRenderSignal(): GridRenderSignal {
  return signal;
}

/**
 * True when there is no fetch in flight, none queued, and the last paint
 * already reflects the last committed data.
 */
export function isGridRenderQuiescent(): boolean {
  return (
    signal.fetchesInFlight === 0 &&
    !signal.refetchQueued &&
    signal.paintedDataSeq === signal.dataSeq
  );
}

/** Test-only reset so a suite can start from a known point. */
export function resetGridRenderSignal(): void {
  signal.dataSeq = 0;
  signal.fetchesInFlight = 0;
  signal.refetchQueued = false;
  signal.paintSeq = 0;
  signal.paintedDataSeq = 0;
  publish();
}
