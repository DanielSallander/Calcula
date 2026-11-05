//! FILENAME: app/src/api/theme.ts
//! PURPOSE: Theme API for extensions to get/set document themes.
//! CONTEXT: Part of the API layer. Extensions use this to interact with theme system.

import { invoke } from "@tauri-apps/api/core";
import type {
  ThemeDefinitionData,
  ThemeColorInfo,
  SetThemeResult,
} from "../core/types/types";
import { AppEvents, emitAppEvent } from "./events";

// ============================================================================
// Cached State
// ============================================================================

let cachedTheme: ThemeDefinitionData | null = null;
let cachedPalette: ThemeColorInfo[] | null = null;
/**
 * Bumped by every invalidation, so a read that was already in flight when the
 * document changed does not put the OUTGOING document's theme back in the
 * cache when it lands.
 */
let cacheGeneration = 0;

/**
 * THE CACHE IS PER DOCUMENT, and dropped HERE, once, for every consumer: when
 * another document opens or a new one starts (each brings its own theme), and
 * when the theme changes by any route (`setDocumentTheme` below, an undo, a
 * script). It used to be dropped only by the Home tab's colour button, so
 * every other consumer -- the colour pickers' palette (`@api/layout` Color),
 * Format Cells' font list (`getCachedTheme`), the theme gallery -- kept the
 * PREVIOUS file's palette after File > Open. Capture phase: on `window`, the
 * target of every app event, capture listeners run before the ordinary ones,
 * so a consumer that re-reads on the same event always reads after the drop.
 */
function installThemeCacheInvalidation(): void {
  if (typeof window === "undefined") return;
  // Read the event names first: a unit test that mocks `./events` without
  // `AppEvents` makes that read THROW, and an import-time throw here would
  // break every module that imports the theme API, not just the cache.
  let names: { open: string; created: string; themeChanged: string };
  try {
    names = { open: AppEvents.AFTER_OPEN, created: AppEvents.AFTER_NEW, themeChanged: AppEvents.THEME_CHANGED };
  } catch {
    return;
  }
  if (!names.open || !names.created || !names.themeChanged) return;
  const drop = (): void => clearThemeCache();
  window.addEventListener(names.open, drop, { capture: true });
  window.addEventListener(names.created, drop, { capture: true });
  window.addEventListener(
    names.themeChanged,
    (e: Event) => {
      const theme = (e as CustomEvent).detail?.theme as ThemeDefinitionData | undefined;
      clearThemeCache();
      // The event names the new theme: keep it, so a synchronous reader
      // (`getCachedTheme`) still answers right after the change.
      if (theme) cachedTheme = theme;
    },
    { capture: true },
  );
}
installThemeCacheInvalidation();

// ============================================================================
// Theme API
// ============================================================================

/**
 * Get the active document theme.
 */
export async function getDocumentTheme(): Promise<ThemeDefinitionData> {
  if (cachedTheme) return cachedTheme;
  const generation = cacheGeneration;
  const theme = await invoke<ThemeDefinitionData>("get_document_theme");
  if (generation === cacheGeneration) cachedTheme = theme;
  return theme;
}

/**
 * Set the document theme. Invalidates style cache and triggers re-render.
 */
export async function setDocumentTheme(
  theme: ThemeDefinitionData
): Promise<SetThemeResult> {
  const result = await invoke<SetThemeResult>("set_document_theme", { theme });
  cachedTheme = theme;
  cachedPalette = null; // palette changes with theme
  emitAppEvent(AppEvents.THEME_CHANGED, { theme });
  return result;
}

/**
 * List all built-in themes.
 */
export async function listBuiltinThemes(): Promise<ThemeDefinitionData[]> {
  return invoke<ThemeDefinitionData[]>("list_builtin_themes");
}

/**
 * Get the theme color palette for the color picker (60 entries).
 */
export async function getThemeColorPalette(): Promise<ThemeColorInfo[]> {
  if (cachedPalette) return cachedPalette;
  const generation = cacheGeneration;
  const palette = await invoke<ThemeColorInfo[]>("get_theme_color_palette");
  if (generation === cacheGeneration) cachedPalette = palette;
  return palette;
}

/**
 * Subscribe to theme changes.
 * @returns Unsubscribe function
 */
export function onThemeChanged(
  callback: (theme: ThemeDefinitionData) => void
): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail?.theme) {
      callback(detail.theme);
    }
  };
  window.addEventListener(AppEvents.THEME_CHANGED, handler);
  return () => window.removeEventListener(AppEvents.THEME_CHANGED, handler);
}

/**
 * Get the cached theme synchronously (may be null before first fetch).
 */
export function getCachedTheme(): ThemeDefinitionData | null {
  return cachedTheme;
}

/**
 * Clear the theme cache. Done for every consumer on AFTER_OPEN, AFTER_NEW and
 * THEME_CHANGED (see `installThemeCacheInvalidation`); a caller needs it only
 * for a document change that announces none of those.
 */
export function clearThemeCache(): void {
  cacheGeneration += 1;
  cachedTheme = null;
  cachedPalette = null;
}
