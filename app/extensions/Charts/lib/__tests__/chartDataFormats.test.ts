//! FILENAME: app/extensions/Charts/lib/__tests__/chartDataFormats.test.ts
// PURPOSE: The Data format card's rows for a design-query chart (WP-C S9a):
//          one per measure the COMPILED query plots, in plot order, each with
//          the user's override (`spec.fieldFormats[measure]`) and the model's
//          own format (`MeasureFieldInfo.formatString`) as the placeholder;
//          none for a range chart.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  compile: vi.fn(),
}));

vi.mock("../designQueryChartDataReader", () => ({
  compileDesignQuerySource: (...a: unknown[]) => h.compile(...a),
}));

import { designQueryDataFormats } from "../chartDataFormats";
import { chartsBackend } from "../chartsBackend";
import type { ChartSpec } from "../../types";

const invoke = vi.fn();

function dqSpec(fieldFormats?: Record<string, string>): ChartSpec {
  return {
    mark: "card",
    data: { type: "designQuery", dslText: "VALUES: [Revenue], [Units]", connectionId: "7" },
    fieldFormats,
  } as unknown as ChartSpec;
}

beforeEach(() => {
  h.compile.mockReset();
  invoke.mockReset();
  chartsBackend.set(invoke);
  h.compile.mockResolvedValue({
    valueFields: [{ measureName: "Revenue", customName: "Sales" }, { measureName: "Units" }, { measureName: "Revenue" }],
  });
  invoke.mockImplementation(async (cmd: string) =>
    cmd === "get_connection_bi_model"
      ? { tables: [], measures: [{ name: "Revenue", formatString: "$#,##0" }, { name: "[Units]" }] }
      : undefined,
  );
});

describe("designQueryDataFormats", () => {
  it("one row per plotted measure, in order, de-duplicated, with override and source format", async () => {
    const rows = await designQueryDataFormats("c1", dqSpec({ Units: "0.0" }));
    expect(h.compile).toHaveBeenCalledWith(dqSpec({ Units: "0.0" }).data, { chartId: "c1" });
    expect(invoke).toHaveBeenCalledWith("get_connection_bi_model", { connectionId: "7" });
    expect(rows).toEqual([
      { key: "Revenue", label: "Sales", format: null, sourceFormat: "$#,##0" },
      { key: "Units", label: "Units", format: "0.0", sourceFormat: null },
    ]);
  });

  it("a range chart has no data-format rows (not in v1) and compiles nothing", async () => {
    const range = { mark: "bar", data: "Sheet1!A1:B4" } as unknown as ChartSpec;
    expect(await designQueryDataFormats("c1", range)).toEqual([]);
    expect(h.compile).not.toHaveBeenCalled();
  });

  it("a query that cannot be compiled rejects with the compiler's sentence (the card shows it)", async () => {
    h.compile.mockRejectedValue(new Error("This design-query chart has no BI connection selected."));
    await expect(designQueryDataFormats("c1", dqSpec())).rejects.toThrow(/no BI connection/);
  });
});
