//! FILENAME: app/src/api/autoFitContributors.ts
// PURPOSE: Auto-fit measurement contributors — extensions that render their own
//          content inside grid cells (pivot overlays, filter buttons, ...) tell
//          the Core's double-click best-fit how much space that content needs.
// ARCHITECTURE: API-layer registry (gridLayers pattern). Core's autoFit
//          measurement consults it; extensions register at activate() and
//          clean up at deactivate(). The API never imports extensions.
// CONTRACT: Measurement runs synchronously inside the double-click handler.
//          Contributors must answer from client-side caches only — no I/O.

/**
 * What a contributor reports for one column measurement.
 *
 * Widths follow the Core convention: a "required width" is the full column
 * width in pixels needed to display the contributor-rendered content,
 * including the contributor's own padding/chrome.
 */
export interface AutoFitColumnContribution {
  /**
   * Inclusive row spans whose cells the contributor renders itself (e.g. a
   * pivot overlay repainting its region with its own fonts). Core skips these
   * cells during text measurement — the contributor's requiredWidth speaks
   * for them instead.
   */
  claimedRowRanges?: Array<{ startRow: number; endRow: number }>;
  /**
   * Required pixel width for the contributor-rendered content in this column
   * (max over its cells). Omit when the contributor renders nothing here.
   */
  requiredWidth?: number;
  /**
   * Extra chrome pixels needed inside specific core-rendered cells, keyed by
   * row — e.g. an in-cell filter button that sits beside the cell text. Added
   * on top of the core-measured text width for that cell.
   */
  extraCellWidth?: Map<number, number>;
}

/** What a contributor reports for one row measurement. */
export interface AutoFitRowContribution {
  /** Inclusive column spans whose cells the contributor renders itself. */
  claimedColRanges?: Array<{ startCol: number; endCol: number }>;
  /** Required pixel height for the contributor-rendered content in this row. */
  requiredHeight?: number;
}

export interface AutoFitContributor {
  /** Unique id (used for unregistration and error attribution). */
  id: string;
  /**
   * Report space requirements for a column being auto-fitted.
   * Return null when the contributor renders nothing in this column.
   */
  measureColumn?: (
    col: number,
    measureCtx: CanvasRenderingContext2D
  ) => AutoFitColumnContribution | null;
  /**
   * Report space requirements for a row being auto-fitted.
   * Return null when the contributor renders nothing in this row.
   */
  measureRow?: (
    row: number,
    measureCtx: CanvasRenderingContext2D
  ) => AutoFitRowContribution | null;
}

// ============================================================================
// Internal State
// ============================================================================

const contributors: AutoFitContributor[] = [];

// ============================================================================
// Registry API
// ============================================================================

/**
 * Register an auto-fit contributor.
 * @returns Cleanup function that unregisters the contributor.
 */
export function registerAutoFitContributor(contributor: AutoFitContributor): () => void {
  contributors.push(contributor);
  return () => {
    const i = contributors.indexOf(contributor);
    if (i >= 0) contributors.splice(i, 1);
  };
}

/** Unregister a contributor by id. */
export function unregisterAutoFitContributor(id: string): void {
  const i = contributors.findIndex((c) => c.id === id);
  if (i >= 0) contributors.splice(i, 1);
}

/** Fast flag for the Core measurement loop. */
export function hasAutoFitContributors(): boolean {
  return contributors.length > 0;
}

/**
 * Collect column contributions from all registered contributors.
 * Each call is wrapped in try/catch — a throwing contributor is contained.
 */
export function collectAutoFitColumnContributions(
  col: number,
  measureCtx: CanvasRenderingContext2D
): AutoFitColumnContribution[] {
  const results: AutoFitColumnContribution[] = [];
  for (const contributor of contributors) {
    if (!contributor.measureColumn) continue;
    try {
      const contribution = contributor.measureColumn(col, measureCtx);
      if (contribution) results.push(contribution);
    } catch (error) {
      console.error(`[AutoFit] Error in contributor "${contributor.id}" (column):`, error);
    }
  }
  return results;
}

/** Collect row contributions from all registered contributors. */
export function collectAutoFitRowContributions(
  row: number,
  measureCtx: CanvasRenderingContext2D
): AutoFitRowContribution[] {
  const results: AutoFitRowContribution[] = [];
  for (const contributor of contributors) {
    if (!contributor.measureRow) continue;
    try {
      const contribution = contributor.measureRow(row, measureCtx);
      if (contribution) results.push(contribution);
    } catch (error) {
      console.error(`[AutoFit] Error in contributor "${contributor.id}" (row):`, error);
    }
  }
  return results;
}

/** All registered contributors (panels/tests). */
export function listAutoFitContributors(): readonly AutoFitContributor[] {
  return [...contributors].sort((a, b) => a.id.localeCompare(b.id));
}
