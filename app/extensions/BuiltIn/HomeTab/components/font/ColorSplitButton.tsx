//! FILENAME: app/extensions/BuiltIn/HomeTab/components/font/ColorSplitButton.tsx
// PURPOSE: Excel's Fill Color and Font Color split buttons for the Home tab's
//          Font group (CONTRACT 3.5): the face applies the colour on its bar --
//          the LAST colour applied from that button -- and the chevron opens
//          the palette (Theme Colors, Standard Colors, More Colors..., with
//          "No Fill" / "Automatic", and Fill's "More Fill Options...").
// CONTEXT: Rendered for the catalog items "backgroundColor" (Fill Color) and
//          "textColor" (Font Color) (HomeItemProps; the dispatcher in
//          HomeTabGroupComponent looks them up by id -- today it routes every
//          `type: "color"` item to its renderColor). Built on @api/layout's
//          ColorSwatch in its `split` form (CONTRACT 6.7), so the halves, the
//          keyboard and the palette are the kit's. What a choice writes and
//          why the bar is a memory rather than the cell's colour is
//          colorChoice.ts.
//
//          WHERE THE ROWS SIT, measured in live Excel 365 (kit-color lane,
//          2026-10-04): Font Color's "Automatic" is FIRST, above the theme
//          grid; Fill Color's "No Fill" comes AFTER the Standard Colors, above
//          More Colors.... Excel's Fill menu has no "More Fill Options..." row;
//          CONTRACT 3.5 keeps it (Format Cells' Fill tab: patterns and
//          gradients the palette cannot pick), so it stays, last.
//
//          Same control in the band and in a panel (Excel's are small splits
//          in the band too), so `band` changes nothing here.

import React, { useEffect } from "react";
import { RibbonIcon } from "@api";
import { CoreCommands } from "@api/commands";
import { AppEvents, onAppEvent } from "@api/events";
import { ColorSwatch, ICON_SIZE_SM } from "@api/layout";
import { getThemeColorPalette } from "@api/theme";
import type { HomeItemProps } from "../homeItemProps";
import { itemTooltip } from "../itemTooltip";
import {
  COLOR_ACTION,
  MORE_FILL_OPTIONS,
  applyRememberedColor,
  barColor,
  chooseColor,
  colorChoiceStore,
  isColorItemId,
  refreshThemeChoices,
  type ColorItemId,
} from "./colorChoice";
import { runCommand } from "../runCommand";
import { useSessionValue } from "./sessionStore";

/**
 * Keep a remembered THEME colour's bar on the document's current theme
 * (BUG-0370): re-resolve it on mount, when the document theme changes, and when
 * another document opens or a new one starts (each may bring its own theme).
 * @api/theme drops its per-document palette cache on those same events, before
 * any consumer hears them, so the re-read here is always the new document's.
 * Every copy of the button runs this; the refresh is idempotent.
 */
function useThemeChoiceRefresh(): void {
  useEffect(() => {
    let live = true;
    const refresh = (): void => {
      getThemeColorPalette()
        .then((palette) => {
          if (live && Array.isArray(palette)) refreshThemeChoices(palette);
        })
        .catch(() => {
          // No palette (no backend): the remembered hex stays, as before.
        });
    };
    refresh();
    const offs = [
      onAppEvent(AppEvents.THEME_CHANGED, refresh),
      onAppEvent(AppEvents.AFTER_OPEN, refresh),
      onAppEvent(AppEvents.AFTER_NEW, refresh),
    ];
    return () => {
      live = false;
      for (const off of offs) off();
    };
  }, []);
}

/**
 * Excel's Fill Color / Font Color split button. No pressed state: the bar is
 * colour DATA, not a toggle.
 */
export function ColorSplitButton({ item, state }: HomeItemProps): React.ReactElement {
  useThemeChoiceRefresh();
  // Any other id is a dispatcher mistake; render it as Font Color rather than
  // throw inside the ribbon.
  const itemId: ColorItemId = isColorItemId(item.id) ? item.id : "textColor";
  const fill = itemId === "backgroundColor";
  const store = colorChoiceStore(itemId);
  const choice = useSessionValue(store);
  const tip = itemTooltip(item);
  const label = item.tooltip ?? COLOR_ACTION[itemId];
  const Icon = fill ? RibbonIcon.FillColor : RibbonIcon.FontColor;

  return (
    <ColorSwatch
      split
      variant="bar"
      icon={<Icon size={ICON_SIZE_SM} />}
      label={label}
      tooltip={tip.tooltip ?? label}
      testId={`fmt-${item.id}`}
      chevronTestId={`fmt-${item.id}-options`}
      color={barColor(itemId, choice)}
      // Rings the remembered swatch in the theme grid, slot and tint exact.
      themeSlot={choice.kind === "theme" ? choice.slot : undefined}
      themeTint={choice.kind === "theme" ? choice.tint : undefined}
      onApply={() => void applyRememberedColor(state, itemId)}
      onChange={(hex) => void chooseColor(state, itemId, { kind: "hex", hex })}
      onThemeColorChange={(slot, tint, hex) => void chooseColor(state, itemId, { kind: "theme", slot, tint, hex })}
      allowAutomatic
      onAutomatic={() => void chooseColor(state, itemId, { kind: "automatic" })}
      automaticLabel={fill ? "No Fill" : "Automatic"}
      automaticChip={fill ? "none" : "text"}
      automaticPlacement={fill ? "afterColors" : "first"}
      moreAction={
        fill
          ? {
              label: MORE_FILL_OPTIONS.label,
              testId: `fmt-${item.id}-${MORE_FILL_OPTIONS.slug}`,
              onSelect: () => void runCommand(CoreCommands.FORMAT_CELLS, { tab: "fill" }),
            }
          : undefined
      }
    />
  );
}
