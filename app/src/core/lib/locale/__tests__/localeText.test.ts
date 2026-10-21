//! FILENAME: app/src/core/lib/locale/__tests__/localeText.test.ts
// PURPOSE: The locale text module's rules beyond the shared corpus: exact
//          ties, the option form of formatNumber, the declared code subset
//          (`exact`), the parse extras (currency, trailing minus, plain space),
//          calendar names, and the active-locale store.

import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import {
  formatNumberIn,
  formatNumberWithCodeIn,
  formatDateIn,
  parseNumberIn,
  parseDateIn,
  monthNameIn,
  dayNameIn,
  quarterLabelIn,
  normalizeLocaleSettings,
  getActiveLocale,
  setActiveLocale,
  subscribeActiveLocale,
  resetActiveLocaleForTests,
  INVARIANT_LOCALE,
} from "../index";
import type { LocaleSettings } from "../index";

const CORPUS = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../../../../../core/engine/tests/fixtures/locale_text_corpus.json"), "utf8"),
) as { locales: Record<string, LocaleSettings> };
const L = (id: string) => normalizeLocaleSettings(CORPUS.locales[id]);
const US = L("en-US");
const SV = L("sv-SE");
const DE = L("de-DE");
const FR = L("fr-FR");

describe("General: exact digits, ties to even like Rust's formatter", () => {
  it("rounds an exact tie at the 10th decimal to even (Rust {:.10}), not up (JS toFixed)", () => {
    // 2^-11 = 0.00048828125 exactly: the 11th decimal is a true 5.
    expect(formatNumberIn(US, 1 / 2048)).toBe("0.0004882812");
  });

  it("rounds a scientific mantissa tie to even (Rust {:.5e})", () => {
    // 1234565 * 10^12 is an exact double; the 7th significant digit is a true 5.
    expect(formatNumberIn(US, 1234565e12)).toBe("1.23456E+18");
    expect(formatNumberIn(US, 1234575e12)).toBe("1.23458E+18");
  });

  it("keeps the exponent whole and localises only the mantissa", () => {
    expect(formatNumberIn(US, 1e100)).toBe("1E+100");
    expect(formatNumberIn(SV, -1.5e-7)).toBe("-1,5E-07");
  });

  it("prints integers exactly and never a negative zero", () => {
    expect(formatNumberIn(US, 123456789012345)).toBe("123456789012345");
    expect(formatNumberIn(US, -0)).toBe("0");
  });
});

describe("formatNumber options", () => {
  it("fixed decimals with grouping, in the locale", () => {
    expect(formatNumberIn(DE, 1234567.891, { decimals: 2, grouping: true })).toBe("1.234.567,89");
    expect(formatNumberIn(SV, 1234567.891, { decimals: 2, grouping: true })).toBe("1 234 567,89");
    expect(formatNumberIn(US, -2.5, { decimals: 0 })).toBe("-3");
  });

  it("min/max decimals and trimZeros drop trailing zeros but never leave a bare separator", () => {
    expect(formatNumberIn(DE, 3, { maxDecimals: 2, trimZeros: true })).toBe("3");
    expect(formatNumberIn(DE, 3.1, { maxDecimals: 2, trimZeros: true })).toBe("3,1");
    expect(formatNumberIn(DE, 3.14159, { minDecimals: 1, maxDecimals: 3 })).toBe("3,142");
    expect(formatNumberIn(DE, 3, { minDecimals: 1, maxDecimals: 3 })).toBe("3,0");
  });

  it("percent multiplies by 100 and appends %", () => {
    expect(formatNumberIn(SV, 0.1234, { decimals: 1, percent: true })).toBe("12,3%");
    expect(formatNumberIn(US, 0.5, { maxDecimals: 2, trimZeros: true, percent: true })).toBe("50%");
  });

  it("a value that rounds to zero is not shown negative", () => {
    expect(formatNumberIn(US, -0.001, { decimals: 2 })).toBe("0.00");
  });

  it("General with grouping groups only the integer part", () => {
    expect(formatNumberIn(DE, 1234567.25, { grouping: true })).toBe("1.234.567,25");
    expect(formatNumberIn(US, 1e20, { grouping: true })).toBe("1E+20");
  });
});

describe("format codes: the declared subset reports exact, the rest falls back", () => {
  it("renders the subset exactly", () => {
    expect(formatNumberWithCodeIn(DE, 1234.5, "#,##0.00")).toEqual({ text: "1.234,50", exact: true });
    expect(formatNumberWithCodeIn(US, 1234567, "#,##0,")).toEqual({ text: "1,235", exact: true });
    expect(formatNumberWithCodeIn(US, 0, "0.00;(0.00);\"zero\"")).toEqual({ text: "zero", exact: true });
    expect(formatNumberWithCodeIn(US, -5, "[Red]0;[Blue]-0")).toEqual({ text: "-5", exact: true });
  });

  it("General and the empty code are General", () => {
    expect(formatNumberWithCodeIn(SV, 0.5, "General")).toEqual({ text: "0,5", exact: true });
    expect(formatNumberWithCodeIn(SV, 0.5, "")).toEqual({ text: "0,5", exact: true });
  });

  it("scientific, fractions, conditions, elapsed time and @ are outside the subset", () => {
    for (const code of ["0.00E+00", "# ?/?", "[>100]0;0.00", "[h]:mm", "@"]) {
      const res = formatNumberWithCodeIn(US, 1234.5, code);
      expect(res.exact, code).toBe(false);
      expect(res.text, code).toBe("1234.5");
    }
  });

  it("date codes use the locale's calendar names", () => {
    expect(formatNumberWithCodeIn(FR, 45306, "dddd d mmmm yyyy").text).toBe("lundi 15 janvier 2024");
    expect(formatNumberWithCodeIn(US, 45306.75, "yyyy-mm-dd hh:mm").text).toBe("2024-01-15 18:00");
  });
});

describe("parseNumber: strict for the locale, plus the TS extras", () => {
  it("refuses the foreign spelling", () => {
    expect(parseNumberIn(SV, "1.5")).toBeNull();
    expect(parseNumberIn(US, "1,5")).toBeNull();
    expect(parseNumberIn(DE, "1,234.5")).toBeNull();
  });

  it("accepts a plain space where the locale groups with NBSP", () => {
    expect(parseNumberIn(SV, "1 234 567,5")).toBe(1234567.5);
    expect(parseNumberIn(FR, "1 234,5")).toBe(1234.5);
  });

  it("accepts a trailing minus and the locale's own currency symbol", () => {
    expect(parseNumberIn(DE, "12,5-")).toBe(-12.5);
    expect(parseNumberIn(SV, "1 234,50 kr")).toBe(1234.5);
    expect(parseNumberIn(DE, "€ 12,5")).toBe(12.5);
    expect(parseNumberIn(DE, "-€ 12,5")).toBe(-12.5);
    expect(parseNumberIn(US, "$1,234.50")).toBe(1234.5);
  });

  it("refuses another locale's currency, a doubled sign and junk", () => {
    expect(parseNumberIn(SV, "$5")).toBeNull();
    expect(parseNumberIn(DE, "-12,5-")).toBeNull();
    expect(parseNumberIn(US, "12abc")).toBeNull();
    expect(parseNumberIn(US, "inf")).toBeNull();
    expect(parseNumberIn(US, "")).toBeNull();
  });
});

describe("parseDate", () => {
  it("reads the locale's order and refuses the year-less and impossible", () => {
    expect(parseDateIn(DE, "15.01.2024")).toBe(45306);
    expect(parseDateIn(US, "3/4")).toBeNull();
    expect(parseDateIn(US, "2024-02-30")).toBeNull();
    expect(parseDateIn(SV, "1:45 PM")).toBeNull();
    expect(parseDateIn(US, "1:45 PM")).toBeCloseTo((13 * 60 + 45) / 1440, 12);
    expect(parseDateIn(US, "1900-02-29")).toBe(60);
  });
});

describe("dates and calendar names", () => {
  it("formats every style from the locale's patterns", () => {
    expect(formatDateIn(DE, 45306, "long")).toBe("Montag, 15. Januar 2024");
    expect(formatDateIn(SV, 45306.5, "dateTime")).toBe("2024-01-15 12:00:00");
    expect(formatDateIn(US, new Date(2024, 0, 15, 18, 0, 0), "dateTime")).toBe("01/15/2024 6:00:00 PM");
  });

  it("names months, days and quarters, with ??? out of range like the engine", () => {
    expect(monthNameIn(SV, 1)).toBe("januari");
    expect(monthNameIn(DE, 3, "short")).toBe("Mär");
    expect(dayNameIn(FR, 1)).toBe("lundi");
    expect(quarterLabelIn(SV, 3)).toBe("Kv3");
    expect(quarterLabelIn(SV, 5)).toBe("???");
    expect(monthNameIn(US, 13)).toBe("???");
  });
});

describe("the active locale store", () => {
  beforeEach(() => resetActiveLocaleForTests());

  it("is the invariant locale before install, never null", () => {
    expect(getActiveLocale()).toEqual(normalizeLocaleSettings(INVARIANT_LOCALE));
  });

  it("tells subscribers only when something changed", () => {
    const seen: string[] = [];
    const off = subscribeActiveLocale((l) => seen.push(l.localeId));
    expect(setActiveLocale(SV)).toBe(true);
    expect(setActiveLocale({ ...SV })).toBe(false);
    expect(setActiveLocale(DE)).toBe(true);
    off();
    setActiveLocale(US);
    expect(seen).toEqual(["sv-SE", "de-DE"]);
  });

  it("fills a partial payload field by field, so no separator is ever undefined", () => {
    const partial = normalizeLocaleSettings({ localeId: "sv-SE", decimalSeparator: "," } as Partial<LocaleSettings>);
    expect(partial.decimalSeparator).toBe(",");
    expect(partial.thousandsSeparator).toBe(",");
    expect(partial.monthNamesLong).toHaveLength(12);
    expect(partial.overrideId).toBeNull();
  });
});
