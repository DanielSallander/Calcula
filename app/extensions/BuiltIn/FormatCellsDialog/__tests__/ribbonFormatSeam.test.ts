//! FILENAME: app/extensions/BuiltIn/FormatCellsDialog/__tests__/ribbonFormatSeam.test.ts
// PURPOSE: The seam between Home > Number and Format Cells > Number.
// CONTEXT: Two surfaces apply the same formats and both have to report what a
//          cell already carries. They speak different vocabularies to do it:
//          the ribbon sends PRESET KEYWORDS ("date_short") and reads back
//          DISPLAY NAMES ("Date (YYYY-MM-DD)"), and the dialog highlights a row
//          whose value is a preset. The mapping between them is regional, and
//          it is owned by Rust.
//
//          The ribbon asks the backend for it. The dialog used to invert it in
//          TypeScript, in `DISPLAY_NAME_TO_PRESET`, and so went blind the
//          moment the ribbon gained an entry that table did not list --
//          measured on sv-SE: Short Date, Long Date and Currency each opened
//          the dialog on the right category with NOTHING highlighted.
//
//          `SV_SE_RIBBON` below is not invented. It is what
//          `get_ribbon_number_formats` returns on this app's test locale,
//          transcribed from the item-1 pass's live measurement through the real
//          ribbon `<select>`.

import { describe, it, expect } from "vitest";
import {
  normalizeToPresetValue,
  categoryForFormat,
  withRibbonPresets,
  getNumberFormatCategories,
  type RibbonResolvedFormat,
} from "../utils/numberFormats";

/** Measured sv-SE output of `get_ribbon_number_formats`, sample 1234.5678. */
const SV_SE_RIBBON: RibbonResolvedFormat[] = [
  { preset: "general", displayName: "General", sample: "1234,5678" },
  { preset: "number", displayName: "Number (2 decimals)", sample: "1234,57" },
  { preset: "currency", displayName: "Currency ( kr, 2 decimals)", sample: "1 234,57 kr" },
  { preset: "accounting", displayName: "Accounting (kr, 2 decimals)", sample: "1 234,57  kr" },
  { preset: "date_short", displayName: "Date (YYYY-MM-DD)", sample: "2024-01-15" },
  { preset: "date_long", displayName: 'Date ("den "d mmmm yyyy)', sample: "den 15 januari 2024" },
  { preset: "time", displayName: "Time (hh:mm:ss)", sample: "13:30:00" },
  { preset: "percentage", displayName: "Percentage (2 decimals)", sample: "123456,78%" },
  { preset: "fraction_1", displayName: "Fraction (up to 1 digits)", sample: "1234 4/7" },
  { preset: "scientific", displayName: "Scientific (2 decimals)", sample: "1,23E+03" },
  { preset: "text", displayName: "@", sample: "1234,5678" },
];

/** en-US, where the regional entries resolve to entirely different strings. */
const EN_US_RIBBON: RibbonResolvedFormat[] = [
  { preset: "general", displayName: "General" },
  { preset: "number", displayName: "Number (2 decimals)" },
  { preset: "currency", displayName: "Currency ($, 2 decimals)" },
  { preset: "accounting", displayName: "Accounting ($, 2 decimals)" },
  { preset: "date_short", displayName: "Date (MM/DD/YYYY)" },
  { preset: "date_long", displayName: "Date (dddd, mmmm dd, yyyy)" },
  { preset: "time", displayName: "Time (h:mm:ss AM/PM)" },
  { preset: "percentage", displayName: "Percentage (2 decimals)" },
  { preset: "fraction_1", displayName: "Fraction (up to 1 digits)" },
  { preset: "scientific", displayName: "Scientific (2 decimals)" },
  { preset: "text", displayName: "@" },
];

const categoriesFor = (ribbon: RibbonResolvedFormat[]) =>
  withRibbonPresets(getNumberFormatCategories(",", " "), ribbon);

/** Every preset the dialog can actually light up, across all its categories. */
function highlightablePresets(ribbon: RibbonResolvedFormat[]): Set<string> {
  const out = new Set<string>();
  for (const cat of categoriesFor(ribbon)) {
    for (const f of cat.formats) out.add(f.value);
  }
  return out;
}

describe("the dialog can report every format the ribbon can apply", () => {
  for (const [locale, ribbon] of [
    ["sv-SE", SV_SE_RIBBON],
    ["en-US", EN_US_RIBBON],
  ] as const) {
    it(`${locale}: all eleven ribbon entries resolve to a HIGHLIGHTABLE row`, () => {
      const rows = highlightablePresets(ribbon);
      for (const entry of ribbon) {
        // 1. The display name the cell reads back as must resolve to a preset.
        const preset = normalizeToPresetValue(entry.displayName, ribbon);
        expect(preset, `${entry.preset} -> ${entry.displayName} must resolve`).not.toBeNull();

        // 2. And that preset must be a row that exists, or nothing lights up.
        //    This is the half a resolver-only fix would have missed: Long Date
        //    resolved to `date_long` and still had no row to select.
        expect(
          rows.has(preset as string),
          `${entry.preset} resolved to "${preset}" but no category row carries that value`
        ).toBe(true);

        // 3. And it must land in a category, never fall through to Custom.
        expect(categoryForFormat(entry.displayName, ribbon)).not.toBe("custom");
      }
    });
  }

  it("sv-SE: the three that were BLIND now resolve, and to the right thing", () => {
    // The measured regression, named individually so a partial revert is loud.
    expect(normalizeToPresetValue("Date (YYYY-MM-DD)", SV_SE_RIBBON)).toBe("date_short");
    expect(normalizeToPresetValue('Date ("den "d mmmm yyyy)', SV_SE_RIBBON)).toBe("date_long");
    expect(normalizeToPresetValue("Currency ( kr, 2 decimals)", SV_SE_RIBBON)).toBe("currency");

    expect(categoryForFormat("Date (YYYY-MM-DD)", SV_SE_RIBBON)).toBe("date");
    expect(categoryForFormat('Date ("den "d mmmm yyyy)', SV_SE_RIBBON)).toBe("date");
    expect(categoryForFormat("Currency ( kr, 2 decimals)", SV_SE_RIBBON)).toBe("currency");
  });

  it("the regional rows sit at the TOP of their list, as Excel puts them", () => {
    const cats = categoriesFor(SV_SE_RIBBON);
    const date = cats.find((c) => c.id === "date");
    expect(date?.formats[0]?.value).toBe("date_short");
    expect(date?.formats[1]?.value).toBe("date_long");
    // And they carry the backend's own sample, not a re-derived one.
    expect(date?.formats[0]?.example).toBe("2024-01-15");
    expect(date?.formats[1]?.example).toBe("den 15 januari 2024");

    const currency = cats.find((c) => c.id === "currency");
    expect(currency?.formats[0]?.value).toBe("currency");
  });

  it("Excel's Text category exists and the ribbon's Text entry lands in it", () => {
    // `@` used to fall through to Custom, so the dialog described the user's
    // own dropdown choice as a hand-written format code.
    expect(categoryForFormat("@", SV_SE_RIBBON)).toBe("text");
    expect(normalizeToPresetValue("@", SV_SE_RIBBON)).toBe("text");
    expect(categoriesFor(SV_SE_RIBBON).some((c) => c.id === "text")).toBe(true);
  });
});

describe("what must NOT change", () => {
  it("case is not significant, because it is not significant to the engine", () => {
    // `Date (YYYY-MM-DD)` and `Date (yyyy-mm-dd)` are the same pattern to the
    // engine's (case-insensitive, post-BUG-0061) date formatter. With no ribbon
    // response at all, both still resolve through the static fallback.
    expect(normalizeToPresetValue("Date (yyyy-mm-dd)")).toBe("date_iso");
    expect(normalizeToPresetValue("Date (YYYY-MM-DD)")).toBe("date_iso");
  });

  it("BUG-0065's display names still resolve with no ribbon response", () => {
    // The offline fallback is intact: a dialog opened before the backend
    // answers behaves exactly as it did.
    expect(normalizeToPresetValue("Number (2 decimals, with separators)")).toBe("number_sep");
    expect(normalizeToPresetValue("Accounting (kr, 2 decimals)")).toBe("accounting_sek");
    expect(normalizeToPresetValue("Percentage (2 decimals)")).toBe("percentage");
    expect(categoryForFormat("Number (5 decimals)")).toBe("number");
  });

  it("a genuinely custom format is still Custom", () => {
    expect(categoryForFormat("#,##0.0,;[Red](#,##0.0,)", SV_SE_RIBBON)).toBe("custom");
    expect(normalizeToPresetValue("#,##0.0,;[Red](#,##0.0,)", SV_SE_RIBBON)).toBeNull();
  });

  it("no ribbon response leaves the category list exactly as it was", () => {
    const plain = getNumberFormatCategories(",", " ");
    expect(withRibbonPresets(plain, [])).toEqual(plain);
  });

  it("folding the ribbon in twice does not duplicate a row", () => {
    const once = categoriesFor(SV_SE_RIBBON);
    const twice = withRibbonPresets(once, SV_SE_RIBBON);
    expect(twice).toEqual(once);
  });
});
