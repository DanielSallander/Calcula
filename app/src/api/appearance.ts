//! FILENAME: app/src/api/appearance.ts
// PURPOSE: Public API facade for the App Appearance / Skin system. Thin wrapper
//          over the Core skinLoader, plus the AppEvents bridge for extensions.
// CONTEXT: This is the ONLY surface extensions touch to read/set/contribute
//          skins. DISTINCT from api/theme.ts (Office-style Document Theme).

import * as skinLoader from "../core/theme/skinLoader";
import type { Skin } from "../core/theme/skin";
import type { RibbonLabelMode } from "../core/theme/skinLoader";
import { AppEvents, emitAppEvent, onAppEvent } from "./events";
import { THEME_TOKENS } from "../core/theme/tokens";
import { defaultTheme } from "../core/theme/defaultTheme";

export type {
  Skin,
  SkinBase,
  SkinDensity,
  SkinAssets,
  ThemeTokenName,
  AccessibilityOverride,
} from "../core/theme/skin";
export {
  LIGHT_SKIN_ID,
  DARK_SKIN_ID,
  SOFT_SKIN_ID,
  CONTRAST_SKIN_ID,
  BUILTIN_DEFAULT_SKIN_ID,
} from "../core/theme/builtInSkins";
export type { RibbonLabelMode } from "../core/theme/skinLoader";

/**
 * Payload emitted with AppEvents.APPEARANCE_CHANGED.
 *
 * `skinId` is always present (the active skin, even when it did not change),
 * so a listener that only cares about skins keeps working. The optional fields
 * say WHICH other preference moved, so a listener can ignore what it does not
 * render: `ribbonLabels` carries the new label mode, `userTokens` is `true`
 * when the user's token overrides were replaced.
 */
export interface AppearanceChangedPayload {
  skinId: string;
  ribbonLabels?: RibbonLabelMode;
  userTokens?: boolean;
}

/** All registered skins (built-ins + extension/org-contributed). */
export function listAvailableSkins(): Skin[] {
  return skinLoader.getRegisteredSkins();
}

/** The currently-active skin (falls back to Light if the active id is unknown). */
export function getActiveSkin(): Skin {
  return skinLoader.getActiveSkin();
}

/** The currently-active skin id (may name a not-yet-registered org/extension skin). */
export function getActiveSkinId(): string {
  return skinLoader.getActiveSkinId();
}

/**
 * Switch the active skin. Persists the choice, re-injects CSS variables, updates
 * the canvas GridTheme, and emits APPEARANCE_CHANGED for extensions. No-op for an
 * unknown id.
 */
export function setActiveSkin(id: string): void {
  skinLoader.setActiveSkin(id);
  emitAppEvent<AppearanceChangedPayload>(AppEvents.APPEARANCE_CHANGED, { skinId: id });
}

/**
 * Contribute a skin (dogfooding — built-in or third-party extensions call this in
 * their activate()). If the registered id is the active one, it re-applies.
 */
export function registerSkin(skin: Skin): void {
  skinLoader.registerSkin(skin);
}

/**
 * Whether the ribbon draws the caption under each group. "show" unless the
 * user chose "hide".
 */
export function getRibbonLabelMode(): RibbonLabelMode {
  return skinLoader.getRibbonLabelMode();
}

/**
 * Show or hide the ribbon group captions. `"show"` and `null` both return to
 * the factory state (the preference is removed, not stored). Stamps
 * `<html data-ribbon-labels>`, notifies appearance subscribers and emits
 * APPEARANCE_CHANGED with `{ skinId, ribbonLabels }`.
 */
export function setRibbonLabelMode(mode: RibbonLabelMode | null): void {
  skinLoader.setRibbonLabelMode(mode);
  emitAppEvent<AppearanceChangedPayload>(AppEvents.APPEARANCE_CHANGED, {
    skinId: skinLoader.getActiveSkinId(),
    ribbonLabels: skinLoader.getRibbonLabelMode(),
  });
}

/**
 * The user's own theme-token overrides, keyed by CSS name
 * (`{ "--state-accent": "#b91c1c" }`). Layered over the active skin and under
 * the accessibility transforms.
 */
export function getUserTokenOverrides(): Record<string, string> {
  return skinLoader.getUserTokenOverrides();
}

/**
 * REPLACE the user's token overrides and re-apply the active skin. Names that
 * are not declared theme tokens, and values that could break out of the
 * injected stylesheet, are dropped. `null` or `{}` clears them. Emits
 * APPEARANCE_CHANGED with `{ skinId, userTokens: true }`.
 */
export function setUserTokenOverrides(overrides: Record<string, string> | null): void {
  skinLoader.setUserTokenOverrides(overrides);
  emitAppEvent<AppearanceChangedPayload>(AppEvents.APPEARANCE_CHANGED, {
    skinId: skinLoader.getActiveSkinId(),
    userTokens: true,
  });
}

/**
 * Subscribe to appearance changes. Returns a cleanup function.
 *
 * Fires for EVERY APPEARANCE_CHANGED — including a ribbon-label or token-
 * override change, where the skin id it passes is unchanged. Re-reading the
 * skin on such a call is harmless; a caller that must distinguish should
 * listen to AppEvents.APPEARANCE_CHANGED and read the payload fields.
 */
export function onSkinChanged(cb: (skinId: string) => void): () => void {
  return onAppEvent<AppearanceChangedPayload>(AppEvents.APPEARANCE_CHANGED, (d) => cb(d.skinId));
}

/**
 * Subscribe directly to the loader (fires for ANY active-skin change, including
 * those not routed through setActiveSkin — e.g. late registerSkin re-apply).
 * Use for UI that must always reflect the active skin.
 */
export function subscribeToAppearance(cb: () => void): () => void {
  return skinLoader.subscribe(cb);
}

/** Merged token map for a skin — for building live-preview swatches. */
export function getSkinTokens(skin: Skin): Record<string, string> {
  return skinLoader.getMergedTokens(skin);
}

/** Merged GridTheme for a skin — for building live-preview swatches. */
export function getSkinGridTheme(skin: Skin) {
  return skinLoader.getMergedGridTheme(skin);
}

/**
 * The GridTheme the canvas is actually rendering with right now — includes
 * accessibility adjustments (high contrast, font scaling) on top of the
 * active skin. Use this (not getSkinGridTheme) to draw overlay chrome that
 * must match core-rendered gridlines and text.
 */
export function getActiveGridTheme() {
  return skinLoader.getActiveGridTheme();
}

// ============================================================================
// Semantic tones for CANVAS painters
// ============================================================================

/**
 * The semantic status colours (the `--tone-*` theme tokens) as concrete colour
 * strings, for code that paints on the grid canvas and therefore cannot use
 * `var(--tone-warn-fg)`. `*Fg` is the strong ink of a tone (a marker, an
 * outline); `*Bg` its quiet surface. Values follow the ACTIVE skin -- Dark
 * included -- with the user's token overrides and the accessibility transforms
 * applied, exactly as the chrome is painted. Re-read it inside each paint (it
 * is cached per skin apply, so the call is cheap); never keep a copy across
 * frames, or a skin switch leaves stale ink on the grid.
 */
export interface CanvasToneColors {
  warnFg: string;
  warnBg: string;
  dangerFg: string;
  dangerBg: string;
  infoFg: string;
  infoBg: string;
  okFg: string;
  okBg: string;
}

/** The light baseline, read only if a token is somehow absent from the active map. */
const baselineTone = (name: string): string => defaultTheme[name] ?? "";

let toneCacheSource: Readonly<Record<string, string>> | null = null;
let toneCache: CanvasToneColors | null = null;

export function getCanvasToneColors(): CanvasToneColors {
  const tokens = skinLoader.getActiveTokens();
  if (toneCache && tokens === toneCacheSource) return toneCache;
  const pick = (name: string): string => {
    const v = tokens[name];
    return typeof v === "string" && v.trim() !== "" ? v.trim() : baselineTone(name);
  };
  toneCache = Object.freeze({
    warnFg: pick(THEME_TOKENS.TONE_WARN_FG),
    warnBg: pick(THEME_TOKENS.TONE_WARN_BG),
    dangerFg: pick(THEME_TOKENS.TONE_DANGER_FG),
    dangerBg: pick(THEME_TOKENS.TONE_DANGER_BG),
    infoFg: pick(THEME_TOKENS.TONE_INFO_FG),
    infoBg: pick(THEME_TOKENS.TONE_INFO_BG),
    okFg: pick(THEME_TOKENS.TONE_OK_FG),
    okBg: pick(THEME_TOKENS.TONE_OK_BG),
  });
  toneCacheSource = tokens;
  return toneCache;
}
