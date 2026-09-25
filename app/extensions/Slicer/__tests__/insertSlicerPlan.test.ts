//! FILENAME: app/extensions/Slicer/__tests__/insertSlicerPlan.test.ts
// PURPOSE: The Insert Slicers dialog offers the tables of EVERY sheet, each
//          with its REAL sheet, never stamps a pivot with the active sheet, and
//          places slicers at the caller's placement (cascading) or — without
//          one — exactly where it always did.
// CONTEXT: The dialog used to keep only `table.sheetIndex === activeSheet`,
//          which on a canvas sheet (no cells, so no tables) listed nothing at
//          all. The list-building and the layout are pure functions the dialog
//          calls, so they are tested here without rendering it.

import { describe, it, expect, vi } from "vitest";
import {
  pivotSource,
  readSlicerPlacement,
  slicerRects,
  sourceLabel,
  tableSources,
} from "../lib/insertSlicerPlan";

const SHEETS = [
  { index: 0, name: "Data" },
  { index: 1, name: "Report" },
  { index: 2, name: "Canvas" },
];

const TABLES = [
  { id: "t-sales", name: "Sales", sheetIndex: 0, columns: [{ name: "Region" }, { name: "Amount" }] },
  { id: "t-costs", name: "Costs", sheetIndex: 1, columns: [{ name: "Dept" }] },
];

describe("tableSources", () => {
  it("lists another sheet's table, with its REAL sheetIndex and sheet name", () => {
    // Active sheet = the canvas (2), which holds no table.
    const sources = tableSources(TABLES, SHEETS, 2);
    expect(sources).toHaveLength(2);
    const sales = sources.find((s) => s.id === "t-sales")!;
    expect(sales).toMatchObject({ type: "table", sheetIndex: 0, sheetName: "Data", fields: ["Region", "Amount"] });
    const costs = sources.find((s) => s.id === "t-costs")!;
    expect(costs).toMatchObject({ sheetIndex: 1, sheetName: "Report" });
    expect(sourceLabel(sales)).toBe("Sales (Table, Data)");
  });

  it("puts the active sheet's tables first, then the rest sheet by sheet", () => {
    expect(tableSources(TABLES, SHEETS, 1).map((s) => s.id)).toEqual(["t-costs", "t-sales"]);
    expect(tableSources(TABLES, SHEETS, 0).map((s) => s.id)).toEqual(["t-sales", "t-costs"]);
  });
});

describe("pivotSource", () => {
  it("never claims the active sheet when the listing does not say", () => {
    const src = pivotSource({ id: "p1", name: "PT" }, ["A"], SHEETS);
    expect(src.sheetIndex).toBeNull();
    expect(sourceLabel(src)).toBe("PT (PivotTable)");
  });

  it("uses the listing's sheet when it carries one", () => {
    const src = pivotSource({ id: "p1", name: "PT", sheetIndex: 1 }, ["A"], SHEETS);
    expect(src).toMatchObject({ sheetIndex: 1, sheetName: "Report" });
    expect(sourceLabel(src)).toBe("PT (PivotTable, Report)");
  });

  it("labels a BI pivot as a Data Model", () => {
    const src = pivotSource({ id: "p2", name: "Model" }, ["T.c"], SHEETS, {
      tables: [],
      measures: [],
    });
    expect(sourceLabel(src)).toBe("Model (Data Model)");
  });
});

describe("placement", () => {
  it("without a placement: exactly the historical cascade from (100, 100)", () => {
    expect(slicerRects(3, readSlicerPlacement(undefined))).toEqual([
      { x: 100, y: 100, width: 180, height: 240 },
      { x: 290, y: 100, width: 180, height: 240 },
      { x: 480, y: 100, width: 180, height: 240 },
    ]);
  });

  it("with a placement: its origin and size, cascading side by side", () => {
    const placement = readSlicerPlacement({ placement: { x: 40, y: 60, width: 200, height: 300 } });
    expect(slicerRects(2, placement)).toEqual([
      { x: 40, y: 60, width: 200, height: 300 },
      { x: 250, y: 60, width: 200, height: 300 },
    ]);
  });

  it("a placement with only x/y keeps the default size", () => {
    expect(slicerRects(1, readSlicerPlacement({ placement: { x: 5, y: 6 } }))).toEqual([
      { x: 5, y: 6, width: 180, height: 240 },
    ]);
  });

  it("an unusable placement is ignored (default origin), not placed at NaN", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(readSlicerPlacement({ placement: { x: "10", y: 5 } })).toBeNull();
    expect(readSlicerPlacement({ placement: { x: -1, y: 5 } })).toBeNull();
    expect(readSlicerPlacement({ placement: 7 })).toBeNull();
    warn.mockRestore();
  });
});
