//! FILENAME: app/src/api/locale.ts
//! PURPOSE: The APP locale for extensions: read it synchronously, format and parse
//!          numbers and dates in it, follow its changes, and change it.
//! CONTEXT: P2 (app locale everywhere). Rust owns the app locale (the user's
//!          choice persisted in the app settings file, else the OS regional
//!          format). Every window awaits `initAppLocale()` before its first
//!          render and follows the Rust `locale:changed` event afterwards, so
//!          `getAppLocale()` is the backend's value from the first frame on.
//!          The formatting itself is the pure `core/lib/locale` module, which a
//!          shared corpus keeps byte-identical to the Rust engine.
//!
//! SYNC vs ASYNC: `getAppLocale()`, `decimalSeparator()` and `listSeparator()`
//! are SYNC. `getLocaleSettings()` is ASYNC (a Promise) -- never write
//! `getLocaleSettings().decimalSeparator`, which reads a property of a Promise
//! and is always undefined.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AppEvents, emitAppEvent } from "./events";
import {
  formatNumberIn,
  formatNumberWithCodeIn,
  formatDateIn,
  parseNumberIn,
  parseDateIn,
  monthNameIn,
  dayNameIn,
  quarterLabelIn,
  getActiveLocale,
  setActiveLocale,
  INVARIANT_LOCALE,
} from "../core/lib/locale";
import type { LocaleSettings, DateStyle, FormatNumberOptions } from "../core/lib/locale";

// ============================================================================
// Types
// ============================================================================

export type { LocaleSettings, DateStyle, FormatNumberOptions };

/** A supported locale entry for the settings UI. */
export interface SupportedLocaleEntry {
  localeId: string;
  displayName: string;
}

/**
 * The Tauri event Rust emits (to every window) after the app locale changed.
 * Mirrors `app_locale::LOCALE_CHANGED_EVENT` in the backend.
 */
export const LOCALE_CHANGED_EVENT = "locale:changed";

/** The invariant (en-US) locale every window starts from before init. */
export { INVARIANT_LOCALE };

// ============================================================================
// Install / follow
// ============================================================================

let initPromise: Promise<LocaleSettings> | null = null;
let initFailureLogged = false;

/**
 * Install a locale received from the backend into this window and announce it
 * (`AppEvents.LOCALE_CHANGED`) when it changed anything. The same value arriving
 * twice (a `set_locale` reply and then the event) announces once.
 */
function applyFromBackend(raw: Partial<LocaleSettings> | null | undefined): LocaleSettings {
  if (raw && setActiveLocale(raw)) {
    emitAppEvent(AppEvents.LOCALE_CHANGED, getActiveLocale());
  }
  return getActiveLocale();
}

/**
 * Fetch the app locale from Rust and install it, then follow every
 * `locale:changed` event. Each window entry awaits this before its first
 * render. Idempotent: later calls return the first call's promise.
 *
 * FAIL-SAFE: if the backend cannot be reached the window keeps the invariant
 * locale, logs ONE error and still renders -- a white window is worse than "."
 * separators.
 */
export function initAppLocale(): Promise<LocaleSettings> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      const data = await invoke<LocaleSettings>("get_locale_settings");
      setActiveLocale(data);
    } catch (err) {
      if (!initFailureLogged) {
        initFailureLogged = true;
        console.error("[locale] could not read the app locale; using the invariant locale:", err);
      }
    }
    try {
      await listen<LocaleSettings>(LOCALE_CHANGED_EVENT, (event) => {
        applyFromBackend(event.payload);
      });
    } catch {
      // No Tauri event bridge (a non-webview context): the window keeps the
      // locale it read; `setLocale` in this window still installs its reply.
    }
    return getActiveLocale();
  })();
  return initPromise;
}

/** TEST ONLY: forget the init so a test can run it again. */
export function resetAppLocaleInitForTests(): void {
  initPromise = null;
  initFailureLogged = false;
}

// ============================================================================
// Reading
// ============================================================================

/**
 * THE sync accessor: the app locale of this window. Never null (the invariant
 * locale before `initAppLocale` has resolved).
 */
export function getAppLocale(): LocaleSettings {
  return getActiveLocale();
}

/**
 * The app locale, ASYNC (kept for callers that already await it). It returns
 * the active value; a window whose init has not run yet runs it first.
 */
export async function getLocaleSettings(): Promise<LocaleSettings> {
  if (!initPromise) await initAppLocale();
  return getActiveLocale();
}

/** The app locale's decimal separator ("." or ","). Sync. */
export function decimalSeparator(): string {
  return getActiveLocale().decimalSeparator;
}

/** The app locale's list (formula argument) separator ("," or ";"). Sync. */
export function listSeparator(): string {
  return getActiveLocale().listSeparator;
}

// ============================================================================
// Changing
// ============================================================================

/**
 * Set the app locale by id; "system" follows the OS again. Rust persists the
 * choice and announces it to every window (`locale:changed`); the reply is
 * also installed here at once, so this window never waits on the event.
 */
export async function setLocale(localeId: string): Promise<LocaleSettings> {
  const data = await invoke<LocaleSettings>("set_locale", { localeId });
  return applyFromBackend(data);
}

/** List all supported locales for the settings UI dropdown. */
export async function getSupportedLocales(): Promise<SupportedLocaleEntry[]> {
  return invoke<SupportedLocaleEntry[]>("get_supported_locales");
}

/**
 * Subscribe to locale changes in this window.
 * @returns Unsubscribe function.
 */
export function onLocaleChanged(callback: (locale: LocaleSettings) => void): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<LocaleSettings>).detail;
    if (detail) callback(detail);
  };
  window.addEventListener(AppEvents.LOCALE_CHANGED, handler);
  return () => window.removeEventListener(AppEvents.LOCALE_CHANGED, handler);
}

// ============================================================================
// Formatting and parsing in the app locale (sync)
// ============================================================================

/**
 * A number for display in the app locale. No options = Excel's General; with
 * `decimals` / `minDecimals` / `maxDecimals` it rounds half away from zero like
 * a `0.00` format; `grouping` inserts the locale's group separator; `percent`
 * multiplies by 100 and appends "%".
 */
export function formatNumber(value: number, opts?: FormatNumberOptions): string {
  return formatNumberIn(getActiveLocale(), value, opts);
}

/**
 * A number rendered with an invariant (en-US syntax) format code in the app
 * locale. Codes outside the supported subset render General.
 */
export function formatNumberWithCode(value: number, code: string): string {
  return formatNumberWithCodeIn(getActiveLocale(), value, code).text;
}

/** An Excel date serial (or a JS Date, in local time) in the app locale's pattern. */
export function formatDate(value: number | Date, style: DateStyle = "short"): string {
  return formatDateIn(getActiveLocale(), value, style);
}

/**
 * A chrome timestamp (an ISO string, epoch milliseconds or a Date) as the app
 * locale's short date and long time. "" for anything that is not a time.
 */
export function formatDateTime(value: number | Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return formatDateIn(getActiveLocale(), date, "dateTime");
}

/** Month name (1 = January) in the app locale. */
export function monthName(month1: number, form: "short" | "long" = "long"): string {
  return monthNameIn(getActiveLocale(), month1, form);
}

/** Weekday name (0 = Sunday) in the app locale. */
export function dayName(dow0: number, form: "short" | "long" = "long"): string {
  return dayNameIn(getActiveLocale(), dow0, form);
}

/** Quarter label (1..4) in the app locale ("Q3", "Kv3"). */
export function quarterLabel(quarter: number): string {
  return quarterLabelIn(getActiveLocale(), quarter);
}

/**
 * Read user-typed text as a number, STRICTLY in the app locale: its grouping,
 * its decimal separator, a leading or trailing minus, "%" and its currency
 * symbol. Null when it is not a number in this locale ("1.5" in sv-SE).
 */
export function parseNumber(text: string): number | null {
  return parseNumberIn(getActiveLocale(), text);
}

/** Read user-typed text as a date/time in the app locale: an Excel serial, or null. */
export function parseDate(text: string): number | null {
  return parseDateIn(getActiveLocale(), text);
}
