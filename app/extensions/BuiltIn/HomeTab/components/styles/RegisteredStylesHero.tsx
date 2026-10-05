//! FILENAME: app/extensions/BuiltIn/HomeTab/components/styles/RegisteredStylesHero.tsx
// PURPOSE: The Styles group's large hero over a subtree ANOTHER extension
//          registered in the menu bar -- the shared body of the Conditional
//          Formatting and Format as Table buttons (CONTRACT 3.8 / 3.9).
// CONTEXT: Excel's Home > Styles is three large buttons: "Conditional /
//          Formatting v", "Format as / Table v", "Cell / Styles v". The first
//          two open trees the Home tab does not own: Conditional Formatting is
//          the CF extension's (Format > Conditional Formatting, galleries and
//          all), Format as Table is the Tables extension's (Format > Format as
//          Table, whose customContent is the table-style gallery). The Home tab
//          may import neither (the Facade and Seam rules), and a copied tree is
//          a second source of truth that drifts on the owner's first change. So
//          this NAMES the item it wants (menu id + item id) and the kit's
//          RegisteredMenuButton draws whatever the owner registered there,
//          live: a menu for children, a card for customContent alone. The
//          Format menu and the ribbon show ONE tree.
//
//          GREYED, WITH A REASON. While nothing usable is registered there the
//          kit draws the trigger aria-disabled -- never natively disabled,
//          because a natively disabled button cannot show the tooltip that
//          says why. This file supplies that "why", and it distinguishes the
//          three cases a user could act on differently:
//            - the owning extension is not running (nothing at that id);
//            - the menu that hosts the item is not loaded at all (blaming the
//              owner then would be a false statement: it may well be running,
//              with nowhere to put its item);
//            - the owner registered it but hid it, disabled it, or gave it
//              nothing to open or run.
//          `registeredHeroUnavailable` mirrors the kit's own enabled/disabled
//          rule (MenuTree.tsx: missing/hidden/disabled -> disabled; visible
//          rows -> menu; customContent -> card; action/commandId -> run; else
//          disabled). The two are computed side by side from the same item, so
//          a drift between them would show a greyed button with no reason, or
//          a live one that says it is unavailable; a test drives every
//          registration shape through BOTH and requires them to agree.
//
//          BAND AND PANEL. In the band this is Excel's large button with the
//          label over two lines and the chevron after the last word
//          (CommandButton labelLines 2; HERO_ICON_SIZE picture). Outside the
//          band (sidebar, a collapsed group's launcher flyout) CommandButton is
//          a standard 28px control with the 20px picture and labelLines does
//          nothing.

import React from "react";
import type { RibbonIconProps } from "@api";
import { getMenus, type MenuItemDefinition } from "@api/ui";
import {
  CommandButton,
  RegisteredMenuButton,
  useRegisteredMenuItem,
  HERO_ICON_SIZE,
  ICON_SIZE_SM,
} from "@api/layout";
import type { HomeTabItem } from "../../homeTabConfig";
import { homeTabIcon } from "../homeTabIcons";
import { itemTooltip } from "../itemTooltip";

/** Why a registered hero is greyed. */
export type RegisteredHeroUnavailable = "noMenu" | "noItem" | "off";

/** The words for each reason, as the tooltip says them. */
export interface RegisteredHeroUnavailableText {
  /** Nothing is registered at the item's id: its extension is not running. */
  noItem: string;
  /** The menu that would host the item is not registered at all. */
  noMenu: string;
  /** Registered, but hidden, disabled, or with nothing to open or run. */
  off: string;
}

/** Whether a registered item draws at least one row (separators alone do not). */
function hasVisibleRows(item: MenuItemDefinition): boolean {
  return (item.children ?? []).some((child) => !child.hidden && !child.separator);
}

/**
 * Why the hero over `item` is unavailable, or null when the kit will open or
 * run it. `menuPresent` is whether the host menu is registered (it can only
 * matter when `item` is null: an item is only ever found inside its menu).
 * Mirrors RegisteredMenuButton's own decision -- see the header.
 */
export function registeredHeroUnavailable(
  item: MenuItemDefinition | null,
  menuPresent: boolean,
): RegisteredHeroUnavailable | null {
  if (!item) return menuPresent ? "noItem" : "noMenu";
  if (item.hidden || item.disabled) return "off";
  if (hasVisibleRows(item) || item.customContent || item.action || item.commandId) return null;
  return "off";
}

export interface RegisteredStylesHeroProps {
  /** The Home catalog entry; its id is the control's `fmt-<id>` test id. */
  item: HomeTabItem;
  /** True in the ribbon band (the hero picture), false elsewhere. */
  band: boolean;
  /** The registered menu-bar menu that hosts the item ("format"). */
  menuId: string;
  /** The registered item the hero opens ("format:conditionalFormatting"). */
  registeredItemId: string;
  /** The face picture, used when the Home icon map has none for `item.id`. */
  picture: React.ComponentType<RibbonIconProps>;
  /** The tooltip for each reason the hero can be greyed. */
  unavailable: RegisteredHeroUnavailableText;
}

export function RegisteredStylesHero({
  item,
  band,
  menuId,
  registeredItemId,
  picture,
  unavailable,
}: RegisteredStylesHeroProps): React.ReactElement {
  // Re-renders on every registry notification (registration, in-place patch,
  // take-back), so the reason below is as live as the kit's own decision.
  const registered = useRegisteredMenuItem(menuId, registeredItemId);
  const menuPresent = registered !== null || getMenus().some((menu) => menu.id === menuId);
  const why = registeredHeroUnavailable(registered, menuPresent);
  const reason = why === null ? null : unavailable[why];

  const tip = itemTooltip(item);
  // The Home icon map decides the picture when it has one for this id (the
  // Customize Home Tab palette shows the same one); the component's own
  // picture stands in until it does.
  const size = band ? HERO_ICON_SIZE : ICON_SIZE_SM;
  const Picture = picture;
  const icon = homeTabIcon(item.id, size) ?? <Picture size={size} />;

  return (
    <RegisteredMenuButton
      menuId={menuId}
      itemId={registeredItemId}
      trigger={
        <CommandButton
          icon={icon}
          label={item.shortLabel ?? item.label}
          chevron
          labelLines={2}
          // While greyed the tooltip is the reason alone: a shortcut chip
          // would advertise a key for a command that cannot run.
          tooltip={reason ?? tip.tooltip}
          shortcut={reason ? undefined : tip.shortcut}
          commandId={reason ? undefined : tip.commandId}
          data-testid={`fmt-${item.id}`}
        />
      }
    />
  );
}
