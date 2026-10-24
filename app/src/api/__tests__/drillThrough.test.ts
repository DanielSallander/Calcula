//! FILENAME: app/src/api/__tests__/drillThrough.test.ts
// PURPOSE: @api/drillThrough -- the one definition shape's pure helpers: the
//          Keep-filters default (absent = true), the result sheet's base name
//          through the backend's sheet-name rules (illegal characters removed,
//          31 characters, never "History", "Drillthrough" when nothing is
//          usable), the display name; and the barrel re-exports.
// CONTEXT: docs/design/model-drillthrough.md 2.5 / section 3.

import { describe, it, expect } from "vitest";
import {
  DRILL_THROUGH_DEFAULT_SHEET_NAME,
  drillKeepsFilters,
  drillThroughDisplayName,
  drillThroughSheetName,
  type DrillThroughDefinition,
} from "../drillThrough";

const def = (over: Partial<DrillThroughDefinition> = {}): DrillThroughDefinition => ({
  dslText: "VALUES: [Revenue]",
  presentation: { kind: "table" },
  ...over,
});

describe("drillKeepsFilters", () => {
  it("is true when absent (Power BI's Keep all filters is on by default), false only when said", () => {
    // SABOTAGE: `d.keepFilters === true` -- every stored definition stops
    // carrying the page's filters.
    expect(drillKeepsFilters(def())).toBe(true);
    expect(drillKeepsFilters(def({ keepFilters: true }))).toBe(true);
    expect(drillKeepsFilters(def({ keepFilters: false }))).toBe(false);
  });
});

describe("drillThroughSheetName", () => {
  it("is the definition's name, trimmed", () => {
    expect(drillThroughSheetName(def({ name: "  By region " }), "Chart 1")).toBe("By region");
  });

  it("removes the characters a sheet name cannot hold rather than dropping the whole name", () => {
    expect(drillThroughSheetName(def({ name: "Sales: EU/US [2024]?" }), "")).toBe("Sales EUUS 2024");
    expect(drillThroughSheetName(def({ name: "'quoted'" }), "")).toBe("quoted");
  });

  it("cuts to 31 CHARACTERS (code points, not UTF-16 units)", () => {
    const long = "Résumé ".repeat(10);
    const name = drillThroughSheetName(def({ name: long }), "");
    expect(Array.from(name).length).toBeLessThanOrEqual(31);
    expect(name.startsWith("Résumé Résumé")).toBe(true);
    const emoji = "😀".repeat(40);
    expect(Array.from(drillThroughSheetName(def({ name: emoji }), "")).length).toBe(31);
  });

  it("falls back to '<source> drill' when the definition has no usable name, then to 'Drillthrough'", () => {
    expect(drillThroughSheetName(def(), "Sales by Category")).toBe("Sales by Category drill");
    expect(drillThroughSheetName(def({ name: "   " }), "Chart 1")).toBe("Chart 1 drill");
    expect(drillThroughSheetName(def({ name: "History" }), "Chart 1")).toBe("Chart 1 drill");
    expect(drillThroughSheetName(def({ name: "[]" }), "")).toBe(DRILL_THROUGH_DEFAULT_SHEET_NAME);
    expect(drillThroughSheetName(def(), "")).toBe("Drillthrough");
    expect(drillThroughSheetName(def(), "History")).toBe("History drill");
  });
});

describe("drillThroughDisplayName", () => {
  it("is the trimmed name, else 'Drill through'", () => {
    expect(drillThroughDisplayName(def({ name: " Detail " }))).toBe("Detail");
    expect(drillThroughDisplayName(def())).toBe("Drill through");
    expect(drillThroughDisplayName(def({ name: "  " }))).toBe("Drill through");
  });
});

describe("the @api barrel", () => {
  it("re-exports the helpers as the same live module", async () => {
    const barrel = await import("../index");
    expect(barrel.drillKeepsFilters).toBe(drillKeepsFilters);
    expect(barrel.drillThroughSheetName).toBe(drillThroughSheetName);
    expect(barrel.drillThroughDisplayName).toBe(drillThroughDisplayName);
    expect(barrel.DRILL_THROUGH_DEFAULT_SHEET_NAME).toBe(DRILL_THROUGH_DEFAULT_SHEET_NAME);
  });
});
