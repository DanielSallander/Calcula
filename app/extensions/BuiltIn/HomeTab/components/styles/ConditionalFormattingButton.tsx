//! FILENAME: app/extensions/BuiltIn/HomeTab/components/styles/ConditionalFormattingButton.tsx
// PURPOSE: Home > Styles > Conditional Formatting (CONTRACT 3.8): Excel's large
//          "Conditional / Formatting v" button, opening the Conditional
//          Formatting extension's own tree.
// CONTEXT: Rendered for the catalog item "conditionalFormatting". The tree --
//          Highlight Cells Rules >, Top/Bottom Rules >, Data Bars >, Color
//          Scales >, Icon Sets >, New Rule..., Clear Rules >, Manage Rules...,
//          galleries included -- is the one the CF extension registers as
//          Format > Conditional Formatting (homeMenuBuilder.ts), hosted here
//          through the kit's registered-menu seam (RegisteredStylesHero), so
//          the Format menu and the ribbon can never show two different trees.
//          Its rows' test ids are the registered ids (`cf:greaterThan`...),
//          the one identity both doors share.
//
//          Greyed, with a reason as its tooltip, while the CF extension is not
//          running, while the Format menu that hosts its item is not loaded,
//          or while CF has hidden or disabled it.

import React from "react";
import { RibbonIcon } from "@api";
import type { HomeItemProps } from "../homeItemProps";
import { RegisteredStylesHero, type RegisteredHeroUnavailableText } from "./RegisteredStylesHero";

/** The registered menu-bar menu that hosts the CF tree. */
export const CONDITIONAL_FORMATTING_MENU_ID = "format";

/** The CF extension's item in it (homeMenuBuilder.ts registers this id). */
export const CONDITIONAL_FORMATTING_MENU_ITEM_ID = "format:conditionalFormatting";

/** Why the button is greyed, as its tooltip says it. */
export const CONDITIONAL_FORMATTING_UNAVAILABLE: Readonly<RegisteredHeroUnavailableText> = {
  noItem: "Conditional Formatting isn't available: the Conditional Formatting extension isn't running.",
  noMenu: "Conditional Formatting isn't available: the Format menu it lives in isn't loaded.",
  off: "Conditional Formatting isn't available right now.",
};

export function ConditionalFormattingButton({ item, band }: HomeItemProps): React.ReactElement {
  return (
    <RegisteredStylesHero
      item={item}
      band={band}
      menuId={CONDITIONAL_FORMATTING_MENU_ID}
      registeredItemId={CONDITIONAL_FORMATTING_MENU_ITEM_ID}
      picture={RibbonIcon.ConditionalFormatting}
      unavailable={CONDITIONAL_FORMATTING_UNAVAILABLE}
    />
  );
}
