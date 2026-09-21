// FILENAME: app/extensions/Charts/components/__tests__/datumWriteAddress.test.ts
// PURPOSE: Close the LOOP on a per-point override: write it the way the Format
//          pane writes it, then resolve it the way the PAINTER resolves it, and
//          assert the colour lands on the datum that was clicked.
// CONTEXT: Every defect this file pins had the same signature — the reader sets
//          a colour, the control insists it is set, and the chart never
//          changes. Both halves were individually tested and both were right
//          about their own half:
//
//            * `radial-datumOverrides.test.ts` proves the PAINTERS honour an
//              override placed at (0, categoryIndex).
//            * `ChartFormatPaneSections.test.ts` proves the MERGE stores what
//              it is handed.
//
//          Nothing asked whether the address the pane writes is the address the
//          painter reads. It was not, for five marks: the radial hit geometry
//          stamps the CATEGORY into `seriesIndex` ("a slice IS its category"),
//          so the pane wrote at (i, i) while every painter read (0, i) — slice
//          0 worked by coincidence and nothing else did. A Pareto chart added a
//          second spelling of the same mistake through the identity KEY, and a
//          duplicated category label a third through the resolver's tie-break.
//
//          So these tests deliberately go END TO END through the two real
//          functions rather than asserting on an intermediate shape: a fix that
//          changes one side and not the other cannot make them pass.

import { describe, expect, it, vi, beforeEach } from "vitest";

import type { ChartSpec, ParsedChartData, DataPointOverride } from "../../types";

// ---------------------------------------------------------------------------
// Store / renderer doubles. `datumWriteTarget` reads BOTH: the parsed data (for
// the authoring translation and the identity key) and the spec (for the mark,
// which decides how the ladder's indices map onto the painter's).
// ---------------------------------------------------------------------------

let currentSpec: ChartSpec;
let currentData: ParsedChartData;

vi.mock("../../lib/chartStore", () => ({
  getChartById: vi.fn(() => ({ id: "c1", name: "Chart 1", spec: currentSpec })),
  updateChartSpec: vi.fn(),
  syncChartRegions: vi.fn(),
}));
vi.mock("../../rendering/chartRenderer", () => ({
  getCachedChartData: vi.fn(() => ({ data: currentData })),
  invalidateChartCache: vi.fn(),
}));
vi.mock("../../handlers/selectionHandler", () => ({
  getCurrentChartId: vi.fn(() => "c1"),
  getSubSelection: vi.fn(() => ({ level: "none" })),
}));
vi.mock("@api/events", () => ({
  AppEvents: { CHART_SELECTION_CHANGED: "app:chart-selection-changed", GRID_REFRESH: "app:grid-refresh" },
  emitAppEvent: vi.fn(),
  onAppEvent: vi.fn(() => () => undefined),
}));

import { datumWriteTarget, mergeDataPointOverrides } from "../ChartFormatPane";
import { resolveDatumStyle, dataPointKey } from "../../lib/dataPointOverrides";
import { paretoResolveView } from "../../rendering/paretoChartPainter";
import { computeSunburstBarRects } from "../../rendering/sunburstChartPainter";
import { computeBubblePointMarkers } from "../../rendering/bubbleChartPainter";
import { DEFAULT_CHART_THEME } from "../../rendering/chartTheme";
import type { ChartLayout } from "../../types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const RED = "#ff0000";

function makeSpec(mark: string, over: Partial<ChartSpec> = {}): ChartSpec {
  return {
    mark,
    data: { startRow: 0, startCol: 0, endRow: 4, endCol: 1, sheetIndex: 0 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [{ name: "Units", sourceIndex: 1, color: null }],
    title: null,
    xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    yAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    legend: { visible: false, position: "bottom" },
    palette: "default",
    ...over,
  } as ChartSpec;
}

function oneSeries(categories: string[], values: number[], name = "Units"): ParsedChartData {
  return { categories, series: [{ name, values, color: null }] };
}

/**
 * The whole round trip: the pane writes an override for the datum the ladder
 * reports, and the painter resolves the datum it paints. Returns the fills the
 * painter would use, indexed by the PAINTER's own category index.
 */
function writeThenPaint(
  hitSeriesIndex: number,
  hitCategoryIndex: number,
  paintView: ParsedChartData = currentData,
  existing?: DataPointOverride[],
): { fills: string[]; overrides: DataPointOverride[] | undefined } {
  const target = datumWriteTarget("c1", hitSeriesIndex, hitCategoryIndex);
  const overrides = mergeDataPointOverrides(
    existing,
    target.seriesIndex,
    target.categoryIndex,
    target.key,
    { color: RED },
  );
  const painted = { ...currentSpec, dataPointOverrides: overrides };
  const fills = paintView.categories.map(
    (_, i) => resolveDatumStyle(painted, paintView, 0, i, { fill: "#base" }).fill,
  );
  return { fills, overrides };
}

const LAYOUT: ChartLayout = {
  width: 600,
  height: 400,
  margin: { top: 20, right: 20, bottom: 40, left: 50 },
  plotArea: { x: 50, y: 20, width: 530, height: 340 },
};

// ---------------------------------------------------------------------------
// The radial family: the geometry stamps the CATEGORY into seriesIndex
// ---------------------------------------------------------------------------

describe("a per-point colour lands on the datum that was clicked (radial marks)", () => {
  for (const mark of ["pie", "donut", "funnel", "treemap", "sunburst"]) {
    it(`${mark}: colouring the THIRD datum colours the third datum`, () => {
      currentSpec = makeSpec(mark);
      currentData = oneSeries(["A", "B", "C", "D", "E"], [5, 4, 3, 2, 1]);

      // What the ladder carries for a radial datum: seriesIndex === the
      // CATEGORY, because `hitTestSliceArcs` reports `pointIndex:
      // arc.seriesIndex` and the bar-rect family stamps `seriesIndex:
      // tile.index`. That is the input this whole defect turns on.
      const { fills } = writeThenPaint(2, 2);

      expect(fills[2]).toBe(RED);
      expect(fills.filter((f) => f === RED)).toHaveLength(1);
    });

    it(`${mark}: the FIRST datum still works (it always did, by coincidence)`, () => {
      currentSpec = makeSpec(mark);
      currentData = oneSeries(["A", "B", "C", "D", "E"], [5, 4, 3, 2, 1]);
      const { fills } = writeThenPaint(0, 0);
      expect(fills[0]).toBe(RED);
      expect(fills.filter((f) => f === RED)).toHaveLength(1);
    });
  }

  it("a pie's override is stored at series 0, not at the slice index", () => {
    currentSpec = makeSpec("pie");
    currentData = oneSeries(["A", "B", "C", "D", "E"], [5, 4, 3, 2, 1]);
    const target = datumWriteTarget("c1", 3, 3);
    expect(target.seriesIndex).toBe(0);
    expect(target.categoryIndex).toBe(3);
    // ...and the key is nameable now, which it never was: `data.series[3]` does
    // not exist on a single-series pie, so the key came back undefined and the
    // override lost its row-insert resilience as well as its address.
    expect(target.key).toContain("Units");
    expect(target.key).toContain("D");
  });

  it("a bar chart is untouched: its ladder indices ARE the painter's", () => {
    currentSpec = makeSpec("bar", {
      series: [
        { name: "A", sourceIndex: 1, color: null },
        { name: "B", sourceIndex: 2, color: null },
      ],
    } as Partial<ChartSpec>);
    currentData = {
      categories: ["Jan", "Feb", "Mar"],
      series: [
        { name: "A", values: [1, 2, 3], color: null },
        { name: "B", values: [4, 5, 6], color: null },
      ],
    };
    const target = datumWriteTarget("c1", 1, 2);
    expect(target).toEqual({ seriesIndex: 1, categoryIndex: 2, key: expect.stringContaining("B") });
  });
});

// ---------------------------------------------------------------------------
// Pareto: the identity key must name the SORTED bar
// ---------------------------------------------------------------------------

describe("pareto: the key names the bar that was clicked, not the first source row", () => {
  beforeEach(() => {
    currentSpec = makeSpec("pareto", { series: [{ name: "Series", sourceIndex: 1, color: null }] } as Partial<ChartSpec>);
    // Sorted descending: [B(50), C(30), A(10)]. The tallest bar is B, and B is
    // NOT data.categories[0] — which is exactly the mismatch.
    currentData = oneSeries(["A", "B", "C"], [10, 50, 30], "Series");
  });

  it("colouring the tallest bar colours the tallest bar", () => {
    const view = paretoResolveView(currentData);
    expect(view.categories).toEqual(["B", "C", "A"]);

    const { fills } = writeThenPaint(0, 0, view);
    expect(fills[0]).toBe(RED); // B, the bar that was clicked
    expect(fills.filter((f) => f === RED)).toHaveLength(1);
  });

  it("the stamped key is the SORTED label", () => {
    const target = datumWriteTarget("c1", 0, 0);
    expect(target.key).toContain("B");
    expect(target.key).not.toContain("A");
  });
});

// ---------------------------------------------------------------------------
// Duplicate category labels
// ---------------------------------------------------------------------------

describe("a duplicated category label is still formattable", () => {
  beforeEach(() => {
    currentSpec = makeSpec("bar");
    // A duplicated label is ordinary in a sales range.
    currentData = oneSeries(["East", "North", "North", "West"], [1, 2, 3, 4]);
  });

  it("colouring the SECOND 'North' colours the second one", () => {
    const { fills, overrides } = writeThenPaint(0, 2);
    expect(fills[2]).toBe(RED);
    expect(fills[1]).not.toBe(RED);
    // No key: one key would name two datums and `buildOverrideIndex` awards it
    // to the FIRST, so stamping it makes the clicked datum unreachable.
    expect(overrides?.[0].key).toBeUndefined();
  });

  it("a UNIQUE label still gets its key, so a row insert cannot move the colour", () => {
    const { overrides } = writeThenPaint(0, 3);
    expect(overrides?.[0].key).toContain("West");
  });
});

// ---------------------------------------------------------------------------
// Re-formatting a datum whose override is currently key-matched
// ---------------------------------------------------------------------------

describe("re-formatting a key-matched datum edits it instead of shadowing it", () => {
  it("merges into the stored override rather than appending an unreachable twin", () => {
    currentSpec = makeSpec("bar");
    // "March" was coloured red at category index 2. A row was then inserted
    // above it, so March is index 3 now and the KEY is what rescues the colour.
    currentData = oneSeries(["Jan", "Feb", "Extra", "March"], [1, 2, 3, 4]);
    const stored: DataPointOverride[] = [
      { seriesIndex: 0, categoryIndex: 2, key: dataPointKey("Units", "March"), color: RED },
    ];
    // Prove the premise: the stale index is rescued by the key.
    expect(
      resolveDatumStyle({ ...currentSpec, dataPointOverrides: stored }, currentData, 0, 3, { fill: "#base" })
        .matchedBy,
    ).toBe("key");

    const target = datumWriteTarget("c1", 0, 3);
    const out = mergeDataPointOverrides(stored, target.seriesIndex, target.categoryIndex, target.key, {
      color: "#0000ff",
    });

    // ONE override, not two — a second one carrying the same key is a record
    // the resolver can never reach, so the edit would be persisted and
    // permanently invisible.
    expect(out).toHaveLength(1);
    expect(out?.[0].color).toBe("#0000ff");
    // ...and its address is repaired on the way through.
    expect(out?.[0].categoryIndex).toBe(3);

    const fill = resolveDatumStyle({ ...currentSpec, dataPointOverrides: out }, currentData, 0, 3, {
      fill: "#base",
    }).fill;
    expect(fill).toBe("#0000ff");
  });
});

// ---------------------------------------------------------------------------
// The geometry side of the same contract
// ---------------------------------------------------------------------------

describe("hit geometry addresses the datum the painter paints", () => {
  it("sunburst rects carry the node's CATEGORY, not its position in a flat walk", () => {
    const spec = makeSpec("sunburst");
    const data = oneSeries(["Tech > Phones", "Tech > Laptops", "Wear > Shoes"], [30, 20, 10]);
    const rects = computeSunburstBarRects(data, spec, LAYOUT, DEFAULT_CHART_THEME);

    // Every rect is series 0 — a sunburst has one series — and every LEAF names
    // its own source category. The inner aggregate rings terminate no category
    // and carry -1, exactly as the painter treats them (it resolves no override
    // for them at all).
    expect(rects.every((r) => r.seriesIndex === 0)).toBe(true);
    const leaves = rects.filter((r) => r.categoryIndex >= 0).map((r) => r.categoryIndex).sort();
    expect(leaves).toEqual([0, 1, 2]);
    expect(rects.some((r) => r.categoryIndex === -1)).toBe(true);
  });

  it("bubble markers carry the index in data.series, not in the size-filtered list", () => {
    const spec = makeSpec("bubble", {
      markOptions: { sizeSeriesIndex: 0 },
      series: [
        { name: "Size", sourceIndex: 1, color: null },
        { name: "A", sourceIndex: 2, color: null },
        { name: "B", sourceIndex: 3, color: null },
      ],
    } as Partial<ChartSpec>);
    const data: ParsedChartData = {
      categories: ["p", "q"],
      series: [
        { name: "Size", values: [1, 2], color: null },
        { name: "A", values: [3, 4], color: null },
        { name: "B", values: [5, 6], color: null },
      ],
    };
    const markers = computeBubblePointMarkers(data, spec, LAYOUT, DEFAULT_CHART_THEME);

    // The size series is FIRST here, so the filtered loop counter is one short
    // for every value series. `paintBubbleChart` resolves at the ORIGINAL index
    // (and picks its palette slot from it), so a geometry that reported the
    // loop counter named A's bubbles when the reader clicked B's.
    for (const m of markers) {
      expect(m.seriesIndex).toBe(data.series.findIndex((s) => s.name === m.seriesName));
    }
    expect(markers.some((m) => m.seriesIndex === 0)).toBe(false); // never the size series
  });
});
