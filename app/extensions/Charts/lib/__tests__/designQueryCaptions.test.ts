//! FILENAME: app/extensions/Charts/lib/__tests__/designQueryCaptions.test.ts
// PURPOSE: A design-query chart captions an un-aliased measure the way Power BI
//          does -- "Revenue", not the DSL compiler's "[Revenue]" (the Card
//          writes this name under its number) -- while an alias is kept as
//          written, and the insights binding still finds the measure behind
//          the plain caption (canvas-review visuals finding, verified by
//          reading compiler.ts:272 -> expand_bi_value_fields -> the engine's
//          column header).

import { describe, it, expect } from "vitest";
import type { PivotViewResponse } from "@api/pivot";
import { designQueryChartData } from "../designQueryChartDataReader";
import { bindSeriesToMeasures } from "../designQuerySeriesBinding";

function view(headers: string[], values: number[]): PivotViewResponse {
  return {
    rowLabelColCount: 1,
    columnHeaderRowCount: 1,
    filterRowCount: 0,
    columns: [{ viewCol: 0, colType: "RowLabel" }, ...headers.map((_, i) => ({ viewCol: i + 1, colType: "Data" }))],
    rows: [
      { rowType: "ColumnHeader", visible: true, cells: [{ cellType: "Corner", value: "" }, ...headers.map((h) => ({ cellType: "ColumnHeader", value: h }))] },
      { rowType: "GrandTotal", visible: true, cells: [{ cellType: "RowHeader", value: "Grand Total" }, ...values.map((v) => ({ cellType: "GrandTotal", value: v }))] },
    ],
  } as unknown as PivotViewResponse;
}

describe("design-query captions", () => {
  it("drops the compiler's brackets from an un-aliased measure", () => {
    const data = designQueryChartData(view(["[Revenue]", "[Cost]"], [10, 4]), {
      rowFields: [],
      valueFields: [{ measureName: "Revenue", customName: "[Revenue]" }, { measureName: "Cost", customName: "[Cost]" }],
    });
    expect(data.series.map((s) => s.name)).toEqual(["Revenue", "Cost"]);
  });

  it("keeps an alias exactly as written, even one in brackets of its own", () => {
    const data = designQueryChartData(view(["Sales (net)", "[Other]"], [10, 4]), {
      rowFields: [],
      valueFields: [{ measureName: "Revenue", customName: "Sales (net)" }, { measureName: "Cost", customName: "[Other]" }],
    });
    expect(data.series.map((s) => s.name)).toEqual(["Sales (net)", "[Other]"]);
  });

  it("only the LAST part under column fields is the measure", () => {
    const data = designQueryChartData(view(["[East] - [Revenue]"], [10]), {
      rowFields: [],
      valueFields: [{ measureName: "Revenue", customName: "[Revenue]" }],
    });
    expect(data.series[0].name).toBe("[East] - Revenue");
  });

  it("the insights binding finds the measure behind the plain caption", () => {
    expect(bindSeriesToMeasures(["Revenue", "West - Revenue"], [{ measureName: "Revenue", customName: "[Revenue]" }])).toEqual([
      { series: "Revenue", measure: "Revenue" },
      { series: "West - Revenue", measure: "Revenue" },
    ]);
  });
});
