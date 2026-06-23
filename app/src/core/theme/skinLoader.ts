//! FILENAME: app/src/core/theme/skinLoader.ts
// PURPOSE: Runtime theme loader for the App Skin system. Holds the active skin,
//          computes the merged token map + merged GridTheme, injects/updates the
//          :root CSS variables imperatively (live, no React remount), exposes the
//          active GridTheme to the canvas, and notifies subscribers on change.
// CONTEXT: Core/pure. Replaces ThemeRoot's static injection. Imports only Core
//          token/grid concepts — never shell/api/extensions. The API facade
//          (api/appearance.ts) bridges this to the AppEvents bus + extensions.

import { THEME_TOKENS } from "./tokens";
import { defaultTheme } from "./defaultTheme";
import { darkTheme } from "./darkTheme";
import { DEFAULT_THEME, type GridTheme } from "../lib/gridRenderer/types";
import { DARK_GRID_THEME } from "./darkGridTheme";
import { BUILTIN_SKINS, BUILTIN_DEFAULT_SKIN_ID, lightSkin } from "./builtInSkins";
import type { AccessibilityOverride, Skin, SkinBase, SkinDensity } from "./skin";

/** localStorage key for the user's chosen skin id (app-global, read at boot). */
export const SKIN_STORAGE_KEY = "calcula.appearance.skinId";
/** Id of the persistent <style> element holding the injected CSS variables. */
const STYLE_EL_ID = "calcula-skin-vars";

/** Cell font-size (px) per density preset. */
const DENSITY_FONT_SIZE: Record<SkinDensity, number> = {
  comfortable: 13,
  compact: 11,
};

const TOKEN_BASELINES: Record<SkinBase, Record<string, string>> = {
  light: defaultTheme,
  dark: darkTheme,
};

const GRID_BASELINES: Record<SkinBase, GridTheme> = {
  light: DEFAULT_THEME,
  dark: DARK_GRID_THEME,
};

// --- Module-singleton state ----------------------------------------------------

const registry = new Map<string, Skin>();
const subscribers = new Set<() => void>();
let activeSkinId = BUILTIN_DEFAULT_SKIN_ID;
let cachedGridTheme: GridTheme = DEFAULT_THEME;
let styleEl: HTMLStyleElement | null = null;
let initialized = false;
let a11y: AccessibilityOverride = {};

// --- Persistence (direct localStorage, app-global like calcula.locale) ---------

function readPersistedId(): string | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage.getItem(SKIN_STORAGE_KEY) : null;
  } catch {
    return null;
  }
}

function persistId(id: string): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(SKIN_STORAGE_KEY, id);
  } catch {
    /* storage unavailable — ignore */
  }
}

// --- Merge (pure) --------------------------------------------------------------

/** Compute the full merged token map for a skin: baseline -> tokens -> density/font. */
export function getMergedTokens(skin: Skin): Record<string, string> {
  const merged: Record<string, string> = { ...TOKEN_BASELINES[skin.base], ...(skin.tokens ?? {}) };
  if (skin.density) merged[THEME_TOKENS.FONT_SIZE_CELL] = `${DENSITY_FONT_SIZE[skin.density]}px`;
  if (skin.fontFamily) merged[THEME_TOKENS.FONT_FAMILY_SANS] = skin.fontFamily;
  return merged;
}

/** Compute the full merged GridTheme for a skin: baseline -> grid -> density/font. */
export function getMergedGridTheme(skin: Skin): GridTheme {
  const merged: GridTheme = { ...GRID_BASELINES[skin.base], ...(skin.grid ?? {}) };
  if (skin.fontFamily) merged.cellFontFamily = skin.fontFamily;
  if (skin.density) merged.cellFontSize = DENSITY_FONT_SIZE[skin.density];
  return merged;
}

// --- DOM injection (imperative, no remount) ------------------------------------

function ensureStyleEl(): HTMLStyleElement | null {
  if (typeof document === "undefined") return null;
  if (styleEl && styleEl.isConnected) return styleEl;
  let el = document.getElementById(STYLE_EL_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = STYLE_EL_ID;
    document.head.appendChild(el);
  }
  styleEl = el;
  return el;
}

function injectTokens(tokens: Record<string, string>): void {
  const el = ensureStyleEl();
  if (!el) return;
  const body = Object.entries(tokens)
    .map(([k, v]) => `${k}: ${v};`)
    .join(" ");
  el.textContent = `:root { ${body} }`;
}

// --- Accessibility transforms (always applied last; never suppressible) --------

/** High-contrast token/grid deltas per effective base. */
const HIGH_CONTRAST: Record<SkinBase, { tokens: Record<string, string>; grid: Partial<GridTheme> }> = {
  light: {
    tokens: {
      [THEME_TOKENS.TEXT_PRIMARY]: "#000000",
      [THEME_TOKENS.TEXT_SECONDARY]: "#1a1a1a",
      [THEME_TOKENS.GRID_TEXT]: "#000000",
      [THEME_TOKENS.GRID_LINE]: "#000000",
      [THEME_TOKENS.BORDER_DEFAULT]: "#000000",
      [THEME_TOKENS.GRID_HEADER_TEXT]: "#000000",
    },
    grid: { cellText: "#000000", cellTextNumber: "#000000", gridLine: "#7a7a7a", headerText: "#000000" },
  },
  dark: {
    tokens: {
      [THEME_TOKENS.TEXT_PRIMARY]: "#ffffff",
      [THEME_TOKENS.TEXT_SECONDARY]: "#e8e8e8",
      [THEME_TOKENS.GRID_TEXT]: "#ffffff",
      [THEME_TOKENS.GRID_LINE]: "#ffffff",
      [THEME_TOKENS.BORDER_DEFAULT]: "#ffffff",
      [THEME_TOKENS.GRID_HEADER_TEXT]: "#ffffff",
    },
    grid: { cellText: "#ffffff", cellTextNumber: "#ffffff", gridLine: "#8a8a8a", headerText: "#ffffff" },
  },
};

/**
 * Apply the active accessibility override on top of an already-merged
 * (tokens, grid). Returns possibly-new objects. Pure aside from `a11y` read.
 */
function applyAccessibility(
  skin: Skin,
  tokens: Record<string, string>,
  grid: GridTheme
): { tokens: Record<string, string>; grid: GridTheme } {
  const o = a11y;
  if (!o.forcedBase && !o.highContrast && !o.minFontScale) return { tokens, grid };

  let outTokens = tokens;
  let outGrid = grid;

  // forcedBase: re-derive from the forced baseline (ignores the skin's color
  // deltas — a deliberate, strong legibility action), then re-apply density/font.
  if (o.forcedBase && o.forcedBase !== skin.base) {
    outTokens = { ...TOKEN_BASELINES[o.forcedBase] };
    outGrid = { ...GRID_BASELINES[o.forcedBase] };
    if (skin.density) {
      outTokens[THEME_TOKENS.FONT_SIZE_CELL] = `${DENSITY_FONT_SIZE[skin.density]}px`;
      outGrid.cellFontSize = DENSITY_FONT_SIZE[skin.density];
    }
    if (skin.fontFamily) {
      outTokens[THEME_TOKENS.FONT_FAMILY_SANS] = skin.fontFamily;
      outGrid.cellFontFamily = skin.fontFamily;
    }
  } else {
    outTokens = { ...tokens };
    outGrid = { ...grid };
  }

  const effectiveBase: SkinBase = o.forcedBase ?? skin.base;

  if (o.highContrast) {
    Object.assign(outTokens, HIGH_CONTRAST[effectiveBase].tokens);
    Object.assign(outGrid, HIGH_CONTRAST[effectiveBase].grid);
  }

  if (o.minFontScale && o.minFontScale > 1) {
    const scaled = Math.round(outGrid.cellFontSize * o.minFontScale);
    if (scaled > outGrid.cellFontSize) {
      outGrid.cellFontSize = scaled;
      outTokens[THEME_TOKENS.FONT_SIZE_CELL] = `${scaled}px`;
    }
  }

  return { tokens: outTokens, grid: outGrid };
}

// --- Apply + notify ------------------------------------------------------------

function apply(skin: Skin): void {
  const merged = applyAccessibility(skin, getMergedTokens(skin), getMergedGridTheme(skin));
  injectTokens(merged.tokens);
  cachedGridTheme = merged.grid;
  if (typeof document !== "undefined") {
    document.documentElement.dataset.reducedMotion = a11y.reducedMotion ? "true" : "false";
  }
  notify();
}

function notify(): void {
  subscribers.forEach((cb) => cb());
}

// --- Public API ----------------------------------------------------------------

/**
 * Register a skin (built-in or extension/org-contributed). If the registered
 * skin's id is the currently-active one (e.g. it was the persisted id but had
 * not loaded yet at boot), re-apply it now with its correct base/values.
 */
export function registerSkin(skin: Skin): void {
  registry.set(skin.id, skin);
  if (initialized && skin.id === activeSkinId) {
    apply(skin);
  }
}

export function getRegisteredSkins(): Skin[] {
  return Array.from(registry.values());
}

export function getSkin(id: string): Skin | undefined {
  return registry.get(id);
}

export function getActiveSkinId(): string {
  return activeSkinId;
}

export function getActiveSkin(): Skin {
  return registry.get(activeSkinId) ?? lightSkin;
}

/**
 * Switch the active skin. No-op for an unknown id (keeps the current skin).
 * @param opts.persist When true (default) records this as the user's explicit
 *        choice in localStorage. The enterprise resolver applies the org default
 *        with persist:false so it never masquerades as a user choice.
 */
export function setActiveSkin(id: string, opts?: { persist?: boolean }): void {
  const skin = registry.get(id);
  if (!skin) return;
  activeSkinId = id;
  if (opts?.persist ?? true) persistId(id);
  apply(skin);
}

/** True if the user has explicitly chosen a skin (vs. running a default). */
export function hasUserChosenSkin(): boolean {
  return readPersistedId() !== null;
}

/** Clear the user's explicit choice (revert to default/policy on next boot). */
export function clearUserSkinChoice(): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(SKIN_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/** Set the accessibility override and immediately re-apply the active skin. */
export function setAccessibility(override: AccessibilityOverride): void {
  a11y = override ?? {};
  apply(getActiveSkin());
}

/** Current accessibility override. */
export function getAccessibility(): AccessibilityOverride {
  return a11y;
}

/** Current merged GridTheme. Stable reference until the active skin changes. */
export function getActiveGridTheme(): GridTheme {
  return cachedGridTheme;
}

/** Subscribe to active-skin changes (used by the canvas + Appearance UI). */
export function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

/**
 * Initialize the loader: register built-ins, read the persisted skin id
 * synchronously, and inject its CSS variables BEFORE first paint (FOUC-free).
 *
 * @param preferredId Optional id to apply instead of the persisted one (used by
 *        the enterprise resolver to seed the org default before the user has
 *        chosen). The persisted user choice still wins if present.
 */
export function initSkinLoader(preferredId?: string): void {
  if (initialized) return;
  initialized = true;

  for (const s of BUILTIN_SKINS) registry.set(s.id, s);

  const id = readPersistedId() ?? preferredId ?? BUILTIN_DEFAULT_SKIN_ID;
  const skin = registry.get(id);

  if (skin) {
    activeSkinId = id;
    apply(skin);
    return;
  }

  // Persisted/preferred id belongs to a not-yet-registered skin (extension or
  // org skin loaded later). Keep it active so registerSkin re-applies, but show
  // the light baseline now to avoid a wrong-base flash.
  activeSkinId = id;
  apply(lightSkin);
}

/** Test-only: reset module state so each test starts clean. */
export function __resetSkinLoaderForTests(): void {
  registry.clear();
  subscribers.clear();
  activeSkinId = BUILTIN_DEFAULT_SKIN_ID;
  cachedGridTheme = DEFAULT_THEME;
  initialized = false;
  a11y = {};
  if (styleEl && styleEl.isConnected) styleEl.remove();
  styleEl = null;
}
