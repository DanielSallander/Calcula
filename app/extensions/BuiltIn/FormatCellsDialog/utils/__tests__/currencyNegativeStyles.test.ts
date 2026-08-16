//! FILENAME: app/extensions/BuiltIn/FormatCellsDialog/utils/__tests__/currencyNegativeStyles.test.ts
// PURPOSE: Pin Excel's four "Negative numbers:" entries across the dialog seam
//          (open-items 1.1).
//
// WHAT THIS EXISTS TO CATCH. The dialog carries ONE string, so a currency's
// symbol and its negative entry are composed into it (`currency_usd` +
// `_neg_paren`) and taken apart again on the way back. Three separate tables
// have to agree for that to work -- the suffixes here, `NEGATIVE_STYLE_SUFFIXES`
// in `app/src-tauri/src/commands/styles.rs`, and `NegativeStyle::display_suffix`
// in `core/engine/src/style.rs` -- and a disagreement between any two of them
// is silent: the user picks "red parenthesised", presses OK, and the choice is
// reset to the default with no error anywhere. That is the exact shape of
// BUG-0065 and BUG-0069, which is why the spellings are asserted literally here
// rather than derived from the code under test.

import { describe, it, expect } from "vitest";
import {
  NEGATIVE_STYLE_OPTIONS,
  negativeSample,
  splitNegativeSuffix,
  normalizeToPresetValue,
  categoryForFormat,
} from "../numberFormats";

describe("Excel's four negative-number entries", () => {
  it("are four, in Excel's order, and the default carries no suffix", () => {
    expect(NEGATIVE_STYLE_OPTIONS.map((o) => o.suffix)).toEqual([
      "",
      "_neg_red",
      "_neg_paren",
      "_neg_red_paren",
    ]);
    // Excel's order is: minus, red, parens, red parens.
    expect(NEGATIVE_STYLE_OPTIONS.map((o) => [o.red, o.parentheses])).toEqual([
      [false, false],
      [true, false],
      [false, true],
      [true, true],
    ]);
  });

  it("renders the samples Excel renders, including its unsigned red entry", () => {
    const [minus, red, parens, redParens] = NEGATIVE_STYLE_OPTIONS;
    expect(negativeSample("$1,234.00", minus)).toBe("-$1,234.00");
    // Excel's red entry has NO sign: the colour is the whole marker.
    expect(negativeSample("$1,234.00", red)).toBe("$1,234.00");
    expect(negativeSample("$1,234.00", parens)).toBe("($1,234.00)");
    expect(negativeSample("$1,234.00", redParens)).toBe("($1,234.00)");
  });
});

describe("splitting a composed preset value", () => {
  it("takes the LONGEST suffix, so red-parens is never read as red", () => {
    expect(splitNegativeSuffix("currency_usd_neg_red_paren")).toEqual({
      base: "currency_usd",
      suffix: "_neg_red_paren",
    });
    expect(splitNegativeSuffix("currency_usd_neg_red")).toEqual({
      base: "currency_usd",
      suffix: "_neg_red",
    });
    expect(splitNegativeSuffix("currency_usd_neg_paren")).toEqual({
      base: "currency_usd",
      suffix: "_neg_paren",
    });
  });

  it("leaves a preset with no negative choice exactly as it was", () => {
    expect(splitNegativeSuffix("currency_usd")).toEqual({
      base: "currency_usd",
      suffix: "",
    });
    expect(splitNegativeSuffix("accounting_sek")).toEqual({
      base: "accounting_sek",
      suffix: "",
    });
  });
});

describe("recognising the format a cell already carries", () => {
  it("resolves the display name the backend emits back to its composed preset", () => {
    expect(
      normalizeToPresetValue("Currency ($, 2 decimals, parenthesised negatives)")
    ).toBe("currency_usd_neg_paren");
    expect(
      normalizeToPresetValue("Currency ($, 2 decimals, red parenthesised negatives)")
    ).toBe("currency_usd_neg_red_paren");
    expect(normalizeToPresetValue("Currency (kr, 2 decimals, symbol after, red negatives)")).toBe(
      "currency_sek_neg_red"
    );
    // The default entry's name is unchanged -- that is the point of the empty
    // suffix, and a currency cell formatted before this list existed must not
    // start reading as something else.
    expect(normalizeToPresetValue("Currency ($, 2 decimals)")).toBe("currency_usd");
  });

  it("accepts a composed preset value as already normalised", () => {
    expect(normalizeToPresetValue("currency_eur_neg_paren")).toBe(
      "currency_eur_neg_paren"
    );
  });

  it("keeps every composed value in the Currency category", () => {
    for (const base of ["currency_usd", "currency_eur", "currency_sek"]) {
      for (const option of NEGATIVE_STYLE_OPTIONS) {
        expect(categoryForFormat(`${base}${option.suffix}`)).toBe("currency");
      }
    }
    expect(
      categoryForFormat("Currency ($, 2 decimals, red parenthesised negatives)")
    ).toBe("currency");
  });

  it("resolves the REGIONAL row too, whose name only the backend knows", () => {
    // No static table can hold `Currency ( kr, 2 decimals)` -- it is resolved
    // per locale -- so the negative clause must be stripped before the ribbon
    // response is consulted, not after.
    const ribbon = [
      { preset: "currency", displayName: "Currency ( kr, 2 decimals, symbol after)" },
    ];
    expect(
      normalizeToPresetValue(
        "Currency ( kr, 2 decimals, symbol after, parenthesised negatives)",
        ribbon
      )
    ).toBe("currency_neg_paren");
    expect(
      categoryForFormat("Currency ( kr, 2 decimals, symbol after, parenthesised negatives)", ribbon)
    ).toBe("currency");
  });

  it("does not invent a preset for a name that has no symbol half", () => {
    expect(
      normalizeToPresetValue("Currency (¥, 2 decimals, red negatives)")
    ).toBeNull();
  });
});
