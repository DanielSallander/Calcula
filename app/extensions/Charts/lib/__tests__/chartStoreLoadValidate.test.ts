//! FILENAME: app/extensions/Charts/lib/__tests__/chartStoreLoadValidate.test.ts
// PURPOSE: Feature 3(a) — loadChartsFromBackend runs an ADVISORY schema check over
//          every persisted chart: a spec with schema violations is kept (still
//          rendered) and a console.warn is emitted. Dropping a chart that renders
//          fine would be a worse regression than a stale key, so load-time
//          validation is a canary, NOT a gate (the broker write path is the gate).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Backend is stubbed per-test via this mock; loadChartsFromBackend reads get_charts.
const invokeBackend = vi.fn();
vi.mock("@api/backend", () => ({ invokeBackend: (...args: unknown[]) => invokeBackend(...args) }));

import { loadChartsFromBackend, getAllCharts, resetChartStore } from "../chartStore";

const validSpec = {
  mark: "bar",
  data: "Sheet1!A1:D13",
  hasHeaders: true,
  seriesOrientation: "columns",
  categoryIndex: 0,
  series: [{ name: "Revenue", sourceIndex: 1, color: null }],
  title: "OK",
  xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
  yAxis: { title: null, gridLines: true, showLabels: true, labelAngle: 0, min: null, max: null },
  legend: { visible: false, position: "bottom" },
  palette: "default",
};

const entry = (chartId: string, name: string, spec: unknown) => ({
  id: chartId,
  sheetIndex: 0,
  specJson: JSON.stringify({ chartId, name, sheetIndex: 0, x: 0, y: 0, width: 400, height: 300, spec }),
});

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetChartStore();
  invokeBackend.mockReset();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warnSpy.mockRestore());

describe("loadChartsFromBackend advisory validation", () => {
  it("keeps a schema-violating chart (does not drop) and warns once for it", async () => {
    // c2 carries an unknown top-level key the schema rejects via additionalProperties.
    const badSpec = { ...validSpec, bogusKey: 123 };
    invokeBackend.mockResolvedValue([
      entry("c1", "Good Chart", validSpec),
      entry("c2", "Stale Chart", badSpec),
    ]);

    await loadChartsFromBackend();

    // Both charts survive the load — advisory, not a gate.
    const ids = getAllCharts().map((c) => c.chartId);
    expect(ids).toEqual(["c1", "c2"]);

    // Exactly the violating chart is warned about, by name + id.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = String(warnSpy.mock.calls[0][0]);
    expect(msg).toContain("Stale Chart");
    expect(msg).toContain("c2");
  });

  it("does not warn when every persisted chart is valid", async () => {
    invokeBackend.mockResolvedValue([entry("c1", "Good Chart", validSpec)]);
    await loadChartsFromBackend();
    expect(getAllCharts()).toHaveLength(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("falls back to an empty store when the backend call fails", async () => {
    invokeBackend.mockRejectedValue(new Error("no backend"));
    await loadChartsFromBackend();
    expect(getAllCharts()).toHaveLength(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
