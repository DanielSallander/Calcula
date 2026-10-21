//! FILENAME: app/extensions/Charts/lib/__tests__/chartFieldTypes.test.ts
// PURPOSE: Tests for field-type inference, the reader of an engine-rendered
//          number, and the time ticks (C2; app locale since P2 S8).

import { describe, it, expect, afterEach } from "vitest";
import {
  readShownNumber,
  splitShownNumber,
  serialToEpochMs,
  detectCategoryField,
  timeTicks,
} from "../chartFieldTypes";
import { useAppLocale, useInvariantLocale } from "./appLocaleTestKit";

afterEach(async () => { await useInvariantLocale(); });

describe("readShownNumber: an engine-rendered number in the APP locale", () => {
  it("reads plain, grouped, currency, percent and parenthesized numbers (invariant)", () => {
    expect(readShownNumber("1234")).toBe(1234);
    expect(readShownNumber("1,234.5")).toBe(1234.5);
    expect(readShownNumber("$1,000")).toBe(1000);
    expect(readShownNumber("50%")).toBeCloseTo(0.5);
    expect(readShownNumber("(123)")).toBe(-123);
    expect(readShownNumber("-$1,234.50")).toBe(-1234.5);
    expect(readShownNumber("$-1,234.50")).toBe(-1234.5);
  });

  it("returns null for non-numeric text", () => {
    expect(readShownNumber("hello")).toBeNull();
    expect(readShownNumber("")).toBeNull();
    expect(readShownNumber("2026-10-08")).toBeNull();
    expect(readShownNumber("10:30")).toBeNull();
    expect(readShownNumber("Q3 2024")).toBeNull();
  });

  it("reads digits strictly in the app locale: de-DE", async () => {
    await useAppLocale("de-DE");
    expect(readShownNumber("1.234,5")).toBe(1234.5);
    expect(readShownNumber("€ 1.234,50")).toBe(1234.5);
    expect(readShownNumber("75,6%")).toBeCloseTo(0.756);
    // The en-US spelling is NOT a de-DE number (it used to be guessed).
    expect(readShownNumber("1,234.50")).toBeNull();
  });

  it("reads digits strictly in the app locale: sv-SE (NBSP or space groups)", async () => {
    await useAppLocale("sv-SE");
    expect(readShownNumber("1 234,50 kr")).toBe(1234.5);
    expect(readShownNumber("1 234,50 kr")).toBe(1234.5);
    // The old guesser read a THREE-decimal sv-SE value as a thousands group.
    expect(readShownNumber("1,234")).toBe(1.234);
  });

  it("splitShownNumber returns the affixes around the digits", async () => {
    await useAppLocale("sv-SE");
    expect(splitShownNumber("25 000 kr")).toEqual({ value: 25000, prefix: "", suffix: " kr", percent: false });
    await useAppLocale("en-US");
    expect(splitShownNumber("$11,732.00")).toEqual({ value: 11732, prefix: "$", suffix: "", percent: false });
    expect(splitShownNumber("45%")).toEqual({ value: 0.45, prefix: "", suffix: "%", percent: true });
    expect(splitShownNumber("5 - 3")).toBeNull();
  });
});

describe("serialToEpochMs", () => {
  it("maps Excel serials to UTC midnight", () => {
    expect(serialToEpochMs(45306)).toBe(Date.UTC(2024, 0, 15));
    expect(serialToEpochMs(45306.5)).toBe(Date.UTC(2024, 0, 15, 12));
    expect(serialToEpochMs(61)).toBe(Date.UTC(1900, 2, 1));
    expect(serialToEpochMs(59)).toBe(Date.UTC(1900, 1, 28));
  });
});

describe("detectCategoryField", () => {
  it("classifies all-numeric categories as quantitative", () => {
    expect(detectCategoryField(["1", "2", "3"])).toEqual({ type: "quantitative", values: [1, 2, 3] });
    expect(detectCategoryField(["$1,000", "$2,000"])).toEqual({ type: "quantitative", values: [1000, 2000] });
  });

  it("classifies all-date categories as temporal", () => {
    const field = detectCategoryField(["2024-01-01", "2024-02-01"]);
    expect(field?.type).toBe("temporal");
    expect(field?.values).toEqual([Date.UTC(2024, 0, 1), Date.UTC(2024, 1, 1)]);
  });

  it("treats bare years as quantitative, never temporal", () => {
    expect(detectCategoryField(["2023", "2024", "2025"])).toEqual({ type: "quantitative", values: [2023, 2024, 2025] });
    expect(detectCategoryField(["2024"])).toEqual({ type: "quantitative", values: [2024] });
  });

  it("a time of day alone is not a date", () => {
    expect(detectCategoryField(["10:30", "11:00"])).toBeUndefined();
  });

  it("returns undefined for nominal, mixed, or empty categories", () => {
    expect(detectCategoryField(["A", "B"])).toBeUndefined();
    expect(detectCategoryField(["1", "A"])).toBeUndefined();
    expect(detectCategoryField([])).toBeUndefined();
  });

  it("reads text categories in the app locale: de-DE", async () => {
    await useAppLocale("de-DE");
    expect(detectCategoryField(["1.234,5", "2,5"])).toEqual({ type: "quantitative", values: [1234.5, 2.5] });
    const dates = detectCategoryField(["15.01.2024", "01.02.2024"]);
    expect(dates).toEqual({ type: "temporal", values: [Date.UTC(2024, 0, 15), Date.UTC(2024, 1, 1)] });
  });

  it("typed categories decide: dates -> temporal", () => {
    const typed = [new Date(Date.UTC(2024, 0, 15)), new Date(Date.UTC(2024, 1, 1))];
    // The texts would read as nothing; the typed values are what counts.
    expect(detectCategoryField(["Jan 15th", "Feb 1st"], typed)).toEqual({
      type: "temporal",
      values: [Date.UTC(2024, 0, 15), Date.UTC(2024, 1, 1)],
    });
  });

  it("typed categories decide: numbers -> quantitative", () => {
    expect(detectCategoryField(["1,2K", "3,4K"], [1200, 3400])).toEqual({ type: "quantitative", values: [1200, 3400] });
  });

  it("typed categories decide: a text cell makes the column nominal", () => {
    expect(detectCategoryField(["2023", "2024"], [2023, null])).toBeUndefined();
  });

  it("a typed list of the wrong length is ignored (the text decides)", () => {
    expect(detectCategoryField(["1", "2"], [1])).toEqual({ type: "quantitative", values: [1, 2] });
  });
});

describe("timeTicks", () => {
  function assertWithin(ticks: Array<{ value: number; label: string }>, min: number, max: number) {
    expect(ticks.length).toBeGreaterThan(0);
    for (const t of ticks) {
      expect(t.value).toBeGreaterThanOrEqual(min);
      expect(t.value).toBeLessThanOrEqual(max);
      expect(typeof t.label).toBe("string");
      expect(t.label.length).toBeGreaterThan(0);
    }
    // Strictly ascending.
    for (let i = 1; i < ticks.length; i++) expect(ticks[i].value).toBeGreaterThan(ticks[i - 1].value);
  }

  it("produces year ticks for multi-year spans", () => {
    const min = Date.UTC(2020, 0, 1);
    const max = Date.UTC(2025, 0, 1);
    const ticks = timeTicks(min, max, 5);
    assertWithin(ticks, min, max);
    expect(ticks.some((t) => t.label === "2024")).toBe(true);
  });

  it("produces month ticks for multi-month spans", () => {
    const min = Date.UTC(2024, 0, 1);
    const max = Date.UTC(2024, 5, 1);
    const ticks = timeTicks(min, max, 6);
    assertWithin(ticks, min, max);
    expect(ticks[0].label).toMatch(/\b2024\b/);
    expect(ticks[0].label).toBe("Jan 2024");
  });

  it("month and day ticks use the app locale's month names", async () => {
    await useAppLocale("de-DE");
    const months = timeTicks(Date.UTC(2024, 0, 1), Date.UTC(2024, 5, 1), 6);
    expect(months.map((t) => t.label)).toContain("Mär 2024");
    await useAppLocale("sv-SE");
    const days = timeTicks(Date.UTC(2024, 4, 1), Date.UTC(2024, 4, 5), 5);
    expect(days[0].label).toMatch(/^maj 1$/i);
  });

  it("produces day ticks for short spans", () => {
    const min = Date.UTC(2024, 0, 1);
    const max = Date.UTC(2024, 0, 11);
    const ticks = timeTicks(min, max, 5);
    assertWithin(ticks, min, max);
  });

  it("handles a degenerate (single-point) domain", () => {
    const ms = Date.UTC(2024, 0, 1);
    const ticks = timeTicks(ms, ms);
    expect(ticks).toHaveLength(1);
    expect(ticks[0].value).toBe(ms);
  });
});
