//! FILENAME: app/extensions/Charts/rendering/visuals/__tests__/visualValues.locale.test.ts
// PURPOSE: BUG-0447 -- the tile visuals (Card, Multi-row card, KPI, Gauge) write
//          their numbers in the APP locale (P2 S8). The formatter used to
//          hard-code "," grouping and a "." point, so a de-DE Card read
//          "1.2K" and "1,234.50" while the grid beside it read "1,2" and
//          "1.234,50".
// CONTEXT: The locales come from the shared Rust <-> TS corpus
//          (appLocaleTestKit), so these are the separators the backend sends.
//          Under the invariant locale the existing visualValues tests run
//          unchanged; this file covers the other locales.

import { describe, it, expect, afterEach } from "vitest";
import { formatVisualNumber, formatVisualValue, aggregateSeries } from "../visualValues";
import { visualSpec, seriesData, paintVisual, textsOf } from "./visualTestKit";
import { useAppLocale, useInvariantLocale } from "../../../lib/__tests__/appLocaleTestKit";

const NBSP = " ";

afterEach(async () => { await useInvariantLocale(); });

describe("de-DE: the app locale's separators", () => {
  it("auto units: 11732 -> 12K, 1234 -> 1,2K", async () => {
    await useAppLocale("de-DE");
    expect(formatVisualNumber(11732, { displayUnits: "auto" })).toBe("12K");
    expect(formatVisualNumber(1234, { displayUnits: "auto" })).toBe("1,2K");
  });

  it("decimals 2 with no unit: 1234.5 -> 1.234,50", async () => {
    await useAppLocale("de-DE");
    expect(formatVisualNumber(1234.5, { displayUnits: "none", decimals: 2 })).toBe("1.234,50");
  });

  it("a percent: 0.756 -> 75,6%", async () => {
    await useAppLocale("de-DE");
    expect(formatVisualNumber(0.756, { displayUnits: "auto", formatSource: "45%" })).toBe("75,6%");
  });

  it("a scaled de-DE currency keeps its symbol and writes a decimal comma", async () => {
    await useAppLocale("de-DE");
    expect(formatVisualNumber(1234.5, { displayUnits: "auto", sourceText: "€ 1.234,50" })).toBe("€1,2K");
    // Units "none" and no decimals asked: the engine's own text, verbatim.
    expect(formatVisualNumber(1234.5, { displayUnits: "none", sourceText: "€ 1.234,50" })).toBe("€ 1.234,50");
  });

  it("a computed sum keeps the exemplar's suffix, in de-DE digits (automatic decimals trim zeros)", async () => {
    await useAppLocale("de-DE");
    const data = seriesData(["A", "B"], [{ name: "Amount", values: [1000.25, 1000.25] }], [["1.000,25 kg", "1.000,25 kg"]]);
    const v = aggregateSeries(data, 0, "sum");
    expect(formatVisualValue(v, { displayUnits: "none" })).toBe("2.000,5 kg");
  });

  it("text in another locale's spelling is not read as a number", async () => {
    await useAppLocale("de-DE");
    // An en-US rendering is TEXT in de-DE: written as it is, never re-guessed.
    expect(formatVisualValue({ value: 1234.5, text: "1,234.50", categoryIndex: 0 }, { displayUnits: "auto" })).toBe("1,234.50");
  });

  it("a painted Card in de-DE", async () => {
    await useAppLocale("de-DE");
    const { calls } = paintVisual("card", visualSpec("card"), seriesData(["A"], [{ name: "Sales", values: [1234] }]));
    expect(textsOf(calls)).toContain("1,2K");
  });

  it("a painted KPI's distance to goal in de-DE", async () => {
    await useAppLocale("de-DE");
    const data = seriesData(["Jan", "Feb"], [
      { name: "Revenue", values: [90, 112.5] },
      { name: "Target", values: [100, 100] },
    ]);
    const texts = textsOf(paintVisual("kpi", visualSpec("kpi"), data).calls);
    expect(texts).toContain("112,5");
    expect(texts.some((t) => t.includes("(+12,5%)"))).toBe(true);
  });
});

describe("sv-SE: NBSP grouping, decimal comma", () => {
  it("groups with NBSP", async () => {
    await useAppLocale("sv-SE");
    expect(formatVisualNumber(1234567, { displayUnits: "none", decimals: 0 })).toBe(`1${NBSP}234${NBSP}567`);
    expect(formatVisualNumber(1234.5, { displayUnits: "none", decimals: 2 })).toBe(`1${NBSP}234,50`);
  });

  it("an sv-SE kr source scales with its suffix and a decimal comma", async () => {
    await useAppLocale("sv-SE");
    expect(formatVisualNumber(1234.5, { displayUnits: "auto", sourceText: `1${NBSP}234,50 kr` })).toBe("1,2K kr");
  });
});

describe("invariant: unchanged", () => {
  it("writes en-US digits", () => {
    expect(formatVisualNumber(1234, { displayUnits: "auto" })).toBe("1.2K");
    expect(formatVisualNumber(1234.5, { displayUnits: "none", decimals: 2 })).toBe("1,234.50");
    expect(formatVisualNumber(0.756, { displayUnits: "auto", formatSource: "45%" })).toBe("75.6%");
  });
});
