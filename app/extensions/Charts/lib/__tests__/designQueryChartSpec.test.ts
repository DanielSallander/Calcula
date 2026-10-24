//! FILENAME: app/extensions/Charts/lib/__tests__/designQueryChartSpec.test.ts
// PURPOSE: The design-query chart Charts builds for a caller OUTSIDE Charts
//          (`IChartStoreService.buildDesignQueryChartSpec`; today the
//          drill-through's result chart, docs/design/model-drillthrough.md 2.8):
//            - it comes from Charts' OWN default skeleton, the one
//              `buildDefaultSpec` builds from, so the two cannot drift;
//            - it passes the WHOLE ChartSpec schema for every built-in mark --
//              pinned against the schema itself, never a hand-written key list,
//              so a new required key or a changed default breaks THIS file and
//              not a user's drill (which would otherwise throw in createChart
//              after its temporary canvas was added);
//            - the drill definition's gate (`DrillPresentationChart`) refuses
//              exactly what the result chart's createChart refuses.
// CONTEXT: Review findings F3 (the recipe was copied into _shared) and
//          presentation-gate-looser-than-createChart.

import { describe, it, expect } from "vitest";
import { CHART_TYPES } from "../../components/chartTypeCatalog";
import {
  buildDefaultSpec,
  buildDesignQueryChartSpec,
  defaultChartSkeleton,
  type ChartSkeleton,
} from "../chartSpecDefaults";
import { validateChartSpec, validateDrillThroughDefinition } from "../chartSpecValidate";
import { markFurniture, type ChartSeries, type ChartType, type DataRangeRef } from "../../types";

const SKELETON_KEYS: ReadonlyArray<keyof ChartSkeleton> = [
  "hasHeaders",
  "seriesOrientation",
  "categoryIndex",
  "title",
  "xAxis",
  "yAxis",
  "legend",
  "palette",
];

const REQUEST = {
  dslText: 'ROWS: Product.Category\nVALUES: [Revenue]\nFILTERS: [Geo.Region] = ("West")',
  connectionId: "conn-1",
  title: "Product detail: West",
};

const BUILT_IN_MARKS: ChartType[] = CHART_TYPES.map((t) => t.value);

describe("buildDesignQueryChartSpec (the @api chart store seam's builder)", () => {
  it("covers every built-in mark (the catalog is THE list of 22)", () => {
    expect(BUILT_IN_MARKS).toHaveLength(22);
  });

  it.each(BUILT_IN_MARKS)("%s: passes the whole ChartSpec schema and is the skeleton plus the request", (mark) => {
    const spec = buildDesignQueryChartSpec({ ...REQUEST, mark });

    expect(validateChartSpec(spec)).toEqual([]);

    const skeleton = defaultChartSkeleton(mark);
    for (const key of SKELETON_KEYS) {
      if (key === "title") continue; // the request's title wins
      expect(spec[key], `${mark}.${key}`).toEqual(skeleton[key]);
    }
    expect(spec.mark).toBe(mark);
    expect(spec.data).toEqual({ type: "designQuery", dslText: REQUEST.dslText, connectionId: "conn-1" });
    // A design query's measures ARE its series.
    expect(spec.series).toEqual([]);
    expect(spec.title).toBe(REQUEST.title);
    expect(spec).not.toHaveProperty("markOptions");
    // The application connection's stable key is Rust's to stamp at save.
    expect(spec.data).not.toHaveProperty("packageDataSourceId");
  });

  it("writes the mark's options as a COPY: the definition that owns them is never shared with the new chart", () => {
    const markOptions = { stackMode: "stacked", errorBars: { type: "fixed", value: 2 } };
    const spec = buildDesignQueryChartSpec({ ...REQUEST, mark: "bar", markOptions });
    expect(spec.markOptions).toEqual(markOptions);
    expect(spec.markOptions).not.toBe(markOptions);
    (spec.markOptions as Record<string, unknown>).stackMode = "none";
    expect(markOptions.stackMode).toBe("stacked");
  });

  it("starts a legend only on a mark that has one (a tile visual draws none), like the Insert Chart dialog", () => {
    for (const mark of BUILT_IN_MARKS) {
      const spec = buildDesignQueryChartSpec({ ...REQUEST, mark });
      expect(spec.legend, mark).toEqual({ visible: markFurniture(mark) === "full", position: "bottom" });
    }
    expect(buildDesignQueryChartSpec({ ...REQUEST, mark: "card" }).legend.visible).toBe(false);
    expect(buildDesignQueryChartSpec({ ...REQUEST, mark: "bar" }).legend.visible).toBe(true);
  });
});

describe("defaultChartSkeleton is THE skeleton buildDefaultSpec builds from", () => {
  const dataRange: DataRangeRef = { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 9, endCol: 3 };
  const autoDetected = {
    categoryIndex: 2,
    series: [{ name: "Revenue", sourceIndex: 1, color: null }] as ChartSeries[],
    orientation: "rows" as const,
  };

  it.each(BUILT_IN_MARKS)("%s: a range chart's furniture is the skeleton's, its data fields the detection's", (mark) => {
    const spec = buildDefaultSpec(dataRange, false, autoDetected, mark);
    const skeleton = defaultChartSkeleton(mark);
    for (const key of ["title", "xAxis", "yAxis", "legend", "palette"] as const) {
      expect(spec[key], `${mark}.${key}`).toEqual(skeleton[key]);
    }
    expect(spec.hasHeaders).toBe(false);
    expect(spec.seriesOrientation).toBe("rows");
    expect(spec.categoryIndex).toBe(2);
    expect(spec.series).toBe(autoDetected.series);
    expect(spec.data).toBe(dataRange);
  });

  it("hands out a FRESH object on every call (a caller that edits its copy changes no other chart)", () => {
    const a = defaultChartSkeleton("bar");
    const b = defaultChartSkeleton("bar");
    expect(a).toEqual(b);
    expect(a.xAxis).not.toBe(b.xAxis);
    expect(a.legend).not.toBe(b.legend);
  });
});

// The drill definition's gate and the result chart's createChart must agree on
// EVERY presentation: a definition the gate accepted but createChart refused
// failed only after the drill had added its temporary canvas (an empty page);
// one the gate refused but createChart accepted would be a needless refusal.
describe("the drill definition's gate refuses exactly what the result chart's createChart refuses", () => {
  const PRESENTATIONS: Array<{ mark: string; markOptions?: Record<string, unknown> }> = [
    { mark: "bar" },
    { mark: "bar", markOptions: { stackMode: "stacked" } },
    { mark: "bar", markOptions: { stackMode: "sideways" } },
    { mark: "bar", markOptions: { innerRadius: 0.4 } },
    { mark: "bar", markOptions: { stacked: true } },
    { mark: "pie", markOptions: { innerRadiusRatio: 0.4 } },
    { mark: "pie", markOptions: { innerRadius: 0.4 } },
    { mark: "line", markOptions: { seriesOverlap: 5 } },
    { mark: "card", markOptions: { decimals: 1 } },
    { mark: "card", markOptions: { decimals: 99 } },
    { mark: "gauge", markOptions: { min: 0, max: 200 } },
    { mark: "gauge", markOptions: { needle: "red" } },
    { mark: "kpi", markOptions: { direction: "sideways" } },
    { mark: "bar-3d" },
    { mark: "sandbox:spark" },
    { mark: "customRadial", markOptions: { anything: 1 } },
  ];

  it.each(PRESENTATIONS)("$mark $markOptions", (presentation) => {
    const gate = validateDrillThroughDefinition({
      dslText: "VALUES: [Revenue]",
      presentation: { kind: "chart", ...presentation },
    });
    const created = validateChartSpec(buildDesignQueryChartSpec({ ...REQUEST, ...presentation }));
    expect(gate.length === 0, `gate: ${gate.join("; ")} | createChart: ${created.join("; ")}`).toBe(
      created.length === 0,
    );
  });

  it("the cases above exercise both outcomes (a list of only-valid cases would prove nothing)", () => {
    const outcomes = PRESENTATIONS.map(
      (p) =>
        validateDrillThroughDefinition({ dslText: "VALUES: [Revenue]", presentation: { kind: "chart", ...p } })
          .length === 0,
    );
    expect(outcomes.filter(Boolean).length).toBeGreaterThanOrEqual(5);
    expect(outcomes.filter((ok) => !ok).length).toBeGreaterThanOrEqual(8);
  });
});
