//! FILENAME: app/src/core/lib/gridRenderer/layout/headerVisibility.ts
// PURPOSE: THE rule for what the row/column header gutters measure when the
//          headings are hidden. One function, so the painter, the hit-tester,
//          the inline editor and the E2E geometry helper cannot disagree.
// CONTEXT: Core/pure; no imports beyond types.
//
// WHY THIS EXISTS AS A MODULE
// ---------------------------
// `View > Headings` off collapses both gutters to zero and the cell area expands
// to fill the canvas. That substitution used to live INSIDE `renderGrid`, as a
// local `effectiveConfig`, while every other consumer read `config` straight —
// and `config.rowHeaderWidth` keeps reporting 22 when the headings are hidden.
// So on a headings-off canvas the painter draws a cell at x while everything
// that answers "what is at x" looks 22px (and 20px) away from where it drew it.
// It is a module so the rule has a name and one text, and so the E2E geometry
// helper (`app/e2e/helpers/grid.ts`) can IMPORT it instead of keeping a second
// spelling that drifts.
//
// WHAT THIS MODULE DOES AND DOES NOT CLOSE
// ----------------------------------------
// `renderGrid` calls it, and the E2E helper calls it, so the PAINTER and the
// TEST HARNESS agree. The interaction layer does NOT yet, and that is measured
// rather than overlooked: cell hit-testing, the floating-control hit rectangle,
// the fill handle and the inline editor still read the raw config, so on a
// deliberately headings-off canvas they sit one header size away from the paint.
//
// 0 IS NOW A LEGAL GUTTER WIDTH (closed 2026-08-08)
// -------------------------------------------------
// It was not, and the reason was an idiom: the gutters were read as
// `config.rowHeaderWidth || 50` in 93 places across Core and the extensions
// (`interaction/hitTesting.ts` alone had nine). `||` cannot tell "0" from
// "missing", so writing a legitimate 0 into the config produced 50 — a BIGGER
// offset than the 22/20 it was meant to remove. Every one of those sites now
// reads through {@link rowHeaderGutter} / {@link colHeaderGutter}, which use
// `??`, so a collapsed gutter survives the read.
//
// THE SECOND LITERAL WAS ALSO WRONG, which is the more interesting half. Those
// fallbacks said 50 and 24; the configured defaults are 22 and 20 and have been
// since the Excel-tight header change. So on any config where the field was
// missing, 93 sites silently agreed on a geometry the product does not have —
// the same shape of defect as the 64.29 column-width drift. The fallbacks are
// therefore no longer literals at all: they are read from DEFAULT_GRID_CONFIG,
// so there is exactly one place a gutter size is written down.

import { DEFAULT_GRID_CONFIG, type GridConfig } from "../../../types";

/**
 * Row-gutter width used when the config carries none and the headings are shown.
 *
 * Derived, never typed: a hand-written copy here is precisely how this drifted
 * to 50 while the product moved to 22.
 */
export const FALLBACK_ROW_HEADER_WIDTH = DEFAULT_GRID_CONFIG.rowHeaderWidth;
/** Column-gutter height used when the config carries none and headings are shown. */
export const FALLBACK_COL_HEADER_HEIGHT = DEFAULT_GRID_CONFIG.colHeaderHeight;

/**
 * The row-header gutter a config is asking for, in logical pixels.
 *
 * `??`, NOT `||`: 0 is a real answer (headings hidden), not a missing value.
 * This is the accessor every painter, hit-tester, overlay and helper reads
 * through, so the collapsed case cannot be resurrected by one straggler.
 */
export function rowHeaderGutter(config: { rowHeaderWidth?: number }): number {
  return config.rowHeaderWidth ?? FALLBACK_ROW_HEADER_WIDTH;
}

/** The column-header gutter a config is asking for, in logical pixels. */
export function colHeaderGutter(config: { colHeaderHeight?: number }): number {
  return config.colHeaderHeight ?? FALLBACK_COL_HEADER_HEIGHT;
}

/**
 * The header gutter sizes actually in force, in LOGICAL (pre-zoom) pixels.
 *
 * `displayHeadings === false` collapses both to 0. Anything else — `true`, or
 * `undefined` for a caller that does not track the flag — keeps the configured
 * sizes, defaulting only when the config carries no value at all. A config that
 * already says 0 is answered with 0: since this rule became the one source, a
 * collapsed gutter reaching here is the headings-off case arriving by a second
 * route, not a gap to be filled in.
 */
export function resolveHeaderSizes(
  config: { rowHeaderWidth?: number; colHeaderHeight?: number },
  displayHeadings?: boolean,
): { rowHeaderWidth: number; colHeaderHeight: number } {
  if (displayHeadings === false) {
    return { rowHeaderWidth: 0, colHeaderHeight: 0 };
  }
  return {
    rowHeaderWidth: rowHeaderGutter(config),
    colHeaderHeight: colHeaderGutter(config),
  };
}

/**
 * The same rule applied to a whole {@link GridConfig}.
 *
 * Returns the SAME object when nothing changes, so a React memo keyed on it does
 * not invalidate on every render. Only the two gutter fields are ever touched.
 */
export function effectiveGridConfig<T extends GridConfig>(
  config: T,
  displayHeadings?: boolean,
): T {
  if (displayHeadings !== false) return config;
  if (config.rowHeaderWidth === 0 && config.colHeaderHeight === 0) return config;
  return { ...config, rowHeaderWidth: 0, colHeaderHeight: 0 };
}
