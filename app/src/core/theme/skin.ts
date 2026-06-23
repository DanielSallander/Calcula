//! FILENAME: app/src/core/theme/skin.ts
// PURPOSE: Data model for an App Skin (application appearance/chrome + grid).
// CONTEXT: Core/pure. A Skin is a partial delta layered over a light/dark baseline.
//          This is DISTINCT from the Office-style "Document Theme" (api/theme.ts)
//          that colors cell *content*. Never conflate the two.

import type { THEME_TOKENS } from "./tokens";
import type { GridTheme } from "../lib/gridRenderer/types";

/** A CSS-variable token name, e.g. '--grid-bg'. */
export type ThemeTokenName = (typeof THEME_TOKENS)[keyof typeof THEME_TOKENS];

/** The baseline a skin's deltas are layered over. */
export type SkinBase = "light" | "dark";

/** UI density preset. */
export type SkinDensity = "comfortable" | "compact";

/** Optional branding assets a skin (especially a corporate skin) may carry. */
export interface SkinAssets {
  /** Logo shown in the menu-bar corner / About screen. data-URL or local path. */
  logo?: string;
  /** App/window icon. data-URL or local path. */
  icon?: string;
}

/**
 * User-controlled accessibility override. Applied as transforms ON TOP of the
 * active skin and ALWAYS honored — no policy can suppress it. Sourced from the
 * user's toggles and/or OS preferences (prefers-contrast, prefers-reduced-motion).
 */
export interface AccessibilityOverride {
  /** Force a light/dark base regardless of the chosen skin. */
  forcedBase?: SkinBase | null;
  /** Boost text/border contrast for legibility. */
  highContrast?: boolean;
  /** Minimum multiplier (>= 1.0) on the cell font size. */
  minFontScale?: number;
  /** Disable skin transition animations. */
  reducedMotion?: boolean;
}

/**
 * An App Skin: a partial set of overrides layered over a light or dark baseline.
 * Authors specify only what differs from the baseline, so a skin is small.
 */
export interface Skin {
  /** Stable id, e.g. 'calcula.light', 'acme.brand'. */
  id: string;
  /** User-facing display name. */
  name: string;
  /** Which baseline the deltas layer over. */
  base: SkinBase;
  /** CSS-variable token overrides (delta only). */
  tokens?: Partial<Record<ThemeTokenName, string>>;
  /** Canvas grid color overrides (delta only). */
  grid?: Partial<GridTheme>;
  /** Density preset; maps to the cell font-size token + grid cellFontSize. */
  density?: SkinDensity;
  /** UI font family; maps to FONT_FAMILY_SANS + grid cellFontFamily. */
  fontFamily?: string;
  /** Optional branding assets. */
  assets?: SkinAssets;
  /** True for the built-in Light/Dark skins; blocks deletion in the UI. */
  builtIn?: boolean;
}
