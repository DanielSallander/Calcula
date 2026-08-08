//! FILENAME: app/extensions/Charts/lib/chartSpecNormalize.test.ts
// PURPOSE: Lock the property that no persisted chart record can reach a painter
//          incomplete — the condition that made a chart paint its own exception
//          ("Chart data error - Cannot read properties of undefined (reading
//          'title')") into the workbook.

import { describe, it, expect } from "vitest";
import type { ChartSpec } from "../types";
import {
  chartSpecNeedsRepair,
  normalizeChartDefinition,
  normalizeChartSpec,
} from "./chartSpecNormalize";

/** A complete, painter-ready spec — what buildDefaultSpec produces. */
function completeSpec(): ChartSpec {
  return {
    mark: "bar",
    data: { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 3, endCol: 1 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [{ sourceIndex: 1, name: "Sales", color: "#4472C4" }],
    title: null,
    xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    yAxis: { title: null, gridLines: true, showLabels: true, labelAngle: 0, min: null, max: null },
    legend: { visible: true, position: "bottom" },
    palette: "default",
  };
}

/**
 * The exact payload `e2e/tests/charts.spec.ts` writes through `save_chart`, and
 * a good stand-in for every hand-written or script-written spec: the fields a
 * human thinks of, and none of the structure the painters dereference.
 */
const BARE_SPEC = {
  mark: "bar",
  data: { sheetIndex: 0, startRow: 0, startCol: 25, endRow: 3, endCol: 26 },
  hasHeaders: true,
  seriesOrientation: "columns",
  categoryIndex: 0,
  series: [{ sourceIndex: 1, name: "Sales", color: "#4472C4" }],
  title: "Test Chart",
};

/** The unguarded reads every painter makes. Throwing here IS the product bug. */
function paintProbe(spec: ChartSpec): void {
  void spec.xAxis.title;
  void spec.xAxis.gridLines;
  void spec.xAxis.showLabels;
  void spec.xAxis.labelAngle;
  void spec.yAxis.title;
  void spec.yAxis.gridLines;
  void spec.yAxis.min;
  void spec.yAxis.max;
  void spec.legend.visible;
  void spec.legend.position;
  void spec.palette;
  void spec.series.length;
}

describe("chartSpecNeedsRepair", () => {
  it("is false for a spec the painters can already draw", () => {
    expect(chartSpecNeedsRepair(completeSpec())).toBe(false);
  });

  it("is true for the bare spec that reaches save_chart in practice", () => {
    expect(chartSpecNeedsRepair(BARE_SPEC)).toBe(true);
  });

  it("is true for a PARTIAL axis, not only a missing one", () => {
    const spec = { ...completeSpec(), xAxis: { title: "Month" } };
    expect(chartSpecNeedsRepair(spec)).toBe(true);
  });

  it("is true for junk", () => {
    expect(chartSpecNeedsRepair(null)).toBe(true);
    expect(chartSpecNeedsRepair("{}")).toBe(true);
    expect(chartSpecNeedsRepair([])).toBe(true);
  });
});

describe("normalizeChartSpec", () => {
  it("makes the bare spec paintable", () => {
    const spec = normalizeChartSpec(BARE_SPEC);
    expect(() => paintProbe(spec)).not.toThrow();
    expect(spec.xAxis.gridLines).toBe(false);
    expect(spec.yAxis.gridLines).toBe(true);
    expect(spec.legend).toEqual({ visible: true, position: "bottom" });
    expect(spec.palette).toBe("default");
  });

  it("keeps every value the author supplied", () => {
    const spec = normalizeChartSpec(BARE_SPEC);
    expect(spec.mark).toBe("bar");
    expect(spec.title).toBe("Test Chart");
    expect(spec.series).toHaveLength(1);
    expect(spec.data).toEqual(BARE_SPEC.data);
  });

  it("completes a partial axis field by field instead of replacing it", () => {
    const spec = normalizeChartSpec({ ...completeSpec(), xAxis: { title: "Month" } });
    expect(spec.xAxis.title).toBe("Month");
    expect(spec.xAxis.showLabels).toBe(true);
    expect(spec.xAxis.labelAngle).toBe(0);
  });

  it("is a no-op in value for an already-complete spec", () => {
    const before = completeSpec();
    expect(normalizeChartSpec(before)).toEqual(before);
  });

  it("never mutates its input", () => {
    const input = { ...BARE_SPEC };
    const snapshot = JSON.stringify(input);
    normalizeChartSpec(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("survives a spec that is not an object at all", () => {
    expect(() => paintProbe(normalizeChartSpec(null))).not.toThrow();
    expect(() => paintProbe(normalizeChartSpec(42))).not.toThrow();
  });

  it("does not invent a title for a spec that has one set to null", () => {
    const spec = normalizeChartSpec({ ...BARE_SPEC, title: null });
    expect(spec.title).toBeNull();
  });
});

describe("normalizeChartDefinition", () => {
  const fallback = { chartId: "entry-id", sheetIndex: 0 };

  it("wraps a BARE spec — the payload save_chart is called with directly", () => {
    const def = normalizeChartDefinition(BARE_SPEC, fallback);
    expect(def.chartId).toBe("entry-id");
    expect(def.spec.mark).toBe("bar");
    expect(() => paintProbe(def.spec)).not.toThrow();
  });

  it("gives a bare spec a visible, selectable rectangle", () => {
    const def = normalizeChartDefinition(BARE_SPEC, fallback);
    expect(def.width).toBeGreaterThan(0);
    expect(def.height).toBeGreaterThan(0);
  });

  it("puts a bare spec on the entry's sheet, so it is not filtered into limbo", () => {
    const def = normalizeChartDefinition(BARE_SPEC, { chartId: "x", sheetIndex: 2 });
    expect(def.sheetIndex).toBe(2);
  });

  it("passes a proper ChartDefinition through unchanged", () => {
    const definition = {
      chartId: "c1",
      name: "Chart 1",
      sheetIndex: 1,
      x: 10,
      y: 20,
      width: 300,
      height: 200,
      spec: completeSpec(),
    };
    expect(normalizeChartDefinition(definition, fallback)).toEqual(definition);
  });

  it("survives unparseable / empty persisted JSON", () => {
    const def = normalizeChartDefinition(null, fallback);
    expect(def.chartId).toBe("entry-id");
    expect(() => paintProbe(def.spec)).not.toThrow();
  });
});
