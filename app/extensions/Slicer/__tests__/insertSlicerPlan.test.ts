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
  isNumericDataType,
  modelSources,
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

  it("reads the backend listing's shape: a sheet per pivot, null when its sheet is unknown", () => {
    // `get_all_pivot_tables` rows (Rust `PivotTableListing`, camelCase).
    const listing = [
      { id: "p1", name: "OnCanvas", sourceRange: "Data!A1:D9", destination: "A1", sheetIndex: 2 },
      { id: "p2", name: "Stranded", sourceRange: "A1:B2", destination: "C3", sheetIndex: null },
    ];
    const [onCanvas, stranded] = listing.map((pv) => pivotSource(pv, ["A"], SHEETS));
    expect(sourceLabel(onCanvas)).toBe("OnCanvas (PivotTable, Canvas)");
    expect(stranded.sheetIndex).toBeNull();
    expect(sourceLabel(stranded)).toBe("Stranded (PivotTable)");
  });

  it("labels a BI pivot as a PivotTable ON a model, never as the model itself", () => {
    const src = pivotSource({ id: "p2", name: "Model" }, ["T.c"], SHEETS, {
      tables: [],
      measures: [],
    });
    expect(sourceLabel(src)).toBe("Model (PivotTable on model)");
  });
});

// The owner's case (finding 4, 2026-09-27): a canvas, a model, and NO table
// and NO pivot. The dialog said "No Tables or PivotTables found" and offered
// nothing, because it never listed a model.
describe("modelSources", () => {
  const SALES_MODEL = {
    tables: [
      { name: "Customers", columns: [{ name: "Region", dataType: "Utf8" }, { name: "Age", dataType: "Int64" }] },
      { name: "BI.dim_date", columns: [{ name: "Year", dataType: "Float64" }] },
    ],
    measures: [{ name: "Total Sales" }],
  };

  it("with no table and no pivot, one loaded model is offered", () => {
    const sources = modelSources([{ id: "c1", name: "Sales" }], { c1: SALES_MODEL });
    expect(sources).toHaveLength(1);
    const [model] = sources;
    expect(model).toMatchObject({ type: "biConnection", id: "c1", name: "Sales", sheetIndex: null });
    expect(model.fields).toEqual(["Customers.Region", "Customers.Age", "BI.dim_date.Year"]);
    expect(sourceLabel(model)).toBe("Sales (Model)");
    // The field tree reads isNumeric, which bi_get_model_info does not carry.
    expect(model.biModel?.tables[0].columns.map((c) => c.isNumeric)).toEqual([false, true]);
    expect(model.biModel?.tables[1].columns[0].isNumeric).toBe(true);
  });

  it("skips a connection whose model is not loaded, keeping the others in order", () => {
    const sources = modelSources(
      [
        { id: "c0", name: "Unloaded" },
        { id: "c1", name: "Sales" },
        { id: "c2", name: "Missing" },
      ],
      { c0: null, c1: SALES_MODEL },
    );
    expect(sources.map((s) => s.id)).toEqual(["c1"]);
  });

  it("classifies numeric data types like the Add Filter dialog", () => {
    expect(["Int64", "float", "Decimal(10,2)", "NUMERIC", "Double", "real"].every(isNumericDataType)).toBe(true);
    expect(["Utf8", "Date32", "Boolean", "", undefined].some((t) => isNumericDataType(t))).toBe(false);
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
