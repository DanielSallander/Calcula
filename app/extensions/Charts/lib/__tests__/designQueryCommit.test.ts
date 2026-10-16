//! FILENAME: app/extensions/Charts/lib/__tests__/designQueryCommit.test.ts
// PURPOSE: THE write of a design-query chart's query from the object pane
//          (WP-C S9b): an unchanged query writes nothing; a query that does
//          not compile writes nothing and says why; a change is ONE
//          `update_chart` INSIDE one "Edit chart data" undo step (the
//          debounced save flushed before the step closes); a gauge's series
//          indices ride the SAME write.
// CONTEXT: The REAL chart store and the REAL runInUndoTransaction run here;
//          only the backend is doubled (the chart channel's invoke and the
//          undo transaction's begin/commit), each call recorded in ONE ordered
//          log, so "inside the transaction" is a statement about order.

import { describe, it, expect, beforeEach, vi } from "vitest";

const log: string[] = [];

vi.mock("../../../../src/core/lib/tauri-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/core/lib/tauri-api")>()),
  beginUndoTransaction: vi.fn(async (label: string) => {
    log.push(`begin:${label}`);
  }),
  commitUndoTransaction: vi.fn(async () => {
    log.push("commit");
  }),
}));
vi.mock("@api/dialogs", () => ({ alertAsync: () => Promise.resolve() }));

import type { BiPivotModelInfo } from "../../../_shared/components/types";
import { getChartById, loadChartsFromBackend, resetChartStore } from "../chartStore";
import { chartsBackend } from "../chartsBackend";
import { DESIGN_QUERY_UNDO_LABEL, commitDesignQuery } from "../designQueryCommit";
import type { GaugeMarkOptions } from "../../types";

const MODEL: BiPivotModelInfo = {
  tables: [{ name: "Geo", columns: [{ name: "Region", dataType: "string", isNumeric: false }] }],
  measures: [
    { name: "Revenue", table: "Sales", sourceColumn: "amount", aggregation: "sum" },
    { name: "Target", table: "Sales", sourceColumn: "target", aggregation: "sum" },
  ],
  connectionId: "conn-a",
};

const DSL = "ROWS: Geo.Region\nVALUES: [Revenue]";

function spec(mark = "bar", dslText = DSL) {
  return {
    mark,
    data: { type: "designQuery", dslText, connectionId: "conn-a" },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [],
    title: null,
    xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    yAxis: { title: null, gridLines: true, showLabels: true, labelAngle: 0, min: null, max: null },
    legend: { visible: false, position: "bottom" },
    palette: "default",
  };
}

const invokeBackend = vi.fn();

async function load(s: unknown = spec()): Promise<void> {
  invokeBackend.mockReset();
  invokeBackend.mockResolvedValueOnce([
    {
      id: "c1",
      sheetIndex: 0,
      specJson: JSON.stringify({ chartId: "c1", name: "Chart 1", sheetIndex: 0, x: 0, y: 0, width: 400, height: 300, spec: s }),
    },
  ]);
  await loadChartsFromBackend({ stampSheetIds: false });
  invokeBackend.mockReset();
  invokeBackend.mockImplementation((cmd: string) => {
    if (cmd === "get_connection_bi_model") return Promise.resolve(MODEL);
    log.push(cmd);
    // A write resolves on a LATER macrotask, as an IPC round-trip does.
    return new Promise((resolve) => setTimeout(() => resolve(undefined), 0));
  });
}

beforeEach(async () => {
  log.length = 0;
  resetChartStore();
  chartsBackend.set(invokeBackend);
  await load();
});

describe("commitDesignQuery", () => {
  it("an UNCHANGED query (same meaning, same connection) writes nothing and opens no undo step", async () => {
    const out = await commitDesignQuery("c1", { dslText: "rows: geo.region\nVALUES: [revenue]", connectionId: "conn-a" });
    expect(out).toEqual({ status: "unchanged" });
    expect(log).toEqual([]);
    // The stored text is untouched.
    expect((getChartById("c1")!.spec.data as { dslText: string }).dslText).toBe(DSL);
  });

  it("an INVALID query writes nothing and returns the compiler's sentence", async () => {
    const out = await commitDesignQuery("c1", { dslText: "ROWS: Geo.Nope\nVALUES: [Revenue]", connectionId: "conn-a" });
    expect(out.status).toBe("refused");
    expect(out.status === "refused" && out.error).toMatch(/^Line \d+:/);
    expect(log).toEqual([]);
    expect((getChartById("c1")!.spec.data as { dslText: string }).dslText).toBe(DSL);
  });

  it("no connection: refused in words, nothing written", async () => {
    const out = await commitDesignQuery("c1", { dslText: DSL, connectionId: "" });
    expect(out).toEqual({ status: "refused", error: "Select a BI connection first." });
    expect(log).toEqual([]);
  });

  it("a CHANGE is ONE update_chart INSIDE one 'Edit chart data' step -- begin, update_chart, commit", async () => {
    const next = "ROWS: Geo.Region\nVALUES: [Revenue], [Target]";
    const out = await commitDesignQuery("c1", { dslText: next, connectionId: "conn-a" });
    expect(out).toEqual({ status: "written" });
    expect(log).toEqual([`begin:${DESIGN_QUERY_UNDO_LABEL}`, "update_chart", "commit"]);
    expect(getChartById("c1")!.spec.data).toEqual({ type: "designQuery", dslText: next, connectionId: "conn-a" });
  });

  it("a gauge's series indices ride the SAME write (one update_chart)", async () => {
    await load({ ...spec("gauge", "VALUES: [Revenue]"), markOptions: { trackColor: "#eeeeee", minSeriesIndex: 3 } });
    const out = await commitDesignQuery("c1", {
      dslText: "VALUES: [Revenue], [Target]",
      connectionId: "conn-a",
      markOptions: { targetSeriesIndex: 1, minSeriesIndex: undefined, maxSeriesIndex: undefined },
    });
    expect(out).toEqual({ status: "written" });
    expect(log).toEqual([`begin:${DESIGN_QUERY_UNDO_LABEL}`, "update_chart", "commit"]);
    const mo = getChartById("c1")!.spec.markOptions as GaugeMarkOptions;
    expect(mo.targetSeriesIndex).toBe(1);
    // Cleared by the explicit undefined; an unrelated option is kept.
    expect(mo.minSeriesIndex).toBeUndefined();
    expect(mo.trackColor).toBe("#eeeeee");
  });

  it("the same query with CHANGED gauge indices is a change", async () => {
    await load({ ...spec("gauge", "VALUES: [Revenue], [Target]"), markOptions: { targetSeriesIndex: 1 } });
    const out = await commitDesignQuery("c1", {
      dslText: "VALUES: [Revenue], [Target]",
      connectionId: "conn-a",
      markOptions: { targetSeriesIndex: -1, minSeriesIndex: 1, maxSeriesIndex: undefined },
    });
    expect(out).toEqual({ status: "written" });
    expect((getChartById("c1")!.spec.markOptions as GaugeMarkOptions).minSeriesIndex).toBe(1);
  });

  it("a backend refusal is the editor's error, and the store is rolled back", async () => {
    invokeBackend.mockImplementation((cmd: string) => {
      if (cmd === "get_connection_bi_model") return Promise.resolve(MODEL);
      log.push(cmd);
      return Promise.reject(new Error("The sheet is protected."));
    });
    const out = await commitDesignQuery("c1", { dslText: "VALUES: [Target]", connectionId: "conn-a" });
    expect(out).toEqual({ status: "refused", error: "The sheet is protected." });
    expect((getChartById("c1")!.spec.data as { dslText: string }).dslText).toBe(DSL);
  });

  it("a chart that is not a design query is refused", async () => {
    await load({ ...spec(), data: "Sheet1!A1:B4" });
    const out = await commitDesignQuery("c1", { dslText: DSL, connectionId: "conn-a" });
    expect(out).toEqual({ status: "refused", error: "This chart does not run a design query." });
    expect(log).toEqual([]);
  });
});
