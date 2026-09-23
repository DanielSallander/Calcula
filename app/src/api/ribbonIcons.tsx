//! FILENAME: app/src/api/ribbonIcons.tsx
// PURPOSE: The ONE icon namespace every ribbon, rail, sidebar, menu and add-in
//          token resolves against: `RibbonIcon.<Key>`.
// CONTEXT: The drawings live in ./icons (one duotone set on a 24-unit grid:
//          SOFT ground, STRONG subject, one ACCENT; see ./icons/frame.tsx).
//          This file only AGGREGATES the four groups into one object, which is
//          a contract with three kinds of caller that must keep working:
//
//          - homeTabIcons.tsx maps persisted Home-tab item ids onto keys, and
//            GROUP_ICON_IDS offers them in the customize dialog;
//          - AddInsRibbonSection resolves a sandboxed add-in's icon TOKEN as
//            `keyof typeof RibbonIcon`, so a key that disappears silently
//            turns an installed add-in's button into the fallback glyph;
//          - the HomeTab tests mock the whole namespace with a Proxy.
//
//          So KEYS ONLY GROW. The 34 historical keys (Cut ... ClearAll) are
//          frozen: they may be redrawn, never renamed or removed. It stays one
//          namespace object, rather than 170 named exports, so the names can
//          never collide with menuIcons' `Icon*` exports or with each other.
//          A key that appears in two groups would silently resolve to the
//          later group's drawing; ribbonIcons.test.tsx fails if that happens.

import { HOME_ICONS } from "./icons/home";
import { CHART_ICONS } from "./icons/chart";
import { DATA_ICONS } from "./icons/data";
import { GENERIC_ICONS } from "./icons/generic";

export type { RibbonIconProps } from "./icons/frame";

export const RibbonIcon = {
  ...HOME_ICONS,
  ...CHART_ICONS,
  ...DATA_ICONS,
  ...GENERIC_ICONS,
} as const;

/** Every key the namespace resolves: the add-in icon-token vocabulary. */
export type RibbonIconKey = keyof typeof RibbonIcon;
