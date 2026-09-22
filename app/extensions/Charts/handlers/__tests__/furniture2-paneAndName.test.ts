//! FILENAME: app/extensions/Charts/handlers/__tests__/furniture2-paneAndName.test.ts
// PURPOSE: The in-plot furniture has a NAME the reader can read and a Format
//          pane SUBJECT with real tabs — the two surfaces that turn "something
//          is selected" into "I know what I am about to change".
//
// WHY THE NAME CARRIES AN ORDINAL. A series can carry a linear fit and a moving
// average at once. Before `trendlineIndex` existed, both were the same
// `ChartSelectionTarget`, which has two consequences and neither is cosmetic:
// the Name Box prints one name for two objects, and `publishChartSelection`'s
// own change test — field-by-field equality — suppresses the republish, so the
// Format pane never retargets when the reader walks from one line to the other.
// The pane would sit there editing the first fit while the second was
// highlighted.
//
// WHY THERE ARE NO DEAD TABS. ChartFormatPane's header forbids a tab with no
// fields, on the stated ground that Effects and Size & Properties would be
// empty for every element because the spec records neither. The same bar
// applies here: `DataTableOptions` styles no text, so the data table offers no
// Text tab.

import { describe, it, expect } from "vitest";
import {
  chartSelectionDisplayName,
  type ChartSelectionTarget,
} from "@api/chartSelection";
import {
  formatSubjectOf,
  tabsForSubject,
  type ChartFormatSubject,
} from "../../components/ChartFormatPane";
import type { ChartSelectionSnapshot } from "@api/chartSelection";

function target(over: Partial<ChartSelectionTarget>): ChartSelectionTarget {
  return { chartId: "c1", chartName: "Chart 1", level: "element", ...over };
}

function snapshot(over: Partial<ChartSelectionSnapshot>): ChartSelectionSnapshot {
  return { chartId: "c1", chartName: "Chart 1", level: "element", displayName: "", ...over };
}

// ===========================================================================

describe("the display name names ONE object", () => {
  it("numbers a trendline, so two fits on one series read differently", () => {
    const a = chartSelectionDisplayName(
      target({ elementId: "trendline", seriesIndex: 0, seriesName: "Sales", trendlineIndex: 0 }),
    );
    const b = chartSelectionDisplayName(
      target({ elementId: "trendline", seriesIndex: 0, seriesName: "Sales", trendlineIndex: 1 }),
    );
    expect(a).toBe('Series 1 "Sales" Trendline 1');
    expect(b).toBe('Series 1 "Sales" Trendline 2');
    expect(a).not.toBe(b);
  });

  it("degrades to the bare word when no ordinal travelled", () => {
    expect(chartSelectionDisplayName(target({ elementId: "trendline", seriesIndex: 2 }))).toBe(
      "Series 3 Trendline",
    );
  });

  it("names a data label's POINT, because there is one per point", () => {
    expect(
      chartSelectionDisplayName(
        target({
          elementId: "dataLabel",
          seriesIndex: 0,
          seriesName: "Sales",
          categoryIndex: 2,
          categoryName: "Mar",
        }),
      ),
    ).toBe('Series 1 "Sales" Point 3 "Mar" Data Label');
  });

  it("NEVER grows a category on error bars — Excel has no per-point error bar", () => {
    // The category is deliberately supplied here and must be ignored: a name
    // that said "Point 3 Error Bars" would promise an object the Format pane
    // cannot target and Delete cannot remove.
    const name = chartSelectionDisplayName(
      target({ elementId: "errorBars", seriesIndex: 1, seriesName: "Cost", categoryIndex: 2, categoryName: "Mar" }),
    );
    expect(name).toBe('Series 2 "Cost" Error Bars');
    expect(name).not.toMatch(/Point/);
  });

  it("names the data table with no index, because there is one of it", () => {
    expect(chartSelectionDisplayName(target({ elementId: "dataTable" }))).toBe("Data Table");
  });
});

// ===========================================================================

describe("the Format pane targets the furniture", () => {
  it("maps each element id to its own subject, never to the chart area", () => {
    // Falling back to `chartArea` is what the pane does for furniture it has no
    // panel for; four elements landing there would mean the reader selects a
    // trendline and is offered the chart's background colour.
    const cases: Array<[string, ChartFormatSubject]> = [
      ["trendline", "trendline"],
      ["errorBars", "errorBars"],
      ["dataLabel", "dataLabel"],
      ["dataTable", "dataTable"],
    ];
    for (const [elementId, subject] of cases) {
      expect(formatSubjectOf(snapshot({ elementId: elementId as never }))).toBe(subject);
    }
  });

  it("offers at least one tab for each, and no tab that is empty for it", () => {
    for (const subject of ["trendline", "errorBars", "dataLabel", "dataTable"] as ChartFormatSubject[]) {
      const tabs = tabsForSubject(subject);
      expect(tabs.length, `${subject} must offer a tab`).toBeGreaterThan(0);
      expect(new Set(tabs).size, `${subject} lists no tab twice`).toBe(tabs.length);
    }
    // Options first for all four, as for an axis: a reader who selected a
    // trendline came for its TYPE, not its dash pattern.
    expect(tabsForSubject("trendline")[0]).toBe("options");
    expect(tabsForSubject("errorBars")[0]).toBe("options");
    expect(tabsForSubject("dataLabel")[0]).toBe("options");
    // The data table styles no text, so it has no Text tab to be empty.
    expect(tabsForSubject("dataTable")).toEqual(["options"]);
    expect(tabsForSubject("trendline")).not.toContain("text");
  });

  it("every ChartFormatSubject still has tabs, so a new subject cannot be dead", () => {
    const all: ChartFormatSubject[] = [
      "dataPoint", "series", "title", "xAxisTitle", "yAxisTitle", "axis", "legend",
      "legendEntry", "plotArea", "chartArea", "trendline", "errorBars", "dataLabel",
      "dataTable", "none",
    ];
    for (const subject of all) {
      const tabs = tabsForSubject(subject);
      if (subject === "none") expect(tabs).toEqual([]);
      else expect(tabs.length, `${subject} has no tab at all`).toBeGreaterThan(0);
    }
  });
});
