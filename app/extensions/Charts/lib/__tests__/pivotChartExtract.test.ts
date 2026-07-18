//! FILENAME: app/extensions/Charts/lib/__tests__/pivotChartExtract.test.ts
// PURPOSE: extractChartData must derive category + series labels from cell
//   VALUES, not only formattedValue. The backend (view_to_response) fills
//   formattedValue ONLY for custom-formatted numbers — text row/column headers
//   arrive with formattedValue "" and their text in `value`. Regression guard
//   for pivot/design-query charts rendering with empty x-axis categories and
//   "Value 1" series names.

import { describe, it, expect } from "vitest";
import { extractChartData } from "../pivotChartDataReader";
import type {
  PivotViewResponse,
  PivotRowData,
  PivotCellData,
  PivotCellValue,
  PivotCellType,
} from "@api/pivotTypes";

function cell(
  cellType: PivotCellType,
  value: PivotCellValue,
  formattedValue = "",
): PivotCellData {
  return { cellType, value, formattedValue, backgroundStyle: "Normal" };
}

function dataRow(viewRow: number, label: PivotCellValue, value: number): PivotRowData {
  return {
    viewRow,
    rowType: "Data",
    depth: 0,
    visible: true,
    cells: [cell("RowHeader", label), cell("Data", value)],
  };
}

/** Minimal 1-row-field × 1-measure view, as the headless design query returns:
 *  formattedValue empty everywhere, text carried in `value`. */
function makeView(): PivotViewResponse {
  return {
    pivotId: "p1",
    version: 1,
    rowCount: 4,
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
      {
        viewRow: 0,
        rowType: "ColumnHeader",
        depth: 0,
        visible: true,
        cells: [cell("Blank", null), cell("ColumnHeader", "Revenue")],
      },
      dataRow(1, "Alice Anderson", 100),
      dataRow(2, "Bo Berg", 200),
      {
        viewRow: 3,
        rowType: "GrandTotal",
        depth: 0,
        visible: true,
        cells: [cell("GrandTotalRow", "Grand Total"), cell("GrandTotal", 300)],
      },
    ],
  };
}

describe("extractChartData label derivation (empty formattedValue)", () => {
  it("derives categories from row-header cell VALUES", () => {
    const data = extractChartData(makeView(), {});
    expect(data.categories).toEqual(["Alice Anderson", "Bo Berg"]);
  });

  it("derives series names from column-header cell VALUES", () => {
    const data = extractChartData(makeView(), {});
    expect(data.series).toHaveLength(1);
    expect(data.series[0].name).toBe("Revenue");
    expect(data.series[0].values).toEqual([100, 200]);
  });

  it("prefers formattedValue when the backend supplies one", () => {
    const view = makeView();
    view.rows[1].cells[0] = cell("RowHeader", 45292, "2024-01-01");
    const data = extractChartData(view, {});
    expect(data.categories[0]).toBe("2024-01-01");
  });

  it("stringifies numeric row headers (e.g. years)", () => {
    const view = makeView();
    view.rows[1].cells[0] = cell("RowHeader", 2024);
    const data = extractChartData(view, {});
    expect(data.categories[0]).toBe("2024");
  });
});
