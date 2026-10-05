//! FILENAME: app/extensions/BuiltIn/HomeTab/components/styles/FormatAsTableButton.tsx
// PURPOSE: Home > Styles > Format as Table (CONTRACT 3.9): Excel's large
//          "Format as / Table v" button, opening the Tables extension's
//          table-style gallery.
// CONTEXT: Rendered for the catalog item "formatAsTable". The gallery is the
//          customContent of Format > Format as Table, registered by the Tables
//          extension (Table/handlers/formatAsTable.ts); an item with ONLY
//          customContent is opened by the kit as a card whose whole body is
//          that gallery (RegisteredStylesHero -> RegisteredMenuButton). The
//          gallery itself runs `table.formatAsTable { styleId }`
//          (ExtensionCommands.FORMAT_AS_TABLE) on a pick -- restyling the
//          table under the active cell, or opening Create Table in the style --
//          so the Home tab never names a table style or runs the command
//          itself, and the Format menu and the ribbon run the same code.
//
//          Greyed, with a reason as its tooltip, while the Tables extension is
//          not running, while the Format menu is not loaded, or while the
//          Tables extension has hidden or disabled its item.

import React from "react";
import { RibbonIcon } from "@api";
import type { HomeItemProps } from "../homeItemProps";
import { RegisteredStylesHero, type RegisteredHeroUnavailableText } from "./RegisteredStylesHero";

/** The registered menu-bar menu that hosts the gallery. */
export const FORMAT_AS_TABLE_MENU_ID = "format";

/** The Tables extension's item in it (FORMAT_AS_TABLE_MENU_ITEM_ID there). */
export const FORMAT_AS_TABLE_MENU_ITEM_ID = "format:formatAsTable";

/** Why the button is greyed, as its tooltip says it. "Tables" is the
 *  extension's own name (Table/manifest.ts), the one the Extensions list shows. */
export const FORMAT_AS_TABLE_UNAVAILABLE: Readonly<RegisteredHeroUnavailableText> = {
  noItem: "Format as Table isn't available: the Tables extension isn't running.",
  noMenu: "Format as Table isn't available: the Format menu it lives in isn't loaded.",
  off: "Format as Table isn't available right now.",
};

export function FormatAsTableButton({ item, band }: HomeItemProps): React.ReactElement {
  return (
    <RegisteredStylesHero
      item={item}
      band={band}
      menuId={FORMAT_AS_TABLE_MENU_ID}
      registeredItemId={FORMAT_AS_TABLE_MENU_ITEM_ID}
      picture={RibbonIcon.FormatAsTable}
      unavailable={FORMAT_AS_TABLE_UNAVAILABLE}
    />
  );
}
