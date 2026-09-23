//! FILENAME: app/src/core/theme/builtInSkins.ts
// PURPOSE: The skins Calcula ships: Light, Dark, Calcula Soft and Calcula
//          Contrast. Registered by initSkinLoader at boot (in Core, NOT in an
//          extension) so they exist before first paint.
// CONTEXT: Core/pure. Light and Dark carry EMPTY deltas — their values ARE the
//          light/dark baselines (defaultTheme.ts / darkTheme.ts and the grid
//          themes). Soft and Contrast are the opposite case on purpose: each is
//          nothing but a small token delta over the light baseline, which is
//          the proof that the Clusters chrome is fully token-driven. If either
//          of them ever needs a line of component code to look right, the
//          component is painting with something that is not a token.

import type { Skin } from "./skin";
import { THEME_TOKENS } from "./tokens";

export const LIGHT_SKIN_ID = "calcula.light";
export const DARK_SKIN_ID = "calcula.dark";
export const SOFT_SKIN_ID = "calcula.soft";
export const CONTRAST_SKIN_ID = "calcula.contrast";

/** The factory default skin id when nothing is persisted and no policy applies. */
export const BUILTIN_DEFAULT_SKIN_ID = LIGHT_SKIN_ID;

export const lightSkin: Skin = {
  id: LIGHT_SKIN_ID,
  name: "Light",
  base: "light",
  builtIn: true,
};

export const darkSkin: Skin = {
  id: DARK_SKIN_ID,
  name: "Dark",
  base: "dark",
  builtIn: true,
};

/**
 * Calcula Soft — rounder shapes, an indigo state colour and cool-tinted ribbon
 * surfaces. EXACTLY the `[data-skin="soft"]` block of the approved mockup's
 * calcula.css, token for token, so the skin the owner reviewed is the skin
 * that ships.
 *
 * It deliberately does NOT restate the group-label colour: it inherits the
 * light baseline's, which was darkened one step precisely so it also clears
 * 4.5:1 on this skin's cluster card (skinLoader.test.ts measures that on the
 * MERGED tokens, which is where an inherited value would slip through).
 */
export const softSkin: Skin = {
  id: SOFT_SKIN_ID,
  name: "Calcula Soft",
  base: "light",
  builtIn: true,
  tokens: {
    [THEME_TOKENS.RADIUS_CONTROL]: "10px",
    [THEME_TOKENS.RADIUS_CLUSTER]: "16px",
    [THEME_TOKENS.RADIUS_POPOVER]: "16px",
    [THEME_TOKENS.ACCENT_PRIMARY]: "#6366f1",
    [THEME_TOKENS.STATE_ACCENT]: "#4f46e5",
    [THEME_TOKENS.RIBBON_FRAME_BG]: "#f7f8fc",
    [THEME_TOKENS.RIBBON_CLUSTER_BG]: "#eef0f7",
    [THEME_TOKENS.RIBBON_CLUSTER_BORDER]: "#e2e5f0",
    [THEME_TOKENS.RIBBON_CLUSTER_BORDER_HOVER]: "#cdd2e6",
    [THEME_TOKENS.ACTIVITY_BAR_BG]: "#eef0f6",
    [THEME_TOKENS.ACTIVITY_BAR_ITEM_ACTIVE_BG]:
      "color-mix(in srgb, var(--state-accent) 12%, transparent)",
  },
};

/**
 * Calcula Contrast — a SKIN, not the accessibility transform. Square-ish
 * corners, black control edges, white cards and a deep state green.
 *
 * Why both exist: the High contrast toggle in Settings > Appearance is an
 * accessibility OVERRIDE — it is applied on top of whatever skin is active,
 * no policy can suppress it, and it is deliberately blunt (black text, black
 * grid lines). This skin is a look someone may simply prefer: crisp edges on
 * the chrome while the grid keeps its ordinary light palette. The two compose;
 * turning the toggle on over this skin still wins, because accessibility is
 * always applied last.
 */
export const contrastSkin: Skin = {
  id: CONTRAST_SKIN_ID,
  name: "Calcula Contrast",
  base: "light",
  builtIn: true,
  tokens: {
    [THEME_TOKENS.RADIUS_CONTROL]: "2px",
    [THEME_TOKENS.RADIUS_CLUSTER]: "2px",
    [THEME_TOKENS.RADIUS_POPOVER]: "2px",
    [THEME_TOKENS.RIBBON_CLUSTER_BG]: "#ffffff",
    [THEME_TOKENS.RIBBON_CLUSTER_BORDER]: "#000000",
    [THEME_TOKENS.RIBBON_CLUSTER_BORDER_HOVER]: "#000000",
    [THEME_TOKENS.CONTROL_BORDER]: "#000000",
    [THEME_TOKENS.CONTROL_DIVIDER]: "#000000",
    [THEME_TOKENS.RIBBON_GROUP_LABEL_FG]: "#1f2937",
    [THEME_TOKENS.ICON_FILL_SOFT]: "#7a7a7a",
    [THEME_TOKENS.STATE_ACCENT]: "#00543a",
    [THEME_TOKENS.RIBBON_FRAME_BG]: "#ffffff",
  },
};

/**
 * Registration order is display order in Settings > Appearance: the two
 * baselines first (they are what every other skin is described relative to),
 * then the two delta skins.
 */
export const BUILTIN_SKINS: readonly Skin[] = [lightSkin, darkSkin, softSkin, contrastSkin];
