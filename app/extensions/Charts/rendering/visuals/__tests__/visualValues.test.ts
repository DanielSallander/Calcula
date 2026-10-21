//! FILENAME: app/extensions/Charts/rendering/visuals/__tests__/visualValues.test.ts
// PURPOSE: The one number (or text) a tile visual shows, and how it is written:
//          Power BI's display units "Auto" (11,732 -> "12K"), the SOURCE text
//          when the value is text or the units are "none", and the aggregate
//          that turns a many-row field into one value.
// CONTEXT: The defect this file exists to keep out is the reader's own: a Card
//          over a text cell showed "0", because the chart model holds numbers
//          only and the parser writes 0 for anything it cannot read. A card
//          that says "0" with no error is a confident wrong answer.

import { describe, it, expect } from "vitest";
import type { ParsedChartData } from "../../../types";
import {
  aggregateSeries,
  formatVisualNumber,
  formatVisualValue,
  isTextDatum,
  visualFormatFor,
  BLANK_TEXT,
} from "../visualValues";
import { useAppLocale, useInvariantLocale } from "../../../lib/__tests__/appLocaleTestKit";

describe("visualFormatFor: a Data format the author chose is honoured unless units were chosen too", () => {
  it("unset units + a format for the series' measure -> 'none' (the formatted source text is written)", () => {
    expect(visualFormatFor({ fieldFormats: { Revenue: "#,##0.00" } }, {}, "Revenue").displayUnits).toBe("none");
    // A column-field series name ("Europe - Revenue") and a bracketed caption name the same measure.
    expect(visualFormatFor({ fieldFormats: { Revenue: "0.0" } }, {}, "Europe - Revenue").displayUnits).toBe("none");
    expect(visualFormatFor({ fieldFormats: { Revenue: "0.0" } }, {}, "[Revenue]").displayUnits).toBe("none");
  });

  it("chosen units win; no format, another measure's format, or an empty code leave Auto (undefined)", () => {
    expect(visualFormatFor({ fieldFormats: { Revenue: "0.0" } }, { displayUnits: "millions" }, "Revenue").displayUnits).toBe("millions");
    expect(visualFormatFor({ fieldFormats: { Revenue: "0.0" } }, { displayUnits: "auto" }, "Revenue").displayUnits).toBe("auto");
    expect(visualFormatFor({}, {}, "Revenue").displayUnits).toBeUndefined();
    expect(visualFormatFor({ fieldFormats: { Cost: "0.0" } }, {}, "Revenue").displayUnits).toBeUndefined();
    expect(visualFormatFor({ fieldFormats: { Revenue: "" } }, {}, "Revenue").displayUnits).toBeUndefined();
    expect(visualFormatFor({ fieldFormats: { Revenue: "0.0" } }, { decimals: 2 }, "Revenue")).toEqual({ displayUnits: "none", decimals: 2 });
  });
});

function data(values: number[], displayValues?: string[]): ParsedChartData {
  return {
    categories: values.map((_v, i) => `C${i}`),
    series: [{ name: "Sales", values, color: null }],
    ...(displayValues ? { displayValues: [displayValues] } : {}),
  };
}

describe("formatVisualNumber: Power BI display units", () => {
  it("Auto writes 11,732 as 12K (the documented example)", () => {
    expect(formatVisualNumber(11732, { displayUnits: "auto" })).toBe("12K");
  });

  it("Auto keeps one decimal below ten of a unit, and drops a .0", () => {
    expect(formatVisualNumber(1234, { displayUnits: "auto" })).toBe("1.2K");
    expect(formatVisualNumber(2000, { displayUnits: "auto" })).toBe("2K");
    expect(formatVisualNumber(4_560_000, { displayUnits: "auto" })).toBe("4.6M");
    expect(formatVisualNumber(7_100_000_000, { displayUnits: "auto" })).toBe("7.1bn");
    expect(formatVisualNumber(3e12, { displayUnits: "auto" })).toBe("3T");
  });

  it("Auto leaves a number under a thousand as it is", () => {
    expect(formatVisualNumber(845, { displayUnits: "auto" })).toBe("845");
    expect(formatVisualNumber(12.5, { displayUnits: "auto" })).toBe("12.5");
  });

  it("negative numbers keep their sign through the unit", () => {
    expect(formatVisualNumber(-11732, { displayUnits: "auto" })).toBe("-12K");
  });

  it("a forced unit scales even a small number", () => {
    expect(formatVisualNumber(250, { displayUnits: "thousands", decimals: 2 })).toBe("0.25K");
    expect(formatVisualNumber(1_500_000, { displayUnits: "thousands" })).toBe("1,500K");
  });

  it("explicit decimals win over the automatic rule", () => {
    expect(formatVisualNumber(11732, { displayUnits: "auto", decimals: 2 })).toBe("11.73K");
    expect(formatVisualNumber(11732, { displayUnits: "none", decimals: 1 })).toBe("11,732.0");
  });

  it("'none' shows the SOURCE text, so a currency cell keeps its format", () => {
    expect(formatVisualNumber(1234.5, { displayUnits: "none", sourceText: "$1,234.50" })).toBe("$1,234.50");
  });

  it("a scaled value keeps the source's currency prefix and suffix", async () => {
    expect(formatVisualNumber(11732, { displayUnits: "auto", sourceText: "$11,732.00" })).toBe("$12K");
    // "25 000 kr" is sv-SE text: the engine writes it only under an sv-SE app
    // locale, and it is read as a number only there (P2 S8).
    await useAppLocale("sv-SE");
    try {
      expect(formatVisualNumber(25000, { displayUnits: "auto", sourceText: "25 000 kr" })).toBe("25K kr");
    } finally {
      await useInvariantLocale();
    }
  });

  it("a percent is never scaled into nonsense like '1.2K%'", () => {
    expect(formatVisualNumber(0.45, { displayUnits: "auto", sourceText: "45%" })).toBe("45%");
  });
});

describe("text values are shown as text, never as 0", () => {
  it("isTextDatum reads the source text, not the 0 the parser wrote", () => {
    const d = data([0], ["North"]);
    expect(isTextDatum(d, 0, 0)).toBe(true);
    expect(isTextDatum(data([5], ["5"]), 0, 0)).toBe(false);
    expect(isTextDatum(data([0]), 0, 0)).toBe(false);
  });

  it("a card over one text cell shows the text", () => {
    const v = aggregateSeries(data([0], ["North"]), 0, "auto");
    expect(formatVisualValue(v, {})).toBe("North");
  });

  it("a text FIELD of many rows shows its first value (Power BI's First for text)", () => {
    const v = aggregateSeries(data([0, 0], ["North", "South"]), 0, "auto");
    expect(v.categoryIndex).toBe(0);
    expect(formatVisualValue(v, {})).toBe("North");
  });

  it("an empty field is (Blank), not 0", () => {
    const v = aggregateSeries({ categories: [], series: [{ name: "S", values: [], color: null }] }, 0, "auto");
    expect(v.value).toBeNull();
    expect(formatVisualValue(v, {})).toBe(BLANK_TEXT);
  });
});

describe("aggregateSeries", () => {
  it("auto: one datum is shown as it is, with its own source text", () => {
    const v = aggregateSeries(data([1234.5], ["$1,234.50"]), 0, "auto");
    expect(v).toEqual({ value: 1234.5, text: "$1,234.50", categoryIndex: 0 });
  });

  it("auto: many numbers are summed (no single datum, no source text)", () => {
    const v = aggregateSeries(data([10, 20, 30]), 0, "auto");
    expect(v).toEqual({ value: 60, text: null, categoryIndex: -1 });
  });

  it("first / last name a datum; average / min / max / count compute", () => {
    const d = data([10, 20, 30], ["10", "20", "30"]);
    expect(aggregateSeries(d, 0, "first")).toEqual({ value: 10, text: "10", categoryIndex: 0 });
    expect(aggregateSeries(d, 0, "last")).toEqual({ value: 30, text: "30", categoryIndex: 2 });
    expect(aggregateSeries(d, 0, "average").value).toBe(20);
    expect(aggregateSeries(d, 0, "min").value).toBe(10);
    expect(aggregateSeries(d, 0, "max").value).toBe(30);
    expect(aggregateSeries(d, 0, "count").value).toBe(3);
  });

  it("a sum skips text rows instead of counting them as 0s it never saw", () => {
    const d = data([10, 0, 30], ["10", "n/a", "30"]);
    expect(aggregateSeries(d, 0, "average").value).toBe(20);
  });
});
