//! FILENAME: app/src/api/conditionalFormatPaint.ts
// PURPOSE: The seam through which an object that shows cells of its own (a
//          floating grid) paints CONDITIONAL FORMATTING on them without importing
//          the Conditional Formatting extension (Seam Rule).
// CONTEXT: Two halves.
//
//          1. STYLE (fills, fonts, borders, colour scales):
//             `conditionalResultsToOverride(results)` folds a cell's evaluated
//             results into one style override -- first match wins per property,
//             a colour scale's colour before any rule fill. It is THE fold: the
//             Conditional Formatting extension's grid interceptor calls it too,
//             so the sheet and an object cannot disagree about which rule wins.
//             Hand the result to `paintStyledCellBox` as `conditional`
//             (`@api/cellPaint`).
//
//          2. GLYPHS (data bars, icon sets): a painter REGISTRY. The Conditional
//             Formatting extension registers one painter on activation; an object
//             calls `paintConditionalFormat(ctx, box, results, rules)` after the
//             cell's text. With no painter registered it paints nothing and
//             throws nothing.
//
// `rules` ARE THE BACKING SHEET'S RULES. A floating grid's cells live on a
// backing sheet, and the rules that produced its results must come with them
// (`CellTargetCells.rules`). The registered painter looks each result's rule up
// in that list by `ruleId` -- never in the CF extension's own store, which holds
// the ACTIVE sheet's rules and would hand every bar the default colour.
//
// USAGE:
//   import { paintConditionalFormat, conditionalResultsToOverride } from "@api/conditionalFormatPaint";
//   const conditional = conditionalResultsToOverride(resultsForCell);
//   paintStyledCellBox(ctx, box, { cell, style, valueKind, conditional });
//   paintConditionalFormat(ctx, box, resultsForCell, cellTargetCells.rules);
//
//   // In the extension that draws the glyphs:
//   const unregister = registerConditionalFormatPainter({ paint(ctx, box, results, rules) { ... } });

import type { CellConditionalFormat, ConditionalFormatDefinition } from "./backend";
import type { IStyleOverride } from "./styleInterceptors";
import type { CellBox } from "./cellPaint";

/** A painter for the glyph part of conditional formatting (data bars, icon sets). */
export interface ConditionalFormatPainter {
  paint(
    ctx: CanvasRenderingContext2D,
    box: CellBox,
    results: CellConditionalFormat[],
    rules: ConditionalFormatDefinition[],
  ): void;
}

const painters = new Set<ConditionalFormatPainter>();

/**
 * Register a glyph painter. Returns the unregister function (call it on
 * deactivation).
 */
export function registerConditionalFormatPainter(p: ConditionalFormatPainter): () => void {
  painters.add(p);
  return () => {
    painters.delete(p);
  };
}

/** True when at least one glyph painter is registered. */
export function hasConditionalFormatPainters(): boolean {
  return painters.size > 0;
}

/**
 * Paint the conditional-format glyphs of ONE cell into `box`. `results` are that
 * cell's evaluated results; `rules` are the rules of the sheet the cell lives on.
 * A painter that throws is logged and skipped -- a broken painter must not take
 * the object's paint down with it.
 */
export function paintConditionalFormat(
  ctx: CanvasRenderingContext2D,
  box: CellBox,
  results: CellConditionalFormat[],
  rules: ConditionalFormatDefinition[],
): void {
  if (painters.size === 0 || results.length === 0) return;
  for (const p of painters) {
    try {
      p.paint(ctx, box, results, rules);
    } catch (err) {
      console.error("[conditionalFormatPaint] painter failed:", err);
    }
  }
}

/**
 * Fold a cell's evaluated conditional-format results into ONE style override.
 * First match wins for each property (results arrive in the backend's
 * priority order); a colour scale's colour beats any rule fill in the same
 * result. Returns null when nothing overrides.
 */
export function conditionalResultsToOverride(
  results: readonly CellConditionalFormat[] | null | undefined,
): IStyleOverride | null {
  if (!results || results.length === 0) return null;

  const override: IStyleOverride = {};
  let hasOverride = false;

  for (const cf of results) {
    if (cf.colorScaleColor && !override.backgroundColor) {
      override.backgroundColor = cf.colorScaleColor;
      hasOverride = true;
    }
    const fmt = cf.format;
    if (!fmt) continue;
    if (fmt.backgroundColor && !override.backgroundColor) {
      override.backgroundColor = fmt.backgroundColor;
      hasOverride = true;
    }
    if (fmt.textColor && !override.textColor) {
      override.textColor = fmt.textColor;
      hasOverride = true;
    }
    if (fmt.bold !== undefined && override.bold === undefined) {
      override.bold = fmt.bold;
      hasOverride = true;
    }
    if (fmt.italic !== undefined && override.italic === undefined) {
      override.italic = fmt.italic;
      hasOverride = true;
    }
    if (fmt.underline !== undefined && override.underline === undefined) {
      override.underline = fmt.underline;
      hasOverride = true;
    }
    if (fmt.strikethrough !== undefined && override.strikethrough === undefined) {
      override.strikethrough = fmt.strikethrough;
      hasOverride = true;
    }
    if (fmt.borderTopColor && !override.borderTopColor) {
      override.borderTopColor = fmt.borderTopColor;
      override.borderTopStyle = fmt.borderTopStyle || "solid";
      hasOverride = true;
    }
    if (fmt.borderBottomColor && !override.borderBottomColor) {
      override.borderBottomColor = fmt.borderBottomColor;
      override.borderBottomStyle = fmt.borderBottomStyle || "solid";
      hasOverride = true;
    }
    if (fmt.borderLeftColor && !override.borderLeftColor) {
      override.borderLeftColor = fmt.borderLeftColor;
      override.borderLeftStyle = fmt.borderLeftStyle || "solid";
      hasOverride = true;
    }
    if (fmt.borderRightColor && !override.borderRightColor) {
      override.borderRightColor = fmt.borderRightColor;
      override.borderRightStyle = fmt.borderRightStyle || "solid";
      hasOverride = true;
    }
  }

  return hasOverride ? override : null;
}
