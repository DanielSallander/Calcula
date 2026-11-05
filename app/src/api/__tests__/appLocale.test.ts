//! FILENAME: app/src/api/__tests__/appLocale.test.ts
// PURPOSE: The @api/locale contract (P2 S6): the window awaits the backend's
//          app locale before rendering, follows locale:changed, falls back to
//          the invariant locale (logging once) when the backend cannot answer,
//          never touches localStorage, and keeps getLocaleSettings ASYNC.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

import {
  initAppLocale,
  getAppLocale,
  getLocaleSettings,
  setLocale,
  decimalSeparator,
  listSeparator,
  formatNumber,
  parseNumber,
  monthName,
  quarterLabel,
  LOCALE_CHANGED_EVENT,
  BI_FORMAT_CULTURE_APPLIED_EVENT,
  onBiFormatCultureApplied,
  getBiFormatCultureGeneration,
  resetAppLocaleInitForTests,
} from "../locale";
import { AppEvents } from "../events";
import { resetActiveLocaleForTests } from "../../core/lib/locale";

const DE = {
  localeId: "de-DE",
  displayName: "Deutsch (Deutschland)",
  decimalSeparator: ",",
  thousandsSeparator: ".",
  listSeparator: ";",
  dateFormat: "DD.MM.YYYY",
  longDateFormat: "dddd, d. mmmm yyyy",
  timeFormat: "hh:mm:ss",
  currencySymbol: "€ ",
  currencyPosition: "before",
  overrideId: "de-DE",
  monthNamesShort: ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"],
  monthNamesLong: ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"],
  dayNamesShort: ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"],
  dayNamesLong: ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"],
  quarterLabels: ["Q1", "Q2", "Q3", "Q4"],
};

const SV = {
  ...DE,
  localeId: "sv-SE",
  displayName: "Svenska (Sverige)",
  thousandsSeparator: " ",
  dateFormat: "YYYY-MM-DD",
  overrideId: null,
  monthNamesLong: ["januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december"],
  quarterLabels: ["Kv1", "Kv2", "Kv3", "Kv4"],
};

let eventHandler: ((e: { payload: unknown }) => void) | null = null;
let cultureHandler: ((e: { payload: unknown }) => void) | null = null;

beforeEach(() => {
  resetActiveLocaleForTests();
  resetAppLocaleInitForTests();
  invokeMock.mockReset();
  listenMock.mockReset();
  eventHandler = null;
  cultureHandler = null;
  listenMock.mockImplementation(async (name: string, cb: (e: { payload: unknown }) => void) => {
    if (name === LOCALE_CHANGED_EVENT) eventHandler = cb;
    if (name === BI_FORMAT_CULTURE_APPLIED_EVENT) cultureHandler = cb;
    return () => {};
  });
});

// NEW-locale-listener-seam (round C): `locale:changed` fires BEFORE Rust has
// given every model engine the new DAX FORMAT culture, so a listener that
// re-queries a model on it alone can keep FORMAT text in the old culture. The
// ONE seam every such listener waits for re-dispatches Rust's walk-ended event
// in this window, counting it first so a cache keyed by the locale id can tell
// the re-read from a question already answered.
describe("onBiFormatCultureApplied (the end of Rust's FORMAT-culture walk)", () => {
  it("re-dispatches bi:format-culture-applied, counting the generation BEFORE it announces", async () => {
    invokeMock.mockResolvedValue(DE);
    await initAppLocale();
    expect(cultureHandler, "initAppLocale does not follow the culture walk's end").toBeTypeOf("function");
    const seen: number[] = [];
    const off = onBiFormatCultureApplied(() => seen.push(getBiFormatCultureGeneration()));
    const before = getBiFormatCultureGeneration();
    cultureHandler!({ payload: null });
    expect(seen).toEqual([before + 1]);
    // LOCALE_CHANGED alone is not the walk's end.
    window.dispatchEvent(new CustomEvent(AppEvents.LOCALE_CHANGED, { detail: SV }));
    expect(seen).toHaveLength(1);
    off();
    cultureHandler!({ payload: null });
    expect(seen, "an unsubscribed listener still hears the walk").toHaveLength(1);
    expect(getBiFormatCultureGeneration()).toBe(before + 2);
  });

  it("the wire name is Rust's", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const rust = fs.readFileSync(path.resolve(__dirname, "../../../src-tauri/src/bi/commands.rs"), "utf8");
    expect(rust).toContain(
      `pub(crate) const FORMAT_CULTURE_APPLIED_EVENT: &str = "${BI_FORMAT_CULTURE_APPLIED_EVENT}";`,
    );
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("initAppLocale", () => {
  it("awaits the backend's locale: invariant before it answers, the backend's value after", async () => {
    let answer: (v: unknown) => void = () => {};
    invokeMock.mockImplementation((cmd: string) => {
      expect(cmd).toBe("get_locale_settings");
      return new Promise((resolve) => {
        answer = resolve;
      });
    });
    const pending = initAppLocale();
    expect(getAppLocale().localeId).toBe("en-US");
    expect(decimalSeparator()).toBe(".");
    answer(DE);
    const installed = await pending;
    expect(installed.localeId).toBe("de-DE");
    expect(getAppLocale().localeId).toBe("de-DE");
    expect(decimalSeparator()).toBe(",");
    expect(listSeparator()).toBe(";");
    expect(getAppLocale().overrideId).toBe("de-DE");
    // The sync helpers format in the installed locale at once.
    expect(formatNumber(1234.5, { decimals: 2, grouping: true })).toBe("1.234,50");
    expect(parseNumber("1.234,5")).toBe(1234.5);
    expect(parseNumber("1,234.5")).toBeNull();
    expect(monthName(3)).toBe("März");
  });

  it("is idempotent: a second call returns the first call's promise and reads once", async () => {
    invokeMock.mockResolvedValue(DE);
    const a = initAppLocale();
    const b = initAppLocale();
    expect(a).toBe(b);
    await a;
    expect(invokeMock).toHaveBeenCalledTimes(1);
    // One listener per Rust event: the locale, and the end of the engines'
    // FORMAT-culture walk (round C) -- never a second set.
    expect(listenMock.mock.calls.map((c) => c[0])).toEqual([
      "locale:changed",
      "bi:format-culture-applied",
    ]);
  });

  it("a locale:changed event updates getAppLocale and announces LOCALE_CHANGED once", async () => {
    invokeMock.mockResolvedValue(DE);
    await initAppLocale();
    const heard: unknown[] = [];
    const onChange = (e: Event) => heard.push((e as CustomEvent).detail);
    window.addEventListener(AppEvents.LOCALE_CHANGED, onChange);
    try {
      expect(eventHandler).not.toBeNull();
      eventHandler!({ payload: SV });
      expect(getAppLocale().localeId).toBe("sv-SE");
      expect(quarterLabel(3)).toBe("Kv3");
      expect(formatNumber(1234.5, { decimals: 2, grouping: true })).toBe("1 234,50");
      // The same value again (another window's echo) announces nothing.
      eventHandler!({ payload: SV });
      expect(heard).toHaveLength(1);
      expect((heard[0] as { localeId: string }).localeId).toBe("sv-SE");
    } finally {
      window.removeEventListener(AppEvents.LOCALE_CHANGED, onChange);
    }
  });

  it("a failed read keeps the invariant locale, logs ONE error and still resolves", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    invokeMock.mockRejectedValue(new Error("no backend"));
    const installed = await initAppLocale();
    expect(installed.localeId).toBe("en-US");
    expect(getAppLocale().decimalSeparator).toBe(".");
    await initAppLocale();
    expect(errors).toHaveBeenCalledTimes(1);
  });
});

describe("setLocale", () => {
  it("asks the backend, installs its reply at once, and touches no localStorage", async () => {
    invokeMock.mockResolvedValue(DE);
    await initAppLocale();
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const removeItem = vi.spyOn(Storage.prototype, "removeItem");
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    const heard: unknown[] = [];
    const onChange = (e: Event) => heard.push((e as CustomEvent).detail);
    window.addEventListener(AppEvents.LOCALE_CHANGED, onChange);
    try {
      invokeMock.mockResolvedValue(SV);
      const next = await setLocale("sv-SE");
      expect(invokeMock).toHaveBeenLastCalledWith("set_locale", { localeId: "sv-SE" });
      expect(next.localeId).toBe("sv-SE");
      expect(getAppLocale().localeId).toBe("sv-SE");
      // The backend's own announcement of the same switch does not announce twice.
      eventHandler!({ payload: SV });
      expect(heard).toHaveLength(1);
      expect(setItem).not.toHaveBeenCalled();
      expect(removeItem).not.toHaveBeenCalled();
      expect(getItem).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(AppEvents.LOCALE_CHANGED, onChange);
    }
  });

  it('"system" is passed through to the backend, which owns what it means', async () => {
    invokeMock.mockResolvedValue({ ...SV, overrideId: null });
    const next = await setLocale("system");
    expect(invokeMock).toHaveBeenCalledWith("set_locale", { localeId: "system" });
    expect(next.overrideId).toBeNull();
  });
});

describe("getLocaleSettings stays ASYNC (the contract P3 reads, spec section 8)", () => {
  it("returns a Promise of the active locale, never the locale itself", async () => {
    invokeMock.mockResolvedValue(DE);
    const result = getLocaleSettings();
    expect(result).toBeInstanceOf(Promise);
    expect((result as unknown as { decimalSeparator?: string }).decimalSeparator).toBeUndefined();
    expect((await result).decimalSeparator).toBe(",");
  });
});
