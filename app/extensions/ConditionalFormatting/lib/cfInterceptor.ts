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

import type { IStyleOverride, CellCoords } from "../../../src/api/styleInterceptors";
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
  const results = getEvaluationForCell(coords.row, coords.col);
  if (!results || results.length === 0) {
    return null;
  }

  const override: IStyleOverride = {};
  let hasOverride = false;

  for (const cf of results) {
    // Color scale background takes priority
    if (cf.colorScaleColor && !override.backgroundColor) {
      override.backgroundColor = cf.colorScaleColor;
      hasOverride = true;
    }

    // Apply format overrides (first match wins for each property)
    const fmt = cf.format;
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
  }

  return hasOverride ? override : null;
}
