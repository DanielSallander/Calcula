//! FILENAME: app/src/api/appearance.ts
// PURPOSE: Public API facade for the App Appearance / Skin system. Thin wrapper
//          over the Core skinLoader, plus the AppEvents bridge for extensions.
// CONTEXT: This is the ONLY surface extensions touch to read/set/contribute
//          skins. DISTINCT from api/theme.ts (Office-style Document Theme).

import * as skinLoader from "../core/theme/skinLoader";
import type { Skin } from "../core/theme/skin";
import { AppEvents, emitAppEvent, onAppEvent } from "./events";

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
  BUILTIN_DEFAULT_SKIN_ID,
} from "../core/theme/builtInSkins";

/** Payload emitted with AppEvents.APPEARANCE_CHANGED. */
export interface AppearanceChangedPayload {
  skinId: string;
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

/** Subscribe to appearance changes. Returns a cleanup function. */
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
