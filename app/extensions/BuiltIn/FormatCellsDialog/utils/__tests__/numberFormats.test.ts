//! FILENAME: app/extensions/BuiltIn/FormatCellsDialog/utils/__tests__/numberFormats.test.ts
// PURPOSE: Tests for the number format categories and locale-aware formatting.

import { describe, it, expect } from "vitest";
import {
  getNumberFormatCategories,
  NUMBER_FORMAT_CATEGORIES,
} from "../numberFormats";

describe("numberFormats", () => {
  describe("NUMBER_FORMAT_CATEGORIES (default US locale)", () => {
    it("contains expected category IDs", () => {
      const ids = NUMBER_FORMAT_CATEGORIES.map((c) => c.id);
      expect(ids).toContain("general");
      expect(ids).toContain("number");
      expect(ids).toContain("currency");
      expect(ids).toContain("percentage");
      expect(ids).toContain("scientific");
      expect(ids).toContain("date");
      expect(ids).toContain("time");
      expect(ids).toContain("accounting");
      expect(ids).toContain("fraction");
      expect(ids).toContain("special");
      expect(ids).toContain("custom");
    });

    it("every category has at least one format", () => {
      for (const cat of NUMBER_FORMAT_CATEGORIES) {
        expect(cat.formats.length).toBeGreaterThan(0);
      }
    });

    it("every format has a label and value", () => {
      for (const cat of NUMBER_FORMAT_CATEGORIES) {
        for (const fmt of cat.formats) {
          expect(fmt.label).toBeTruthy();
          expect(fmt.value).toBeTruthy();
        }
      }
    });

    it("uses US-style separators in examples", () => {
      const numberCat = NUMBER_FORMAT_CATEGORIES.find((c) => c.id === "number")!;
      const sepFormat = numberCat.formats.find((f) => f.value === "number_sep")!;
      expect(sepFormat.example).toBe("1,234.00");
    });
  });

  describe("getNumberFormatCategories with custom separators", () => {
    it("uses Swedish-style separators (space + comma)", () => {
      const cats = getNumberFormatCategories(",", " ");
      const numberCat = cats.find((c) => c.id === "number")!;
      const sepFormat = numberCat.formats.find((f) => f.value === "number_sep")!;
      // "1,234.00" with dec="," thou=" " -> "1 234,00"
      expect(sepFormat.example).toBe("1 234,00");
    });

    it("uses German-style separators (comma + period)", () => {
      const cats = getNumberFormatCategories(",", ".");
      const numberCat = cats.find((c) => c.id === "number")!;
      const basicFormat = numberCat.formats.find((f) => f.value === "number")!;
      expect(basicFormat.example).toBe("1234,00");
    });

    it("currency examples use custom separators", () => {
      const cats = getNumberFormatCategories(",", ".");
      const currencyCat = cats.find((c) => c.id === "currency")!;
      const usd = currencyCat.formats.find((f) => f.value === "currency_usd")!;
      expect(usd.example).toBe("$1.234,00");
    });

    it("general category has exactly one format", () => {
      const cats = getNumberFormatCategories();
      const general = cats.find((c) => c.id === "general")!;
      expect(general.formats).toHaveLength(1);
      expect(general.formats[0].value).toBe("general");
    });
  });

  describe("Swedish locale (space as thousands, comma as decimal)", () => {
    const cats = getNumberFormatCategories(",", " ");

    it("number format uses space as thousands separator", () => {
      const numberCat = cats.find((c) => c.id === "number")!;
      const sepFormat = numberCat.formats.find((f) => f.value === "number_sep")!;
      expect(sepFormat.example).toBe("1 234,00");
    });

    it("number format without thousands uses comma decimal", () => {
      const numberCat = cats.find((c) => c.id === "number")!;
      const basicFormat = numberCat.formats.find((f) => f.value === "number")!;
      expect(basicFormat.example).toBe("1234,00");
    });

    it("currency SEK uses Swedish separators", () => {
      const currencyCat = cats.find((c) => c.id === "currency")!;
      const sek = currencyCat.formats.find((f) => f.value === "currency_sek")!;
      expect(sek.example).toBe("1 234,00 kr");
    });

    it("percentage uses comma as decimal", () => {
      const pctCat = cats.find((c) => c.id === "percentage")!;
      expect(pctCat.formats[0].example).toBe("12,00%");
    });

    it("accounting SEK uses Swedish separators", () => {
      const acctCat = cats.find((c) => c.id === "accounting")!;
      const sek = acctCat.formats.find((f) => f.value === "accounting_sek")!;
      expect(sek.example).toBe("1 234,00 kr");
    });

    it("custom format examples use Swedish separators", () => {
      const customCat = cats.find((c) => c.id === "custom")!;
      const fmtWithSep = customCat.formats.find((f) => f.value === "#,##0.00")!;
      expect(fmtWithSep.example).toBe("1 234,50");
    });
  });

  describe("German locale (dot as thousands, comma as decimal)", () => {
    const cats = getNumberFormatCategories(",", ".");

    it("number with thousands uses dot separator", () => {
      const numberCat = cats.find((c) => c.id === "number")!;
      const sepFormat = numberCat.formats.find((f) => f.value === "number_sep")!;
      expect(sepFormat.example).toBe("1.234,00");
    });

    it("number without thousands uses comma decimal", () => {
      const numberCat = cats.find((c) => c.id === "number")!;
      const basicFormat = numberCat.formats.find((f) => f.value === "number")!;
      expect(basicFormat.example).toBe("1234,00");
    });

    it("currency USD uses German separators", () => {
      const currencyCat = cats.find((c) => c.id === "currency")!;
      const usd = currencyCat.formats.find((f) => f.value === "currency_usd")!;
      expect(usd.example).toBe("$1.234,00");
    });

    it("currency EUR uses German separators", () => {
      const currencyCat = cats.find((c) => c.id === "currency")!;
      const eur = currencyCat.formats.find((f) => f.value === "currency_eur")!;
      expect(eur.example).toBe("EUR 1.234,00");
    });

    it("general format uses German decimal", () => {
      const generalCat = cats.find((c) => c.id === "general")!;
      expect(generalCat.formats[0].example).toBe("1234,5");
    });

    it("accounting formats use German separators", () => {
      const acctCat = cats.find((c) => c.id === "accounting")!;
      const usd = acctCat.formats.find((f) => f.value === "accounting_usd")!;
      expect(usd.example).toBe("$ 1.234,00");
      const noDecimals = acctCat.formats.find((f) => f.value === "accounting_usd_0")!;
      expect(noDecimals.example).toBe("$ 1.234");
    });
  });

  describe("category metadata", () => {
    it("every category has a non-empty description", () => {
      for (const cat of NUMBER_FORMAT_CATEGORIES) {
        expect(cat.description.length).toBeGreaterThan(10);
      }
    });

    it("every category has a non-empty label", () => {
      for (const cat of NUMBER_FORMAT_CATEGORIES) {
        expect(cat.label).toBeTruthy();
      }
    });

    it("category IDs are unique", () => {
      const ids = NUMBER_FORMAT_CATEGORIES.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });
});
