// FILENAME: app/extensions/Charts/components/__tests__/ChartFormatPaneSections.test.ts
// PURPOSE: The Format pane's pure rules — which subject a selection is, which
//          tabs that subject offers, which tab survives a retarget, and how one
//          datum's override is merged into the spec's array.
// CONTEXT: THE TAB RULE IS THE PELTIER FIX AND IT IS TESTED AS A FUNCTION.
//          Excel 2010 threw the active section away on every selection change;
//          Peltier wrote it up as a named complaint. The remedy is that the
//          reader's last deliberate choice is remembered SEPARATELY from the
//          tab on screen, and the difference between the two only shows up
//          across THREE retargets — choose Text, pass through an element with
//          no Text tab, come back. A test that only checked "the tab is still
//          Text after one retarget" would pass against an implementation that
//          simply never changes the tab, which breaks the moment the tab does
//          not exist.
//
//          THE MERGE CASES ARE ABOUT WHAT IS *NOT* KEPT. `mergeDataPointOverrides`
//          is the only writer of `dataPointOverrides` in this pane, and its
//          dangerous outputs are the silent ones: an override left standing
//          with no visual property (an invisible husk that keeps a datum
//          pinned in the array forever), an empty array written where the field
//          should be absent, and a `key` not stamped on a write (which re-opens
//          the row-insert defect `dataPointKeyForDatum` exists to close).
//
//          NOTHING HERE TOUCHES THE STORE. The subject/tab/merge rules are
//          pure; the store-facing half — re-reading the spec at commit time —
//          is `ChartFormatPaneRetarget.test.tsx`, because it needs a render.

import { describe, expect, it, vi } from "vitest";

import { CHART_SELECTION_ELEMENT_IDS, type ChartSelectionSnapshot } from "@api/chartSelection";
import type { DataPointOverride } from "../../types";

// The module reaches the store and the renderer at import time only through
// these; the rules under test are pure, so the doubles need no behaviour.
vi.mock("../../lib/chartStore", () => ({
  getChartById: vi.fn(() => null),
  updateChartSpec: vi.fn(),
  syncChartRegions: vi.fn(),
}));
vi.mock("../../rendering/chartRenderer", () => ({
  getCachedChartData: vi.fn(() => null),
  invalidateChartCache: vi.fn(),
}));
vi.mock("../../handlers/selectionHandler", () => ({
  getCurrentChartId: vi.fn(() => null),
  getSubSelection: vi.fn(() => ({ level: "none" })),
}));
vi.mock("@api/events", () => ({
  AppEvents: { CHART_SELECTION_CHANGED: "app:chart-selection-changed", GRID_REFRESH: "app:grid-refresh" },
  emitAppEvent: vi.fn(),
  onAppEvent: vi.fn(() => () => undefined),
}));

import {
  formatSubjectOf,
  mergeDataPointOverrides,
  resolveActiveTab,
  tabsForSubject,
  type ChartFormatSubject,
  type ChartFormatTabId,
} from "../ChartFormatPane";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
/** A stand-in identity key. Its SHAPE is irrelevant here — this file tests that
 *  the merge STAMPS whatever key it is handed; the real separator is exercised
 *  end to end in ChartFormatPaneRetarget.test.tsx through `dataPointKey`. */
const KEY = "series-and-category";

function sel(over: Partial<ChartSelectionSnapshot>): ChartSelectionSnapshot {
  return {
    chartId: "c1",
    chartName: "Chart 1",
    level: "chart",
    displayName: "Chart 1",
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The subject
// ---------------------------------------------------------------------------

describe("what the pane is formatting", () => {
  it("is nothing when no chart is selected, whatever the level says", () => {
    expect(formatSubjectOf(sel({ chartId: null }))).toBe("none");
    expect(formatSubjectOf(sel({ chartId: null, level: "series", seriesIndex: 0 }))).toBe("none");
    expect(formatSubjectOf(sel({ level: "none" }))).toBe("none");
  });

  it("maps every datum/series/axis level to its subject", () => {
    expect(formatSubjectOf(sel({ level: "dataPoint" }))).toBe("dataPoint");
    expect(formatSubjectOf(sel({ level: "series" }))).toBe("series");
    expect(formatSubjectOf(sel({ level: "axis", axisType: "y" }))).toBe("axis");
    expect(formatSubjectOf(sel({ level: "chart" }))).toBe("chartArea");
  });

  it("answers for EVERY element id the contract names", () => {
    const answered = new Map<string, ChartFormatSubject>();
    for (const elementId of CHART_SELECTION_ELEMENT_IDS) {
      answered.set(elementId, formatSubjectOf(sel({ level: "element", elementId })));
    }
    expect(answered.get("title")).toBe("title");
    expect(answered.get("xAxisTitle")).toBe("xAxisTitle");
    expect(answered.get("yAxisTitle")).toBe("yAxisTitle");
    expect(answered.get("legend")).toBe("legend");
    expect(answered.get("legendEntry")).toBe("legendEntry");
    expect(answered.get("plotArea")).toBe("plotArea");
    // Both axis spellings reach the axis sections — the ladder can produce
    // either, and a pane that handled only one would show the chart area for
    // half of the axis clicks.
    expect(answered.get("xAxis")).toBe("axis");
    expect(answered.get("yAxis")).toBe("axis");
    // Furniture with no panel of its own falls back to the chart area, which
    // is what Excel does. `none` here means "the element level carries no id",
    // NOT "no chart is selected" — the chart IS selected in this fixture.
    expect(answered.get("chartArea")).toBe("chartArea");
    expect(answered.get("datum")).toBe("chartArea");
    expect(answered.get("filterButton")).toBe("chartArea");
    expect(answered.get("none")).toBe("chartArea");
    // ...and no id was left without an answer.
    expect(answered.size).toBe(CHART_SELECTION_ELEMENT_IDS.length);
    expect([...answered.values()].every((v) => typeof v === "string")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The tabs
// ---------------------------------------------------------------------------

const ALL_SUBJECTS: ChartFormatSubject[] = [
  "dataPoint",
  "series",
  "title",
  "xAxisTitle",
  "yAxisTitle",
  "axis",
  "legend",
  "legendEntry",
  "plotArea",
  "chartArea",
];

describe("the tab strip", () => {
  it("gives every real subject at least one tab — there is no empty pane", () => {
    for (const subject of ALL_SUBJECTS) {
      expect(tabsForSubject(subject).length, `${subject} offers no tab`).toBeGreaterThan(0);
    }
    expect(tabsForSubject("none")).toEqual([]);
  });

  it("offers no tab twice, and only tabs the pane can render", () => {
    const known: ChartFormatTabId[] = ["fill", "options", "text"];
    for (const subject of ALL_SUBJECTS) {
      const tabs = tabsForSubject(subject);
      expect(new Set(tabs).size).toBe(tabs.length);
      for (const tab of tabs) expect(known).toContain(tab);
    }
  });

  it("keeps a remembered tab the subject offers", () => {
    expect(resolveActiveTab(["fill", "options", "text"], "options")).toBe("options");
  });

  it("falls back to the subject's FIRST tab when the remembered one is gone", () => {
    // A title offers only Text; a plot area offers only Fill.
    expect(resolveActiveTab(tabsForSubject("plotArea"), "text")).toBe("fill");
    expect(resolveActiveTab(tabsForSubject("title"), "fill")).toBe("text");
  });

  it("RESTORES the remembered tab after passing through a subject that lacks it", () => {
    // This is the whole Peltier fix and it is only visible over three steps.
    const preferred: ChartFormatTabId = "text";
    const onAxis = resolveActiveTab(tabsForSubject("axis"), preferred);
    const onDatum = resolveActiveTab(tabsForSubject("dataPoint"), preferred);
    const backOnAxis = resolveActiveTab(tabsForSubject("axis"), preferred);

    expect(onAxis).toBe("text");
    expect(onDatum).toBe("fill"); // a data point has no Text tab
    expect(backOnAxis).toBe("text"); // ...and Text is not forgotten by the detour
  });

  it("answers null only when there is nothing to show", () => {
    expect(resolveActiveTab([], "fill")).toBeNull();
    expect(resolveActiveTab(tabsForSubject("series"), null)).toBe("fill");
  });
});

// ---------------------------------------------------------------------------
// The override merge
// ---------------------------------------------------------------------------

function override(over: Partial<DataPointOverride>): DataPointOverride {
  return { seriesIndex: 0, categoryIndex: 0, ...over };
}

describe("merging one datum's override", () => {
  it("adds a new override and stamps its identity key", () => {
    const out = mergeDataPointOverrides(undefined, 1, 2, KEY, { color: "#ff0000" });
    expect(out).toEqual([
      { seriesIndex: 1, categoryIndex: 2, key: KEY, color: "#ff0000" },
    ]);
  });

  it("leaves every OTHER override untouched", () => {
    const existing = [override({ seriesIndex: 0, categoryIndex: 0, color: "#111111" })];
    const out = mergeDataPointOverrides(existing, 1, 1, undefined, { color: "#222222" });
    expect(out).toHaveLength(2);
    expect(out?.[0]).toEqual({ seriesIndex: 0, categoryIndex: 0, color: "#111111" });
    // ...and it did not mutate the array it was given.
    expect(existing).toHaveLength(1);
  });

  it("updates the matching override in place rather than appending a second", () => {
    const existing = [override({ seriesIndex: 1, categoryIndex: 1, color: "#111111", opacity: 0.5 })];
    const out = mergeDataPointOverrides(existing, 1, 1, undefined, { color: "#222222" });
    expect(out).toEqual([
      { seriesIndex: 1, categoryIndex: 1, color: "#222222", opacity: 0.5 },
    ]);
  });

  it("stamps a key onto an override written before keys existed", () => {
    const existing = [override({ seriesIndex: 1, categoryIndex: 1, color: "#111111" })];
    const out = mergeDataPointOverrides(existing, 1, 1, "k", { opacity: 0.25 });
    expect(out?.[0].key).toBe("k");
  });

  it("CLEARS a property on an explicit undefined instead of storing a hole", () => {
    const existing = [override({ seriesIndex: 1, categoryIndex: 1, color: "#111111", opacity: 0.5 })];
    const out = mergeDataPointOverrides(existing, 1, 1, undefined, { color: undefined });
    expect(out?.[0]).toEqual({ seriesIndex: 1, categoryIndex: 1, opacity: 0.5 });
    expect("color" in (out?.[0] ?? {})).toBe(false);
  });

  it("REMOVES an override the last clear left with nothing to say", () => {
    const existing = [
      override({ seriesIndex: 0, categoryIndex: 0, color: "#111111" }),
      override({ seriesIndex: 1, categoryIndex: 1, color: "#222222", key: "k" }),
    ];
    const out = mergeDataPointOverrides(existing, 1, 1, "k", { color: undefined });
    // The husk is gone, not left behind carrying only its address and key.
    expect(out).toEqual([{ seriesIndex: 0, categoryIndex: 0, color: "#111111" }]);
  });

  it("returns undefined rather than an empty array when the last one goes", () => {
    const existing = [override({ seriesIndex: 1, categoryIndex: 1, color: "#222222" })];
    expect(mergeDataPointOverrides(existing, 1, 1, undefined, { color: undefined })).toBeUndefined();
  });

  it("never moves an override's address", () => {
    const existing = [override({ seriesIndex: 3, categoryIndex: 4, color: "#111111" })];
    const out = mergeDataPointOverrides(existing, 3, 4, undefined, { borderColor: "#000000" });
    expect(out?.[0].seriesIndex).toBe(3);
    expect(out?.[0].categoryIndex).toBe(4);
  });

  it("keeps an override alive on a FALSE-y-but-real value", () => {
    // `exploded: 0` and `opacity: 0` are values, not absences. A husk check
    // written as a truthiness test would delete both.
    const out = mergeDataPointOverrides(undefined, 0, 0, undefined, { opacity: 0 });
    expect(out).toEqual([{ seriesIndex: 0, categoryIndex: 0, opacity: 0 }]);
  });
});
