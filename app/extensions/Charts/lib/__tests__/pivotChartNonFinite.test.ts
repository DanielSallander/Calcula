//! FILENAME: app/extensions/Charts/lib/__tests__/pivotChartNonFinite.test.ts
// PURPOSE: NEW-canvas-nonfinite-words (open-ledger round D). A model measure's
//   1/0, -1/0 and 0/0 arrive in a BI pivot / design-query view as a "#NUM!"
//   value cell with `nonFinite` saying which (Excel's grid shows #NUM!). A
//   canvas visual -- a Card, a Multi-row card, a KPI -- writes Power BI's own
//   word for it: "Infinity", "-Infinity", "NaN", from `nonFiniteNumberText`
//   (@api/locale), never "#NUM!", "(Blank)" or a 0. Before, JSON carried the
//   number as `null` and the Card showed "(Blank)".

import { describe, it, expect } from "vitest";
import { extractChartData } from "../pivotChartDataReader";
import { aggregateSeries, datumValue, formatVisualValue } from "../../rendering/visuals/visualValues";
import { nonFiniteNumberText } from "@api/locale";
import type { NonFiniteNumber } from "@api/locale";
import type { PivotViewResponse, PivotCellData, PivotCellValue, PivotCellType } from "@api/pivotTypes";

function cell(cellType: PivotCellType, value: PivotCellValue, nonFinite?: NonFiniteNumber): PivotCellData {
  return { cellType, value, backgroundStyle: "Normal", ...(nonFinite ? { nonFinite } : {}) };
}

/** Rows Up (+Inf), Down (-Inf), Odd (NaN), Two (2.5) of one measure; a grand total NaN. */
function view(): PivotViewResponse {
  const data = (viewRow: number, label: string, value: PivotCellValue, nonFinite?: NonFiniteNumber) => ({
    viewRow,
    rowType: "Data" as const,
    depth: 0,
    visible: true,
    cells: [cell("RowHeader", label), cell("Data", value, nonFinite)],
  });
  return {
    pivotId: "p1",
    version: 1,
    rowCount: 6,
    colCount: 2,
    rowLabelColCount: 1,
    columnHeaderRowCount: 1,
    filterRowCount: 0,
    filterRows: [],
    rowFieldSummaries: [],
    columnFieldSummaries: [],
    columns: [
      { viewCol: 0, colType: "RowLabel", depth: 0, widthHint: 100 },
      { viewCol: 1, colType: "Data", depth: 0, widthHint: 80 },
    ],
    rows: [
      { viewRow: 0, rowType: "ColumnHeader", depth: 0, visible: true, cells: [cell("Blank", null), cell("ColumnHeader", "Ratio")] },
      data(1, "Up", "#NUM!", "infinity"),
      data(2, "Down", "#NUM!", "negativeInfinity"),
      data(3, "Odd", "#NUM!", "nan"),
      data(4, "Two", 2.5),
      {
        viewRow: 5,
        rowType: "GrandTotal",
        depth: 0,
        visible: true,
        cells: [cell("GrandTotalRow", "Grand Total"), cell("GrandTotal", "#NUM!", "nan")],
      },
    ],
  };
}

describe("a canvas visual writes Power BI's words for a non-finite measure value", () => {
  it("nonFiniteNumberText is Power BI's spelling", () => {
    expect(nonFiniteNumberText("infinity")).toBe("Infinity");
    expect(nonFiniteNumberText("negativeInfinity")).toBe("-Infinity");
    expect(nonFiniteNumberText("nan")).toBe("NaN");
  });

  it("each datum of a Card / Multi-row card is its word, a finite one its number", () => {
    const data = extractChartData(view(), {});
    expect(data.categories).toEqual(["Up", "Down", "Odd", "Two"]);
    const shown = data.categories.map((_, ci) => formatVisualValue(datumValue(data, 0, ci), {}));
    expect(shown.slice(0, 3)).toEqual(["Infinity", "-Infinity", "NaN"]);
    expect(shown[3]).not.toMatch(/Infinity|NaN|#NUM!|Blank/);
    // Never charted as a number: a bar is not drawn to infinity.
    expect(data.series[0].values.slice(0, 3)).toEqual([0, 0, 0]);
  });

  it("the source's own total is its word too", () => {
    const data = extractChartData(view(), {});
    expect(formatVisualValue(aggregateSeries(data, 0, "auto"), {})).toBe("NaN");
  });

  it("a measure-only view (a Card's usual shape) shows the grand total's word", () => {
    const v = view();
    const totalOnly: PivotViewResponse = { ...v, rows: v.rows.filter((r) => r.rowType !== "Data") };
    const data = extractChartData(totalOnly, { includeSubtotals: false, includeGrandTotal: true });
    expect(formatVisualValue(aggregateSeries(data, 0, "auto"), {})).toBe("NaN");
  });
});
