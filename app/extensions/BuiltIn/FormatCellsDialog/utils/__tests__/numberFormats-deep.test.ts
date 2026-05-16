//! FILENAME: app/extensions/BuiltIn/FormatCellsDialog/utils/__tests__/numberFormats-deep.test.ts
// PURPOSE: Deep tests for number format categories, locale rendering, and format patterns.

import { describe, it, expect } from "vitest";
import {
  getNumberFormatCategories,
  NUMBER_FORMAT_CATEGORIES,
} from "../numberFormats";
import type { NumberFormatCategory } from "../numberFormats";

// ============================================================================
// Every category has at least one format
// ============================================================================

describe("all categories have formats", () => {
  const expectedIds = [
    "general", "number", "currency", "percentage", "scientific",
    "date", "time", "accounting", "fraction", "special", "custom",
  ];

  it.each(expectedIds)("category '%s' exists and has at least one format", (id) => {
    const cat = NUMBER_FORMAT_CATEGORIES.find((c) => c.id === id);
    expect(cat).toBeDefined();
    expect(cat!.formats.length).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================================
// Format examples render correctly for sample values
// ============================================================================

describe("format examples render correctly (US locale)", () => {
  const cats = getNumberFormatCategories(".", ",");

  it("general shows '1234.5'", () => {
    const general = cats.find((c) => c.id === "general")!;
    expect(general.formats[0].example).toBe("1234.5");
  });

  it("number with separator shows '1,234.00'", () => {
    const number = cats.find((c) => c.id === "number")!;
    const sep = number.formats.find((f) => f.value === "number_sep")!;
    expect(sep.example).toBe("1,234.00");
  });

  it("currency USD shows '$1,234.00'", () => {
    const currency = cats.find((c) => c.id === "currency")!;
    const usd = currency.formats.find((f) => f.value === "currency_usd")!;
    expect(usd.example).toBe("$1,234.00");
  });

  it("percentage shows '12.00%'", () => {
    const pct = cats.find((c) => c.id === "percentage")!;
    expect(pct.formats[0].example).toBe("12.00%");
  });

  it("scientific shows '1.23E+03'", () => {
    const sci = cats.find((c) => c.id === "scientific")!;
    expect(sci.formats[0].example).toBe("1.23E+03");
  });

  it("date ISO shows '2024-01-15'", () => {
    const date = cats.find((c) => c.id === "date")!;
    const iso = date.formats.find((f) => f.value === "date_iso")!;
    expect(iso.example).toBe("2024-01-15");
  });

  it("time 24h shows '13:30:00'", () => {
    const time = cats.find((c) => c.id === "time")!;
    const t24 = time.formats.find((f) => f.value === "time_24h")!;
    expect(t24.example).toBe("13:30:00");
  });

  it("time 12h shows '1:30:00 PM'", () => {
    const time = cats.find((c) => c.id === "time")!;
    const t12 = time.formats.find((f) => f.value === "time_12h")!;
    expect(t12.example).toBe("1:30:00 PM");
  });
});

// ============================================================================
// Locale-specific: Swedish
// ============================================================================

describe("Swedish locale (dec=',', thou=' ')", () => {
  const cats = getNumberFormatCategories(",", " ");

  it("number_sep uses space thousands and comma decimal", () => {
    const num = cats.find((c) => c.id === "number")!;
    expect(num.formats.find((f) => f.value === "number_sep")!.example).toBe("1 234,00");
  });

  it("currency SEK shows '1 234,00 kr'", () => {
    const cur = cats.find((c) => c.id === "currency")!;
    expect(cur.formats.find((f) => f.value === "currency_sek")!.example).toBe("1 234,00 kr");
  });

  it("percentage uses comma decimal", () => {
    const pct = cats.find((c) => c.id === "percentage")!;
    expect(pct.formats[0].example).toBe("12,00%");
  });

  it("accounting USD uses space thousands", () => {
    const acct = cats.find((c) => c.id === "accounting")!;
    expect(acct.formats.find((f) => f.value === "accounting_usd")!.example).toBe("$ 1 234,00");
  });

  it("custom #,##0.00 uses Swedish separators", () => {
    const custom = cats.find((c) => c.id === "custom")!;
    expect(custom.formats.find((f) => f.value === "#,##0.00")!.example).toBe("1 234,50");
  });
});

// ============================================================================
// Locale-specific: German
// ============================================================================

describe("German locale (dec=',', thou='.')", () => {
  const cats = getNumberFormatCategories(",", ".");

  it("number_sep uses dot thousands and comma decimal", () => {
    const num = cats.find((c) => c.id === "number")!;
    expect(num.formats.find((f) => f.value === "number_sep")!.example).toBe("1.234,00");
  });

  it("currency EUR shows 'EUR 1.234,00'", () => {
    const cur = cats.find((c) => c.id === "currency")!;
    expect(cur.formats.find((f) => f.value === "currency_eur")!.example).toBe("EUR 1.234,00");
  });

  it("general shows '1234,5'", () => {
    const gen = cats.find((c) => c.id === "general")!;
    expect(gen.formats[0].example).toBe("1234,5");
  });

  it("accounting no-decimals shows '$ 1.234'", () => {
    const acct = cats.find((c) => c.id === "accounting")!;
    expect(acct.formats.find((f) => f.value === "accounting_usd_0")!.example).toBe("$ 1.234");
  });
});

// ============================================================================
// Locale-specific: English (default)
// ============================================================================

describe("English locale (default)", () => {
  const cats = getNumberFormatCategories();

  it("uses period as decimal and comma as thousands by default", () => {
    const num = cats.find((c) => c.id === "number")!;
    expect(num.formats.find((f) => f.value === "number_sep")!.example).toBe("1,234.00");
    expect(num.formats.find((f) => f.value === "number")!.example).toBe("1234.00");
  });
});

// ============================================================================
// Custom format patterns
// ============================================================================

describe("custom format patterns", () => {
  const cats = getNumberFormatCategories();
  const custom = cats.find((c) => c.id === "custom")!;

  it("contains integer-only format '#,##0'", () => {
    const f = custom.formats.find((fmt) => fmt.value === "#,##0");
    expect(f).toBeDefined();
    expect(f!.example).toBe("1,235");
  });

  it("contains negative-in-parens format '#,##0;(#,##0)'", () => {
    const f = custom.formats.find((fmt) => fmt.value === "#,##0;(#,##0)");
    expect(f).toBeDefined();
  });

  it("contains red-negative format '#,##0;[Red](#,##0)'", () => {
    const f = custom.formats.find((fmt) => fmt.value === "#,##0;[Red](#,##0)");
    expect(f).toBeDefined();
  });

  it("contains hidden format ';;;'", () => {
    const f = custom.formats.find((fmt) => fmt.value === ";;;");
    expect(f).toBeDefined();
    expect(f!.example).toBe("(hidden)");
  });

  it("contains currency custom '$#,##0.00'", () => {
    const f = custom.formats.find((fmt) => fmt.value === "$#,##0.00");
    expect(f).toBeDefined();
    expect(f!.example).toContain("$");
  });

  it("contains kr suffix format", () => {
    const f = custom.formats.find((fmt) => fmt.value === '0.00" kr"');
    expect(f).toBeDefined();
    expect(f!.example).toContain("kr");
  });
});

// ============================================================================
// Scientific notation
// ============================================================================

describe("scientific notation formats", () => {
  const cats = getNumberFormatCategories();

  it("scientific category has exactly one preset", () => {
    const sci = cats.find((c) => c.id === "scientific")!;
    expect(sci.formats).toHaveLength(1);
  });

  it("scientific example uses E+ notation", () => {
    const sci = cats.find((c) => c.id === "scientific")!;
    expect(sci.formats[0].example).toMatch(/E\+/);
  });

  it("custom category also includes scientific format '0.00E+00'", () => {
    const custom = cats.find((c) => c.id === "custom")!;
    const f = custom.formats.find((fmt) => fmt.value === "0.00E+00");
    expect(f).toBeDefined();
    expect(f!.example).toBe("1.23E+03");
  });
});

// ============================================================================
// Fraction formats
// ============================================================================

describe("fraction formats", () => {
  const cats = getNumberFormatCategories();
  const fraction = cats.find((c) => c.id === "fraction")!;

  it("fraction category has 9 presets", () => {
    expect(fraction.formats).toHaveLength(9);
  });

  it("fraction examples contain a slash character", () => {
    for (const fmt of fraction.formats) {
      expect(fmt.example).toContain("/");
    }
  });

  it("halves preset shows '1234 1/2'", () => {
    const f = fraction.formats.find((fmt) => fmt.value === "fraction_halves");
    expect(f).toBeDefined();
    expect(f!.example).toBe("1234 1/2");
  });

  it("hundredths preset shows '1234 50/100'", () => {
    const f = fraction.formats.find((fmt) => fmt.value === "fraction_hundredths");
    expect(f).toBeDefined();
    expect(f!.example).toBe("1234 50/100");
  });

  it("all fraction values are unique", () => {
    const values = fraction.formats.map((f) => f.value);
    expect(new Set(values).size).toBe(values.length);
  });
});

// ============================================================================
// Percentage with varying decimal places
// ============================================================================

describe("percentage formats", () => {
  const cats = getNumberFormatCategories();

  it("percentage category has at least one format", () => {
    const pct = cats.find((c) => c.id === "percentage")!;
    expect(pct.formats.length).toBeGreaterThanOrEqual(1);
  });

  it("percentage example ends with '%'", () => {
    const pct = cats.find((c) => c.id === "percentage")!;
    for (const fmt of pct.formats) {
      expect(fmt.example).toMatch(/%$/);
    }
  });

  it("custom category has 0% and 0.00% formats", () => {
    const custom = cats.find((c) => c.id === "custom")!;
    expect(custom.formats.find((f) => f.value === "0%")).toBeDefined();
    expect(custom.formats.find((f) => f.value === "0.00%")).toBeDefined();
  });

  it("0% custom example shows '50%'", () => {
    const custom = cats.find((c) => c.id === "custom")!;
    const f = custom.formats.find((fmt) => fmt.value === "0%")!;
    expect(f.example).toBe("50%");
  });

  it("0.00% custom example shows '50.00%'", () => {
    const custom = cats.find((c) => c.id === "custom")!;
    const f = custom.formats.find((fmt) => fmt.value === "0.00%")!;
    expect(f.example).toBe("50.00%");
  });
});

// ============================================================================
// Date/time format variety
// ============================================================================

describe("date and time format variety", () => {
  const cats = getNumberFormatCategories();

  it("date category has ISO, US, and EU formats", () => {
    const date = cats.find((c) => c.id === "date")!;
    const values = date.formats.map((f) => f.value);
    expect(values).toContain("date_iso");
    expect(values).toContain("date_us");
    expect(values).toContain("date_eu");
  });

  it("date US format shows MM/DD/YYYY", () => {
    const date = cats.find((c) => c.id === "date")!;
    const us = date.formats.find((f) => f.value === "date_us")!;
    expect(us.example).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
  });

  it("date EU format shows DD/MM/YYYY", () => {
    const date = cats.find((c) => c.id === "date")!;
    const eu = date.formats.find((f) => f.value === "date_eu")!;
    expect(eu.example).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
  });

  it("time category has both 24h and 12h formats", () => {
    const time = cats.find((c) => c.id === "time")!;
    const values = time.formats.map((f) => f.value);
    expect(values).toContain("time_24h");
    expect(values).toContain("time_12h");
  });

  it("12h time contains AM or PM", () => {
    const time = cats.find((c) => c.id === "time")!;
    const t12 = time.formats.find((f) => f.value === "time_12h")!;
    expect(t12.example).toMatch(/[AP]M/);
  });
});
