//! FILENAME: app/src/core/lib/locale/activeLocale.ts
// PURPOSE: The process-wide ACTIVE locale of this window, readable synchronously.
// CONTEXT: P2 (app locale everywhere). Rust owns the app locale; `@api/locale`
//          fetches it before first render (`initAppLocale`) and on every
//          `locale:changed` event, and installs it here. Core code (renderers,
//          parsers) and `@api` helpers read it with `getActiveLocale()`, which is
//          NEVER null: before install it is the invariant locale, mirroring
//          `LocaleSettings::invariant()` (core/engine/src/locale.rs) with its
//          English calendar.
//          Pure: no Tauri import, so the Core may use it (Alien rule).

import type { LocaleSettings } from "./localeText";

/** Mirrors Rust `LocaleSettings::invariant()` + `CALENDAR_EN`. */
export const INVARIANT_LOCALE: Readonly<LocaleSettings> = Object.freeze({
  localeId: "en-US",
  displayName: "English (United States)",
  decimalSeparator: ".",
  thousandsSeparator: ",",
  listSeparator: ",",
  dateFormat: "MM/DD/YYYY",
  longDateFormat: "dddd, mmmm d, yyyy",
  timeFormat: "h:mm:ss AM/PM",
  currencySymbol: "$",
  currencyPosition: "before" as const,
  overrideId: null,
  monthNamesShort: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
  monthNamesLong: [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ],
  dayNamesShort: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
  dayNamesLong: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
  quarterLabels: ["Q1", "Q2", "Q3", "Q4"],
});

function listOf(value: unknown, length: number, fallback: readonly string[]): string[] {
  return Array.isArray(value) && value.length === length && value.every((v) => typeof v === "string")
    ? [...(value as string[])]
    : [...fallback];
}

function textOf(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/**
 * Turn what the backend sent into a complete LocaleSettings. Missing or
 * malformed fields fall back to the invariant locale's, field by field, so a
 * partial payload can never leave a separator `undefined` (an `undefined`
 * separator renders as the literal text "undefined" in every number).
 */
export function normalizeLocaleSettings(raw: Partial<LocaleSettings> | null | undefined): LocaleSettings {
  const r = (raw ?? {}) as Record<string, unknown>;
  const inv = INVARIANT_LOCALE;
  const position = r.currencyPosition === "after" ? "after" : r.currencyPosition === "before" ? "before" : inv.currencyPosition;
  return {
    localeId: textOf(r.localeId, inv.localeId),
    displayName: textOf(r.displayName, inv.displayName),
    decimalSeparator: textOf(r.decimalSeparator, inv.decimalSeparator) || inv.decimalSeparator,
    thousandsSeparator: textOf(r.thousandsSeparator, inv.thousandsSeparator),
    listSeparator: textOf(r.listSeparator, inv.listSeparator) || inv.listSeparator,
    dateFormat: textOf(r.dateFormat, inv.dateFormat) || inv.dateFormat,
    longDateFormat: textOf(r.longDateFormat, inv.longDateFormat) || inv.longDateFormat,
    timeFormat: textOf(r.timeFormat, inv.timeFormat) || inv.timeFormat,
    currencySymbol: textOf(r.currencySymbol, inv.currencySymbol),
    currencyPosition: position,
    overrideId: typeof r.overrideId === "string" && r.overrideId ? r.overrideId : null,
    monthNamesShort: listOf(r.monthNamesShort, 12, inv.monthNamesShort),
    monthNamesLong: listOf(r.monthNamesLong, 12, inv.monthNamesLong),
    dayNamesShort: listOf(r.dayNamesShort, 7, inv.dayNamesShort),
    dayNamesLong: listOf(r.dayNamesLong, 7, inv.dayNamesLong),
    quarterLabels: listOf(r.quarterLabels, 4, inv.quarterLabels),
  };
}

let active: LocaleSettings = normalizeLocaleSettings(INVARIANT_LOCALE);
const subscribers = new Set<(locale: LocaleSettings) => void>();

function sameLocale(a: LocaleSettings, b: LocaleSettings): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The active locale. Never null: the invariant locale before install. */
export function getActiveLocale(): LocaleSettings {
  return active;
}

/**
 * Install `locale` as the active locale. Returns true when it CHANGED anything
 * (subscribers are told only then), so the same value arriving twice -- the
 * `set_locale` reply and the `locale:changed` event -- announces once.
 */
export function setActiveLocale(locale: Partial<LocaleSettings>): boolean {
  const next = normalizeLocaleSettings(locale);
  if (sameLocale(next, active)) return false;
  active = next;
  for (const cb of Array.from(subscribers)) {
    try {
      cb(active);
    } catch (err) {
      console.error("[locale] subscriber failed:", err);
    }
  }
  return true;
}

/** Hear every change of the active locale. Returns the unsubscribe. */
export function subscribeActiveLocale(cb: (locale: LocaleSettings) => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

/** TEST ONLY: back to the invariant locale with no subscribers. */
export function resetActiveLocaleForTests(): void {
  active = normalizeLocaleSettings(INVARIANT_LOCALE);
  subscribers.clear();
}
