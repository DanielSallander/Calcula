//! FILENAME: app/extensions/ConditionalFormatting/rendering/conditionalFormatPainter.ts
// PURPOSE: The data-bar and icon-set painter this extension registers with
//          `@api/conditionalFormatPaint`, so an object that shows cells of its own
//          (a floating grid) paints conditional-format glyphs without importing
//          this extension (Seam Rule).
// CONTEXT: Colour scales, fills, fonts and borders are NOT painted here: they are
//          styles, folded by `conditionalResultsToOverride` and painted by
//          `paintStyledCellBox` (`@api/cellPaint`).
//
// THE RULES ARE THE CALLER'S. A data bar's colour comes from the rule in the
// `rules` ARGUMENT whose id equals the result's `ruleId` -- the backing sheet's
// rules. This painter never calls `getRules()`: that store holds the ACTIVE
// sheet's rules, and would hand a floating grid's bar the default blue (or
// another sheet's colour whose rule id happens to match).

import type { ConditionalFormatPainter } from "@api/conditionalFormatPaint";
import { paintDataBar, findDataBarRule } from "./dataBarRenderer";
import { paintIconSetIcon } from "./iconSetRenderer";

export const conditionalFormatGlyphPainter: ConditionalFormatPainter = {
  paint(ctx, box, results, rules) {
    // Data bar first, icon on top: the order the grid overlays paint in
    // (cf-data-bar priority 5, cf-icon-set priority 6).
    const bar = results.find((cf) => cf.dataBarPercent != null);
    if (bar && bar.dataBarPercent != null) {
      paintDataBar(ctx, box, bar.dataBarPercent, findDataBarRule(rules, bar.ruleId));
    }
    // The set and the index arrive together from the rule that produced them
    // (BUG-0107); an index without a set is skipped, never guessed at.
    const icon = results.find((cf) => cf.iconIndex != null && cf.iconSet != null);
    if (icon && icon.iconIndex != null && icon.iconSet != null) {
      paintIconSetIcon(ctx, box, icon.iconSet, icon.iconIndex);
    }
  },
};
