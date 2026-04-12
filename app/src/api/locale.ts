//! FILENAME: app/src/api/locale.ts
//! PURPOSE: Locale/regional settings API for extensions.
//! CONTEXT: Provides access to the current locale settings (decimal separator,
//!          list separator, date format, etc.) and allows overriding the locale.

import { invoke } from "@tauri-apps/api/core";
import { AppEvents, emitAppEvent } from "./events";

// ============================================================================
// Types
// ============================================================================

/** Locale settings describing regional number/date/formula conventions. */
export interface LocaleSettings {
  /** BCP 47 locale ID, e.g. "en-US", "sv-SE" */
  localeId: string;
  /** Human-readable name, e.g. "Svenska (Sverige)" */
  displayName: string;
  /** Decimal separator: "." or "," */
  decimalSeparator: string;
  /** Thousands/grouping separator: ",", ".", " ", etc. */
  thousandsSeparator: string;
  /** List/argument separator used in formulas: "," or ";" */
  listSeparator: string;
  /** Default date format pattern, e.g. "YYYY-MM-DD" */
  dateFormat: string;
  /** Default currency symbol, e.g. "$", " kr" */
  currencySymbol: string;
  /** Currency position: "before" or "after" */
  currencyPosition: "before" | "after";
}

/** A supported locale entry for the settings UI. */
export interface SupportedLocaleEntry {
  localeId: string;
  displayName: string;
}

// ============================================================================
// Cached State
// ============================================================================

let cachedLocale: LocaleSettings | null = null;

const LOCALE_OVERRIDE_KEY = "calcula.locale";

// ============================================================================
// Locale API
// ============================================================================

/**
 * Get the current locale settings.
 * On first call, applies any saved user override from localStorage.
 */
export async function getLocaleSettings(): Promise<LocaleSettings> {
  if (cachedLocale) return cachedLocale;

  // Check for user override on first load
  const override = localStorage.getItem(LOCALE_OVERRIDE_KEY);
  if (override && override !== "system") {
    cachedLocale = await invoke<LocaleSettings>("set_locale", {
      localeId: override,
    });
  } else {
    cachedLocale = await invoke<LocaleSettings>("get_locale_settings");
  }
  return cachedLocale;
}

/**
 * Set the locale by ID. Pass "system" to use the OS-detected locale.
 * Persists the choice in localStorage and notifies all listeners.
 */
export async function setLocale(localeId: string): Promise<LocaleSettings> {
  if (localeId === "system") {
    localStorage.removeItem(LOCALE_OVERRIDE_KEY);
    // Re-read the system locale from Rust
    cachedLocale = await invoke<LocaleSettings>("get_locale_settings");
  } else {
    localStorage.setItem(LOCALE_OVERRIDE_KEY, localeId);
    cachedLocale = await invoke<LocaleSettings>("set_locale", { localeId });
  }
  emitAppEvent(AppEvents.LOCALE_CHANGED, cachedLocale);
  return cachedLocale;
}

/**
 * List all supported locales for the settings UI dropdown.
 */
export async function getSupportedLocales(): Promise<SupportedLocaleEntry[]> {
  return invoke<SupportedLocaleEntry[]>("get_supported_locales");
}

/**
 * Get the cached locale synchronously (may be null before first async load).
 * Useful for rendering code that cannot await.
 */
export function getCachedLocale(): LocaleSettings | null {
  return cachedLocale;
}

/**
 * Subscribe to locale changes.
 * @returns Unsubscribe function.
 */
export function onLocaleChanged(
  callback: (locale: LocaleSettings) => void
): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<LocaleSettings>).detail;
    if (detail) callback(detail);
  };
  window.addEventListener(AppEvents.LOCALE_CHANGED, handler);
  return () => window.removeEventListener(AppEvents.LOCALE_CHANGED, handler);
}
