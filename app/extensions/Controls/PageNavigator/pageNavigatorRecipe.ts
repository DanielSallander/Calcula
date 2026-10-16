//! FILENAME: app/extensions/Controls/PageNavigator/pageNavigatorRecipe.ts
// PURPOSE: THE defaults table of a Page Navigator and THE recipe a new one is
//          written with (WP-B, D-NAV).
// CONTEXT: A copied recipe is a second source of truth that drifts on the
//          owner's first default change (CLAUDE.md, the Seam Rule). So every
//          place that needs a navigator default reads it HERE:
//            - `pageNavigatorRecipe` (what createPageNavigator writes),
//            - `readPageNavigatorProps` (navigatorModel.ts: what an absent or
//              malformed stored value falls back to),
//            - `PAGE_NAVIGATOR_PROPERTIES` (pageNavigatorProperties.ts: each
//              Properties row's `defaultValue`).
//          A test (pageNavigatorRecipe.test.ts) asserts the three agree.
//
//          The SIZE is not here: it is the seam's (`PAGE_NAVIGATOR_NATURAL_ITEM`,
//          `pageNavigatorNaturalSize`, `PAGE_NAVIGATOR_DEFAULT_SIZE` in
//          @api/buttonControlService), because the canvas insert needs it too
//          and must not reach into this extension.
//
//          A NAVIGATOR HAS NO CODE SLOT AND NO TARGET. No `onSelect`, no
//          `macroRef`, no `action*` keys, no `text`, no `tooltip`: which page an
//          item opens is structural (one item per page, derived live from
//          @api/reportPages), so nothing stored can re-aim a reader's click.

import {
  PAGE_NAVIGATOR_NATURAL_ITEM,
  PAGE_NAVIGATOR_OVERRIDES_PROPERTY,
  type PageNavigatorOrientation,
} from "@api/buttonControlService";

/**
 * THE defaults table: every navigator property (all twelve, every value the
 * stored STRING form). `gap` is the seam's natural gap, never re-typed.
 * `selectedFill` is `#c5c5c5` -- the default `#e0e0e0` face under the 12%
 * pressed wash a navigate button uses today, so the current page looks the
 * way a current-page button already does.
 */
export const PAGE_NAVIGATOR_DEFAULTS = {
  orientation: "horizontal",
  gap: String(PAGE_NAVIGATOR_NATURAL_ITEM.gap),
  padding: "0",
  fill: "#e0e0e0",
  color: "#000000",
  borderColor: "#999999",
  fontSize: "11",
  selectedFill: "#c5c5c5",
  selectedColor: "#000000",
  showHiddenPages: "false",
  showTooltipPages: "false",
  [PAGE_NAVIGATOR_OVERRIDES_PROPERTY]: "[]",
} as const satisfies Readonly<Record<string, string>>;

/** A key of the defaults table. */
export type PageNavigatorDefaultKey = keyof typeof PAGE_NAVIGATOR_DEFAULTS;

/**
 * The properties a new navigator is written with: all 18 keys, every value a
 * string. The twelve navigator keys come from `PAGE_NAVIGATOR_DEFAULTS` (with
 * the requested orientation), x / y / width / height from `rect`, and the two
 * layout keys are written EXPLICITLY as the string "false": `embedded` because
 * a navigator floats, and `pinToGrid` because the backend defaults an ABSENT
 * pinToGrid to "moves with cells" (CLAUDE.md, the Seam Rule's invisible-button
 * lesson). Pure.
 */
export function pageNavigatorRecipe(
  rect: { x: number; y: number; width: number; height: number },
  orientation: PageNavigatorOrientation,
): Record<string, string> {
  return {
    ...PAGE_NAVIGATOR_DEFAULTS,
    orientation,
    embedded: "false",
    pinToGrid: "false",
    x: String(rect.x),
    y: String(rect.y),
    width: String(rect.width),
    height: String(rect.height),
  };
}
