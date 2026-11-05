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

/** An inclusive run of rows. */
export interface AutoFitRowSpan {
  startRow: number;
  endRow: number;
}

export interface AutoFitContributor {
  /** Unique id (used for unregistration and error attribution). */
  id: string;
  /**
   * Report space requirements for a column being auto-fitted.
   * Return null when the contributor renders nothing in this column.
   *
   * `rows` (BUG-0351): the rows being fitted -- Home > Format > AutoFit Column
   * Width fits only the SELECTED cells (Excel), so A1 selected must not size
   * column A for a PivotTable in A20:C40. Absent, the whole column is fitted
   * (the header double-click). A contributor should measure only its content
   * inside `rows`; whatever it reports is clipped to them anyway (see
   * collectAutoFitColumnContributions).
   */
  measureColumn?: (
    col: number,
    measureCtx: CanvasRenderingContext2D,
    rows?: readonly AutoFitRowSpan[]
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
  measureCtx: CanvasRenderingContext2D,
  rows?: readonly AutoFitRowSpan[]
): AutoFitColumnContribution[] {
  const results: AutoFitColumnContribution[] = [];
  for (const contributor of contributors) {
    if (!contributor.measureColumn) continue;
    try {
      const contribution = contributor.measureColumn(col, measureCtx, rows);
      if (contribution) {
        const clipped = rows ? clipToRows(contribution, rows) : contribution;
        if (clipped) results.push(clipped);
      }
    } catch (error) {
      console.error(`[AutoFit] Error in contributor "${contributor.id}" (column):`, error);
    }
  }
  return results;
}

/**
 * A column contribution restricted to the fitted `rows` (BUG-0351): its
 * claimed spans are cut to them, its per-cell chrome outside them dropped, and
 * a required width is kept only when some claimed span still reaches into the
 * fitted rows -- a contributor that rendered nothing there (a PivotTable lower
 * down the column) sizes nothing. A width with NO claimed span at all says
 * nothing about where it applies, so it is kept as reported. Null when
 * nothing is left.
 */
function clipToRows(
  contribution: AutoFitColumnContribution,
  rows: readonly AutoFitRowSpan[]
): AutoFitColumnContribution | null {
  const inRows = (row: number) => rows.some((r) => row >= r.startRow && row <= r.endRow);
  const out: AutoFitColumnContribution = {};
  if (contribution.claimedRowRanges) {
    const claimed: AutoFitRowSpan[] = [];
    for (const span of contribution.claimedRowRanges) {
      for (const r of rows) {
        const startRow = Math.max(span.startRow, r.startRow);
        const endRow = Math.min(span.endRow, r.endRow);
        if (startRow <= endRow) claimed.push({ startRow, endRow });
      }
    }
    if (claimed.length > 0) out.claimedRowRanges = claimed;
    if (contribution.requiredWidth !== undefined && claimed.length > 0) out.requiredWidth = contribution.requiredWidth;
  } else if (contribution.requiredWidth !== undefined) {
    out.requiredWidth = contribution.requiredWidth;
  }
  if (contribution.extraCellWidth) {
    const extra = new Map<number, number>();
    for (const [row, width] of contribution.extraCellWidth) {
      if (inRows(row)) extra.set(row, width);
    }
    if (extra.size > 0) out.extraCellWidth = extra;
  }
  return out.claimedRowRanges || out.requiredWidth !== undefined || out.extraCellWidth ? out : null;
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
