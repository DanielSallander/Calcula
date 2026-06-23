//! FILENAME: app/src/core/theme/builtInSkins.ts
// PURPOSE: The built-in Light and Dark skins. Registered by initSkinLoader at
//          boot (in Core, NOT in an extension) so they exist before first paint.
// CONTEXT: Core/pure. Built-ins carry empty deltas — the values live in the
//          light/dark baselines (defaultTheme.ts / darkTheme.ts and grid themes).

import type { Skin } from "./skin";

export const LIGHT_SKIN_ID = "calcula.light";
export const DARK_SKIN_ID = "calcula.dark";

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

export const BUILTIN_SKINS: readonly Skin[] = [lightSkin, darkSkin];
