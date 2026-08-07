//! FILENAME: app/src/api/tracingService.ts
// PURPOSE: The feature-neutral seam through which the API facade can drive
//          formula trace arrows without knowing that a Tracing extension
//          exists.
// CONTEXT: Inversion of Control, the same shape groupingService.ts,
//          autoFilterService.ts and printService.ts use.
//
// WHY TRACING NEEDS A CONTROLLER AND NOT A REFRESH EVENT.
//
// The sibling defects in this class — grouping, hyperlinks, validations,
// annotations — are all "the backend changed and the frontend cache did not
// hear about it", and they are fixed by announcing from the IPC wrapper.
// Tracing is NOT that shape, and treating it as if it were produces a refresh
// event nothing can ever fire.
//
// `trace_precedents` / `trace_dependents` are pure QUERIES. They compute the
// dependency graph and return it; they mutate nothing. The arrows are entirely
// frontend state: the Tracing extension turns one query result into arrow
// records, accumulates them across levels (each further Trace Precedents click
// expands the previous frontier), and paints them from its own grid region.
// Invoking the Rust command changes zero pixels because there is nothing for it
// to change — measured, and correct by construction.
//
// So the thing that was missing is not a notification, it is a DOOR: no caller
// outside the Tracing extension could draw an arrow at all. That is what this
// seam is. Callers state intent ("trace this cell's precedents") and the
// extension does the accumulate-and-paint that only it knows how to do — the
// same reason groupingService refuses to let callers reach the backend
// directly and grouping invisibly.

/** What one tracing operation produced. */
export interface TracingOpResult {
  /** Arrows on screen after the operation (all levels, both directions). */
  arrowCount: number;
  /** Precedent levels currently expanded (0 = none). */
  precedentLevel: number;
  /** Dependent levels currently expanded (0 = none). */
  dependentLevel: number;
}

/**
 * What the Tracing extension provides. Every method acts on the ACTIVE SHEET,
 * because the backend trace commands do — there is no sheet parameter to pass,
 * so callers must switch sheets first rather than be silently retargeted.
 *
 * `tracePrecedents` / `traceDependents` are Excel's buttons, not raw queries:
 * calling one repeatedly expands one level further each time, and switching to
 * a different cell resets the accumulation. Implementations must leave the
 * arrows painted before resolving.
 */
export interface TracingController {
  /**
   * Expand precedent tracing one level for `row`/`col` (Excel's Trace
   * Precedents button). Repeated calls walk further back through the graph.
   */
  tracePrecedents(row: number, col: number): Promise<TracingOpResult>;
  /** Expand dependent tracing one level for `row`/`col`. */
  traceDependents(row: number, col: number): Promise<TracingOpResult>;
  /** Remove every arrow and reset the accumulated levels. */
  removeAllArrows(): void;
  /** Arrows currently on screen (0 when nothing is traced). */
  getArrowCount(): number;
}

let controller: TracingController | null = null;

/**
 * Register the Tracing driver. Called once by the Tracing extension at
 * activation; returns the unregister function for its cleanup list.
 *
 * Last registration wins, and unregistering only clears the controller if it is
 * still the one that was registered — so a re-activation followed by the OLD
 * cleanup running cannot blank out the live provider.
 */
export function registerTracingController(
  next: TracingController,
): () => void {
  controller = next;
  return () => {
    if (controller === next) controller = null;
  };
}

/** Whether trace arrows are currently drivable. */
export function hasTracingController(): boolean {
  return controller !== null;
}

/**
 * The registered controller.
 *
 * THROWS when none is registered (the Tracing extension is disabled or failed
 * to load). Refusing loudly is the point: the alternative is a caller invoking
 * the backend query directly, getting a perfectly good dependency graph back,
 * and reporting success while the user sees no arrow.
 */
export function requireTracingController(): TracingController {
  if (!controller) {
    throw new Error(
      "Formula tracing is unavailable: no Tracing provider is registered (the Tracing extension is not loaded).",
    );
  }
  return controller;
}

/** Test/reset hook: forget the registered controller. */
export function resetTracingController(): void {
  controller = null;
}
