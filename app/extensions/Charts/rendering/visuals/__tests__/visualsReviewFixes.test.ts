//! FILENAME: app/extensions/Charts/rendering/visuals/__tests__/visualsReviewFixes.test.ts
// PURPOSE: The canvas-review "visuals" findings, pinned on the PAINTED text of
//          the four tiles and on the readers' data (fix-charts lane, 2026-10-08):
//          - a range tile's number comes from the TYPED value, never from
//            re-parsing sv-SE display text ("1 234,50 kr" is 1234.5, an ISO
//            date is a date, not "2K");
//          - a blank is "(Blank)", never "0", and the aggregates skip it;
//          - a Card / Gauge over a pivot or design query shows the SOURCE'S
//            total, never the sum of an average's rows;
//          - computed values keep the source's format ("75%", "Goal: $10K");
//          - a Gauge's default range takes its target in.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  getRangeCellsTyped: vi.fn(),
  getHiddenRowsInfo: vi.fn(),
  getHiddenColsInfo: vi.fn(),
}));

vi.mock("@api/lib", () => ({
  getSheets: vi.fn(async () => ({ sheets: [{ index: 0, name: "Sheet1", sheetId: "s0", visibility: "visible" }], activeIndex: 0 })),
  getRangeCellsTyped: h.getRangeCellsTyped,
  getHiddenRowsInfo: h.getHiddenRowsInfo,
  getHiddenColsInfo: h.getHiddenColsInfo,
}));
vi.mock("@api", () => ({
  getSheets: vi.fn(async () => ({ sheets: [{ index: 0, name: "Sheet1", sheetId: "s0", visibility: "visible" }], activeIndex: 0 })),
  getNamedRange: vi.fn(async () => null),
  indexToCol: (i: number) => String.fromCharCode(65 + i),
  isSandboxTransformMounted: () => false,
  runSandboxTransform: vi.fn(),
}));
vi.mock("@api/grid", () => ({
  getGridStateSnapshot: () => ({ sheetContext: { activeSheetIndex: 0, activeSheetName: "Sheet1" } }),
}));

import { readChartDataResolved } from "../../../lib/chartDataReader";
import { parseDisplayNumber } from "../../../lib/chartFieldTypes";
import { extractChartData } from "../../../lib/pivotChartDataReader";
import { designQueryChartData } from "../../../lib/designQueryChartDataReader";
import { applyChartFilters, applySelectionKeep } from "../../../lib/chartFilters";
import { aggregateSeries, formatVisualValue, BLANK_TEXT } from "../visualValues";
import { resolveGaugeScale } from "../gaugePainter";
import { visualSpec, seriesData, paintVisual, textsOf } from "./visualTestKit";
import type { ChartSpec, ParsedChartData } from "../../../types";
import type { PivotViewResponse } from "@api/pivot";

type Kind = "number" | "text" | "empty";
const typed = (row: number, col: number, display: string, kind: Kind, value?: unknown) => ({
  row,
  col,
  display,
  formula: null,
  type: kind,
  value: kind === "empty" ? null : value ?? display,
});

function rangeSpec(mark: string, endRow: number, over: Partial<ChartSpec> = {}): ChartSpec {
  return visualSpec(mark, {
    data: { sheetIndex: 0, startRow: 0, startCol: 0, endRow, endCol: 1 },
    series: [{ name: "Amount", sourceIndex: 1, color: null }],
    ...over,
  });
}

function cardText(data: ParsedChartData, spec: ChartSpec): string[] {
  return textsOf(paintVisual(spec.mark, spec, data).calls);
}

beforeEach(() => {
  h.getRangeCellsTyped.mockReset();
  h.getHiddenRowsInfo.mockReset();
  h.getHiddenColsInfo.mockReset();
  h.getHiddenRowsInfo.mockResolvedValue({ user: [], effective: [] });
  h.getHiddenColsInfo.mockResolvedValue({ user: [], effective: [] });
});

// ---------------------------------------------------------------------------
// HIGH: typed values, not re-parsed display text
// ---------------------------------------------------------------------------

describe("parseDisplayNumber: sv-SE text and partly-numeric strings", () => {
  it("reads a kr-formatted sv-SE amount with its decimal comma", () => {
    expect(parseDisplayNumber("1 234,50 kr")).toBe(1234.5);
    expect(parseDisplayNumber("1 234,50 kr")).toBe(1234.5);
    expect(parseDisplayNumber("12,5 kg")).toBe(12.5);
  });
  it("refuses a string it can only partly read (an ISO date, a time)", () => {
    expect(parseDisplayNumber("2026-10-08")).toBeNaN();
    expect(parseDisplayNumber("10:30")).toBeNaN();
  });
  it("still reads the formats it always did", () => {
    expect(parseDisplayNumber("$11,732.00")).toBe(11732);
    expect(parseDisplayNumber("(1,234)")).toBe(-1234);
    expect(parseDisplayNumber("45%")).toBeCloseTo(0.45);
    expect(parseDisplayNumber("1.5e3")).toBe(1500);
  });
});

describe("range reader: the typed value is the number", () => {
  it("a Card over an sv-SE currency cell shows 1.2K kr, not 123K kr", async () => {
    h.getRangeCellsTyped.mockResolvedValue([
      typed(0, 0, "Item", "text"), typed(0, 1, "Amount", "text"),
      typed(1, 0, "A", "text"), typed(1, 1, "1 234,50 kr", "number", 1234.5),
    ]);
    const { data } = await readChartDataResolved(rangeSpec("card", 1));
    expect(data.series[0].values).toEqual([1234.5]);
    expect(cardText(data, rangeSpec("card", 1))).toContain("1.2K kr");
  });

  it("a Card over a date cell shows the date, never '2K'", async () => {
    h.getRangeCellsTyped.mockResolvedValue([
      typed(0, 0, "Item", "text"), typed(0, 1, "Refreshed", "text"),
      typed(1, 0, "A", "text"), typed(1, 1, "2026-10-08", "number", 46303),
    ]);
    const { data } = await readChartDataResolved(rangeSpec("card", 1));
    expect(data.series[0].values).toEqual([46303]);
    const texts = cardText(data, rangeSpec("card", 1));
    expect(texts).toContain("2026-10-08");
    expect(texts).not.toContain("2K");
  });

  it("a TEXT cell that merely looks numeric is shown as its text", async () => {
    h.getRangeCellsTyped.mockResolvedValue([
      typed(0, 0, "Item", "text"), typed(0, 1, "Note", "text"),
      typed(1, 0, "A", "text"), typed(1, 1, "2026 budget", "text"),
    ]);
    const { data } = await readChartDataResolved(rangeSpec("card", 1));
    expect(cardText(data, rangeSpec("card", 1))).toContain("2026 budget");
  });
});

// ---------------------------------------------------------------------------
// MEDIUM: blanks are "(Blank)"
// ---------------------------------------------------------------------------

describe("blanks", () => {
  it("a range Card over an empty cell shows (Blank), not 0", async () => {
    h.getRangeCellsTyped.mockResolvedValue([
      typed(0, 0, "Item", "text"), typed(0, 1, "Amount", "text"),
      typed(1, 0, "A", "text"),
      // B2 is not in the sparse read at all: an empty cell.
    ]);
    const { data } = await readChartDataResolved(rangeSpec("card", 1));
    const texts = cardText(data, rangeSpec("card", 1));
    expect(texts).toContain(BLANK_TEXT);
    expect(texts).not.toContain("0");
  });

  it("average / count skip a trailing empty cell; auto sums only what is there", async () => {
    h.getRangeCellsTyped.mockResolvedValue([
      typed(0, 0, "Item", "text"), typed(0, 1, "Amount", "text"),
      typed(1, 0, "A", "text"), typed(1, 1, "10", "number", 10),
      typed(2, 0, "B", "text"), typed(2, 1, "20", "number", 20),
      typed(3, 0, "C", "text"),
    ]);
    const { data } = await readChartDataResolved(rangeSpec("card", 3));
    expect(aggregateSeries(data, 0, "average").value).toBe(15);
    expect(aggregateSeries(data, 0, "count").value).toBe(2);
    expect(aggregateSeries(data, 0, "min").value).toBe(10);
  });

  it("the backend's blank measure-only total (GrandTotal value null) reads as (Blank)", () => {
    // The exact shape headless.rs `blank_measures_without_data` emits.
    const view = {
      rowLabelColCount: 1,
      columnHeaderRowCount: 1,
      filterRowCount: 0,
      columns: [
        { viewCol: 0, colType: "RowLabel" },
        { viewCol: 1, colType: "Data" },
      ],
      rows: [
        { rowType: "ColumnHeader", visible: true, cells: [{ cellType: "Corner", value: null }, { cellType: "ColumnHeader", value: "[Revenue]" }] },
        { rowType: "GrandTotal", visible: true, cells: [{ cellType: "RowHeader", value: "Grand Total" }, { cellType: "GrandTotal", value: null, formattedValue: "" }] },
      ],
    } as unknown as PivotViewResponse;
    const data = designQueryChartData(view, { rowFields: [], valueFields: [{ measureName: "Revenue", customName: "[Revenue]" }] });
    expect(formatVisualValue(aggregateSeries(data, 0, "auto"), {})).toBe(BLANK_TEXT);
    const texts = cardText(data, visualSpec("card"));
    expect(texts).toContain(BLANK_TEXT);
    expect(texts).not.toContain("0");
    // ...and the caption is the measure, as Power BI writes it, not "[Revenue]".
    expect(data.series[0].name).toBe("Revenue");
  });

  it("a KPI whose latest period has no actual is neutral and (Blank), not a red 0", () => {
    const data: ParsedChartData = {
      ...seriesData(["Jan", "Feb", "Mar"], [{ name: "Actual", values: [90, 110, 0] }, { name: "Goal", values: [100, 100, 100] }]),
      datumKinds: [["number", "number", "blank"], ["number", "number", "number"]],
    };
    const texts = cardText(data, visualSpec("kpi"));
    expect(texts).toContain(BLANK_TEXT);
    expect(texts.some((t) => t.includes("-100%"))).toBe(false);
    expect(texts).not.toContain("0");
  });

  it("a Multi-row card writes a blank cell as (Blank)", () => {
    const data: ParsedChartData = {
      ...seriesData(["North", "South"], [{ name: "Sales", values: [5, 0] }]),
      datumKinds: [["number", "blank"]],
    };
    expect(cardText(data, visualSpec("multiRowCard"))).toContain(BLANK_TEXT);
  });

  it("the filters keep the kinds aligned with the values", () => {
    const data: ParsedChartData = {
      ...seriesData(["a", "b", "c"], [{ name: "S", values: [1, 0, 3] }]),
      datumKinds: [["number", "blank", "number"]],
    };
    expect(applyChartFilters(data, { hiddenCategories: [0] }).datumKinds).toEqual([["blank", "number"]]);
    expect(applySelectionKeep(data, ["b"]).datumKinds).toEqual([["blank"]]);
  });
});

// ---------------------------------------------------------------------------
// MEDIUM: Card / Gauge over a pivot use the source's TOTAL
// ---------------------------------------------------------------------------

function averagePivot(): PivotViewResponse {
  // "Average of Price by Region": East 10, West 30, Grand Total 22 (an
  // average over all rows, which is NOT 10 + 30 and NOT (10 + 30) / 2).
  return {
    rowLabelColCount: 1,
    columnHeaderRowCount: 1,
    filterRowCount: 0,
    columns: [
      { viewCol: 0, colType: "RowLabel" },
      { viewCol: 1, colType: "Data" },
    ],
    rows: [
      { rowType: "ColumnHeader", visible: true, cells: [{ cellType: "Corner", value: "Region" }, { cellType: "ColumnHeader", value: "Average of Price" }] },
      { rowType: "Data", visible: true, cells: [{ cellType: "RowHeader", value: "East" }, { cellType: "Data", value: 10 }] },
      { rowType: "Data", visible: true, cells: [{ cellType: "RowHeader", value: "West" }, { cellType: "Data", value: 30 }] },
      { rowType: "GrandTotal", visible: true, cells: [{ cellType: "RowHeader", value: "Grand Total" }, { cellType: "GrandTotal", value: 22 }] },
    ],
  } as unknown as PivotViewResponse;
}

describe("pivot / design-query totals", () => {
  it("a Card over an AVERAGE pivot with two rows shows the grand total, not the sum", () => {
    const data = extractChartData(averagePivot(), {});
    expect(data.categories).toEqual(["East", "West"]);
    expect(aggregateSeries(data, 0, "auto").value).toBe(22);
    const texts = cardText(data, visualSpec("card"));
    expect(texts).toContain("22");
    expect(texts).not.toContain("40");
  });

  it("a grouped design query's Card reads the total too", () => {
    const data = designQueryChartData(averagePivot(), { rowFields: [{ table: "Sales", column: "Region" }] });
    expect(aggregateSeries(data, 0, "auto").value).toBe(22);
  });

  it("a Gauge over the pivot needles the total", () => {
    const data = extractChartData(averagePivot(), {});
    expect(cardText(data, visualSpec("gauge"))).toContain("22");
  });

  it("an explicit sum still sums, and a hidden category drops the total", () => {
    const data = extractChartData(averagePivot(), {});
    expect(aggregateSeries(data, 0, "sum").value).toBe(40);
    const filtered = applyChartFilters(data, { hiddenCategories: [1] });
    expect(filtered.seriesTotals).toBeUndefined();
    expect(aggregateSeries(filtered, 0, "auto").value).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// LOW: computed values keep the source's format
// ---------------------------------------------------------------------------

describe("format exemplar", () => {
  it("the sum of 45% and 30% is written 75%, not 0.75", () => {
    const data = seriesData(["a", "b"], [{ name: "Share", values: [0.45, 0.3] }], [["45%", "30%"]]);
    expect(formatVisualValue(aggregateSeries(data, 0, "auto"), {})).toBe("75%");
  });

  it("a summed currency keeps its prefix", () => {
    const data = seriesData(["a", "b"], [{ name: "Sales", values: [11732, 1000] }], [["$11,732.00", "$1,000.00"]]);
    expect(formatVisualValue(aggregateSeries(data, 0, "auto"), {})).toBe("$13K");
  });

  it("the KPI goal is written in the measure's format", () => {
    const data = seriesData(
      ["Jan", "Feb"],
      [{ name: "Revenue", values: [9000, 12000] }],
      [["$9,000.00", "$12,000.00"]],
    );
    const spec = visualSpec("kpi", { markOptions: { goal: 10000 } as ChartSpec["markOptions"] });
    expect(cardText(data, spec).some((t) => t.startsWith("Goal: $10K"))).toBe(true);
  });

  it("the Gauge's min / max are written in the value's format", () => {
    const data = seriesData(["a"], [{ name: "Sales", values: [500] }], [["$500.00"]]);
    const texts = cardText(data, visualSpec("gauge"));
    expect(texts).toContain("$0");
    expect(texts).toContain("$1K");
  });
});

// ---------------------------------------------------------------------------
// LOW: the Gauge's default range takes its target in
// ---------------------------------------------------------------------------

describe("gauge scale", () => {
  it("a target above the default max (2x value) widens it", () => {
    expect(resolveGaugeScale(100, {}, null, null, 300)).toEqual({ min: 0, max: 330, target: 300 });
  });
  it("a fixed max is the author's and is never moved", () => {
    expect(resolveGaugeScale(100, { max: 150 }, null, null, 300).max).toBe(150);
  });
  it("a target inside the default range changes nothing", () => {
    expect(resolveGaugeScale(100, {}, null, null, 150)).toEqual({ min: 0, max: 200, target: 150 });
  });
});
