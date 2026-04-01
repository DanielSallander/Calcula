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

// ============================================================================
// Theme API
// ============================================================================

/**
 * Get the active document theme.
 */
export async function getDocumentTheme(): Promise<ThemeDefinitionData> {
  if (cachedTheme) return cachedTheme;
  const theme = await invoke<ThemeDefinitionData>("get_document_theme");
  cachedTheme = theme;
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
  const palette = await invoke<ThemeColorInfo[]>("get_theme_color_palette");
  cachedPalette = palette;
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
 * Clear the theme cache (call after loading a new file).
 */
export function clearThemeCache(): void {
  cachedTheme = null;
  cachedPalette = null;
}
