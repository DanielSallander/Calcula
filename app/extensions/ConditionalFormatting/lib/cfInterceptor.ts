//! FILENAME: app/extensions/ConditionalFormatting/lib/cfInterceptor.ts
// PURPOSE: Style interceptor for conditional formatting.
// CONTEXT: Registered with the style interceptor pipeline to dynamically
//          override cell styles at render time based on evaluation results.
//
// PRECEDENCE: Conditional Formatting overrides Computed Properties.
//   Computed Properties modify the cell's base styleIndex, which feeds into the
//   rendering pipeline as the "base style". This interceptor runs AFTER base
//   styles are resolved, so any properties returned here will override values
//   set by Computed Properties (backgroundColor, textColor, bold, italic, etc.).
//
// ONE FOLD. Which result wins for each property (first match, colour scale
// before a rule fill) is decided by `conditionalResultsToOverride` in
// `@api/conditionalFormatPaint`, which a floating grid uses for ITS cells too.
// A second copy here would drift from it on the first property added.

import type { IStyleOverride, CellCoords } from "@api/styleInterceptors";
import { conditionalResultsToOverride } from "@api/conditionalFormatPaint";
import { getEvaluationForCell } from "./cfStore";

/**
 * Style interceptor for conditional formatting.
 * Called during render for each visible cell. Looks up cached evaluation
 * results and returns style overrides.
 */
export function conditionalFormattingInterceptor(
  _cellValue: string,
  _baseStyle: { styleIndex: number },
  coords: CellCoords
): IStyleOverride | null {
  return conditionalResultsToOverride(getEvaluationForCell(coords.row, coords.col));
}
