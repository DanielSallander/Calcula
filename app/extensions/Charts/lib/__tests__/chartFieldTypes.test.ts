//! FILENAME: app/extensions/Charts/lib/__tests__/chartFieldTypes.test.ts
// PURPOSE: Tests for field-type inference + numeric/date parsing + time ticks (C2).

import { describe, it, expect } from "vitest";
import {
  parseDisplayNumber,
  parseDate,
  detectCategoryField,
  timeTicks,
} from "../chartFieldTypes";

describe("parseDisplayNumber", () => {
  it("parses plain, grouped, currency, percent and parenthesized numbers", () => {
    expect(parseDisplayNumber("1234")).toBe(1234);
    expect(parseDisplayNumber("1,234.5")).toBe(1234.5);
    expect(parseDisplayNumber("$1,000")).toBe(1000);
    expect(parseDisplayNumber("50%")).toBeCloseTo(0.5);
    expect(parseDisplayNumber("(123)")).toBe(-123);
  });

  it("returns NaN for non-numeric text", () => {
    expect(Number.isNaN(parseDisplayNumber("hello"))).toBe(true);
    expect(Number.isNaN(parseDisplayNumber(""))).toBe(true);
  });
});

describe("parseDate", () => {
  it("parses ISO and month-name dates to epoch ms", () => {
    expect(parseDate("2024-01-15")).toBe(Date.UTC(2024, 0, 15));
    expect(typeof parseDate("Jan 2024")).toBe("number");
  });

  it("rejects bare numbers and non-dates", () => {
    expect(parseDate("2024")).toBeNull();
    expect(parseDate("15.5")).toBeNull();
    expect(parseDate("hello")).toBeNull();
    expect(parseDate("")).toBeNull();
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

  it("treats bare years as quantitative, not temporal", () => {
    expect(detectCategoryField(["2023", "2024", "2025"])).toEqual({ type: "quantitative", values: [2023, 2024, 2025] });
  });

  it("returns undefined for nominal, mixed, or empty categories", () => {
    expect(detectCategoryField(["A", "B"])).toBeUndefined();
    expect(detectCategoryField(["1", "A"])).toBeUndefined();
    expect(detectCategoryField([])).toBeUndefined();
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
