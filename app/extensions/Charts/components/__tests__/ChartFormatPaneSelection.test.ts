// FILENAME: app/extensions/Charts/components/__tests__/ChartFormatPaneSelection.test.ts
// PURPOSE: The published `@api/chartSelection` registry — its vocabulary, its
//          derived display name, and the fact that it notifies only on a real
//          change.
// CONTEXT: THE DRIFT CASE IS THE POINT OF THE FILE. `@api` may never import
//          from `app/extensions`, so the element vocabulary is necessarily
//          spelled twice — once in `app/src/api/chartSelection.ts` and once as
//          `CHART_ELEMENT_IDS` in `app/extensions/Charts/types.ts`. Two
//          spellings of one fact is the exact defect CI-7 removed from the hit
//          union, where "title" and "legend" sat for a year with no producer,
//          guarded only by a test that counted the members.
//
//          So this does not count anything. It READS the extension's types.ts
//          at test time, parses the array out of it, and asserts SET EQUALITY
//          in both directions:
//
//            * declared-in-API minus declared-in-Charts = an element the
//              published contract names and nothing can ever select.
//            * declared-in-Charts minus declared-in-API = an element the
//              selection ladder can reach and no reader outside Charts can be
//              told about — the Insights pane would see a level it cannot name.
//
//          The COMPILER already covers Charts -> API at the publish site
//          (`publishCurrentChartSelection` passes `sub.elementId`, typed
//          `ChartElementId`), so the direction that needs a test is the one the
//          compiler cannot see: a member added HERE with no counterpart there.
//          Both are asserted anyway, because a test that relies on a compile
//          error is a test that passes in a repo nobody typechecks.
//
//          THE DISPLAY-NAME CASES ARE EXHAUSTIVE OVER THE VOCABULARY, not a
//          spot check. Every element id is asked for its name and the answers
//          must be DISTINCT wherever the elements are distinct — a name
//          function that collapsed three elements onto "Chart 1" would satisfy
//          any per-case assertion written one at a time.

import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CHART_SELECTION_ELEMENT_IDS,
  EMPTY_CHART_SELECTION,
  chartSelectionDisplayName,
  getChartSelection,
  onChartSelectionChanged,
  publishChartSelection,
  resetChartSelectionRegistry,
  type ChartSelectionElementId,
  type ChartSelectionTarget,
} from "@api/chartSelection";

afterEach(() => {
  resetChartSelectionRegistry();
});

// ---------------------------------------------------------------------------
// The vocabulary must not drift from the extension's own
// ---------------------------------------------------------------------------

/** The `CHART_ELEMENT_IDS` array as the Charts extension declares it, read from disk. */
function chartsElementIds(): string[] {
  const typesPath = path.resolve(__dirname, "../../types.ts");
  const source = readFileSync(typesPath, "utf8");
  const match = /export const CHART_ELEMENT_IDS = \[([\s\S]*?)\] as const;/.exec(source);
  if (match === null) {
    throw new Error(
      "CHART_ELEMENT_IDS was not found in app/extensions/Charts/types.ts — the drift " +
        "guard cannot see the other spelling, so it is not guarding anything.",
    );
  }
  return [...match[1].matchAll(/"([a-zA-Z]+)"/g)].map((m) => m[1]);
}

describe("the element vocabulary", () => {
  it("finds a non-trivial array in the extension (the guard has something to compare)", () => {
    const ids = chartsElementIds();
    expect(ids.length).toBeGreaterThan(5);
    expect(ids).toContain("chartArea");
  });

  it("is the same SET as the Charts extension's, in both directions", () => {
    const api = [...CHART_SELECTION_ELEMENT_IDS].sort();
    const charts = chartsElementIds().sort();

    const apiOnly = api.filter((id) => !charts.includes(id));
    const chartsOnly = charts.filter((id) => !api.includes(id as ChartSelectionElementId));

    expect(apiOnly, "named by @api/chartSelection but not produced by Charts").toEqual([]);
    expect(chartsOnly, "produced by Charts but unnameable through @api").toEqual([]);
    expect(api).toEqual(charts);
  });

  it("has no duplicate members", () => {
    expect(new Set(CHART_SELECTION_ELEMENT_IDS).size).toBe(CHART_SELECTION_ELEMENT_IDS.length);
  });
});

// ---------------------------------------------------------------------------
// The display name
// ---------------------------------------------------------------------------

function target(over: Partial<ChartSelectionTarget>): ChartSelectionTarget {
  return { chartId: "c1", chartName: "Chart 1", level: "chart", ...over };
}

describe("the display name", () => {
  it("is empty when nothing is selected", () => {
    expect(chartSelectionDisplayName({ chartId: null, chartName: null, level: "none" })).toBe("");
    expect(chartSelectionDisplayName(target({ level: "none" }))).toBe("");
  });

  it("names the CHART AREA at chart level, qualified by which chart it is", () => {
    // Excel's Name Box says "Chart Area" here and this said the chart's name,
    // so the reader was never told the element's name by the one surface whose
    // job is naming elements. It is QUALIFIED rather than bare because we have
    // a single Name Box and it is also the only surface that says WHICH chart
    // is selected — so the element name is ADDED, not traded for the object's.
    expect(chartSelectionDisplayName(target({ level: "chart" }))).toBe("Chart 1 Chart Area");
  });

  it("gives the two routes to the chart area ONE spelling", () => {
    // `level: "chart"` and `elementId: "chartArea"` are one rung reached two
    // ways. They used to answer separately and agree only by accident (both
    // printed the chart's name, and both were wrong).
    const viaLevel = chartSelectionDisplayName(target({ level: "chart" }));
    const viaElement = chartSelectionDisplayName(
      target({ level: "element", elementId: "chartArea" }),
    );
    expect(viaElement).toBe(viaLevel);
  });

  it("degrades to the bare element name when no chart name is known", () => {
    expect(
      chartSelectionDisplayName({ chartId: "c1", chartName: null, level: "chart" }),
    ).toBe("Chart Area");
  });

  it("uses Excel's ordinal wording, and adds the name when one is known", () => {
    expect(chartSelectionDisplayName(target({ level: "series", seriesIndex: 0 }))).toBe("Series 1");
    expect(
      chartSelectionDisplayName(target({ level: "series", seriesIndex: 0, seriesName: "Sales" })),
    ).toBe('Series 1 "Sales"');
    // The brief's own example: the ordinal is never dropped, because it is the
    // rung the reader cannot otherwise see.
    expect(
      chartSelectionDisplayName(target({ level: "dataPoint", seriesIndex: 0, categoryIndex: 2 })),
    ).toBe("Series 1 Point 3");
    expect(
      chartSelectionDisplayName(
        target({
          level: "dataPoint",
          seriesIndex: 0,
          categoryIndex: 2,
          seriesName: "Sales",
          categoryName: "Mar",
        }),
      ),
    ).toBe('Series 1 "Sales" Point 3 "Mar"');
  });

  it("names each axis the way Excel does", () => {
    expect(chartSelectionDisplayName(target({ level: "axis", axisType: "x" }))).toBe(
      "Horizontal (Category) Axis",
    );
    expect(chartSelectionDisplayName(target({ level: "axis", axisType: "y" }))).toBe(
      "Vertical (Value) Axis",
    );
  });

  it("answers for EVERY element id, and keeps the distinct ones distinct", () => {
    const names = new Map<ChartSelectionElementId, string>();
    for (const elementId of CHART_SELECTION_ELEMENT_IDS) {
      const name = chartSelectionDisplayName(
        target({ level: "element", elementId, seriesIndex: 0 }),
      );
      expect(name, `no display name for "${elementId}"`).not.toBe("");
      names.set(elementId, name);
    }

    // The elements that mean different things must READ differently. Only
    // "chartArea", "datum" and "none" deliberately collapse onto the CHART
    // AREA's name, because at element level none of them names anything finer
    // than the canvas.
    const distinct = [
      "title",
      "xAxisTitle",
      "yAxisTitle",
      "legend",
      "legendEntry",
      "plotArea",
      "filterButton",
      "xAxis",
      "yAxis",
    ] as const;
    const spoken = distinct.map((id) => names.get(id));
    expect(new Set(spoken).size).toBe(distinct.length);

    expect(names.get("title")).toBe("Chart Title");
    expect(names.get("xAxisTitle")).toBe("Horizontal (Category) Axis Title");
    expect(names.get("yAxisTitle")).toBe("Vertical (Value) Axis Title");
    expect(names.get("legend")).toBe("Legend");
    expect(names.get("legendEntry")).toBe("Series 1 Legend Entry");
    // The plot area and the chart area are DIFFERENT regions and must never
    // read the same: that confusion is exactly what made one of them
    // unreachable by mouse for as long as it did.
    expect(names.get("plotArea")).toBe("Plot Area");
    expect(names.get("chartArea")).toBe("Chart 1 Chart Area");
    expect(names.get("plotArea")).not.toBe(names.get("chartArea"));
    expect(names.get("datum")).toBe("Chart 1 Chart Area");
    expect(names.get("none")).toBe("Chart 1 Chart Area");
  });
});

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

describe("the registry", () => {
  it("starts empty and comes back empty after a clear", () => {
    expect(getChartSelection()).toEqual(EMPTY_CHART_SELECTION);
  });

  it("derives the display name itself — a publisher cannot supply a contradicting one", () => {
    publishChartSelection({
      ...target({ level: "dataPoint", seriesIndex: 1, categoryIndex: 0 }),
      // A publisher trying to smuggle a name in: the field is not on the
      // target type, and the registry computes its own regardless.
      ...({ displayName: "Chart Area" } as Record<string, unknown>),
    } as ChartSelectionTarget);
    expect(getChartSelection().displayName).toBe("Series 2 Point 1");
  });

  it("notifies on a change and NOT on a republish of the same rung", () => {
    const seen: string[] = [];
    const off = onChartSelectionChanged((snapshot) => seen.push(snapshot.displayName));

    publishChartSelection(target({ level: "series", seriesIndex: 0 }));
    publishChartSelection(target({ level: "series", seriesIndex: 0 }));
    publishChartSelection(target({ level: "series", seriesIndex: 1 }));
    expect(seen).toEqual(["Series 1", "Series 2"]);

    off();
    publishChartSelection(target({ level: "chart" }));
    expect(seen).toEqual(["Series 1", "Series 2"]);
  });

  it("clears on null, and tells the listeners it did", () => {
    publishChartSelection(target({ level: "series", seriesIndex: 0 }));
    const seen: Array<string | null> = [];
    onChartSelectionChanged((snapshot) => seen.push(snapshot.chartId));

    publishChartSelection(null);
    expect(seen).toEqual([null]);
    expect(getChartSelection()).toEqual(EMPTY_CHART_SELECTION);

    // A second clear is not a change.
    publishChartSelection(null);
    expect(seen).toEqual([null]);
  });

  it("treats a target with no chart id as a clear", () => {
    publishChartSelection(target({ level: "series", seriesIndex: 0 }));
    publishChartSelection({ chartId: null, chartName: null, level: "chart" });
    expect(getChartSelection()).toEqual(EMPTY_CHART_SELECTION);
  });

  it("hands the snapshot to every listener even when one of them throws", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const good = vi.fn();
    onChartSelectionChanged(() => {
      throw new Error("a bad reader's bad day");
    });
    onChartSelectionChanged(good);

    expect(() => publishChartSelection(target({ level: "chart" }))).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("publishes a frozen snapshot, so a reader cannot edit everyone else's copy", () => {
    publishChartSelection(target({ level: "chart" }));
    const snapshot = getChartSelection() as { chartName: string | null };
    expect(() => {
      snapshot.chartName = "hijacked";
    }).toThrow();
    expect(getChartSelection().chartName).toBe("Chart 1");
  });
});
