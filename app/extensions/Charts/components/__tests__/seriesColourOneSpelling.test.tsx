//! FILENAME: app/extensions/Charts/components/__tests__/seriesColourOneSpelling.test.tsx
// PURPOSE: OB-1 — "when I select an individual data point and give it a color I
//          cannot select a color for the entire series after that."
// CONTEXT:
//          THE COLOUR OF A SERIES HAD TWO SPELLINGS AND THE FORMAT PANE WROTE
//          THE LOSING ONE. `spec.seriesColors[name]` (name-keyed, what the
//          ribbon Design panel and the dialog's Design tab write) is applied
//          onto `data.series[i].color` when the data is resolved, so it WINS
//          over `spec.series[i].color` (index-keyed, what the Format pane's
//          series swatch wrote). Once a series colour had ever been set from
//          the Design panel, the Format pane's swatch was silently overridden
//          and looked dead.
//
//          AND IT BAILED ENTIRELY WHEN THERE WAS NO `spec.series` ENTRY. A
//          pivot, design-query or encoding-compiled chart carries `series: []`
//          in the spec — the series are produced by the reader — so
//          `spec.series?.[i] === undefined` and the patch returned null. The
//          swatch wrote nothing at all and reported nothing.
//
//          WHAT THIS FILE PROVES. The ONE spelling is `seriesColors`, keyed by
//          the series NAME, read and written through `readSeriesColor` /
//          `seriesColorPatch` in lib/chartDataReader.ts by every UI surface.
//          Each test below is written so that it FAILS against the two-spelling
//          code: the read-backs would show the fallback, the writes would land
//          in `spec.series[].color`, and the Design panel's "Auto" button would
//          be a no-op because `deepMergeSpec` merges a record field by field
//          and therefore keeps a key the caller deleted.
//
//          THE POINT-THEN-SERIES CASE IS EXCEL'S, NOT A BUG. A per-datum
//          override outranks the series colour, so setting a series colour
//          recolours every OTHER point and leaves the overridden one alone.
//          That is correct, and the remedy for it LOOKING broken is to say so
//          in the pane — which is why there is a test for the sentence.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ----------------------------------------------------------------------------
// Doubles. The chart STORE is real — the merge semantics it applies to a patch
// are half of what is under test (the "Auto" button's deleted key).
// ----------------------------------------------------------------------------

vi.mock("@api/dialogs", () => ({ alertAsync: vi.fn(() => Promise.resolve()) }));

/** Mutable per test: a pivot-shaped chart has parsed series and no spec ones. */
let cachedSeries: Array<{ name: string; color?: string | null }> = [];
let cachedCategories: string[] = [];

const invalidateChartCache = vi.fn();
vi.mock("../../rendering/chartRenderer", () => ({
  getCachedChartData: () => ({
    data: { series: cachedSeries, categories: cachedCategories },
  }),
  invalidateChartCache: (id: string) => invalidateChartCache(id),
}));

let currentChartId: string | null = null;
vi.mock("../../handlers/selectionHandler", () => ({
  getCurrentChartId: () => currentChartId,
  getSubSelection: () => ({ level: "none" }),
}));

vi.mock("@api/events", () => ({
  AppEvents: {
    CHART_SELECTION_CHANGED: "app:chart-selection-changed",
    GRID_REFRESH: "app:grid-refresh",
    MUTATION_REFRESH: "app:mutation-refresh",
  },
  emitAppEvent: vi.fn(),
  onAppEvent: vi.fn(() => () => undefined),
}));

vi.mock("@api/gridOverlays", () => ({
  removeGridRegionsByType: vi.fn(),
  addGridRegions: vi.fn(),
}));

vi.mock("@api", () => ({
  showDialog: vi.fn(),
  emitAppEvent: vi.fn(),
  onAppEvent: vi.fn(() => () => undefined),
  AppEvents: {
    CHART_SELECTION_CHANGED: "app:chart-selection-changed",
    GRID_REFRESH: "app:grid-refresh",
    MUTATION_REFRESH: "app:mutation-refresh",
  },
  indexToCol: (n: number) => String(n),
  isSandboxTransformMounted: () => false,
  runSandboxTransform: vi.fn(),
}));
vi.mock("../../manifest", () => ({
  CHART_DIALOG_ID: "chart:createDialog",
  CHART_DESIGN_TAB_ID: "chart:design",
}));

import { ChartFormatPane } from "../ChartFormatPane";
import { SeriesColorsSection } from "../ChartDesignSections";
import { DesignTab } from "../tabs/DesignTab";
import { DataTab } from "../tabs/DataTab";
import {
  readSeriesColor,
  seriesColorPatch,
  seriesNameArity,
} from "../../lib/chartDataReader";
import {
  getChartById,
  loadChartsFromBackend,
  resetChartStore,
  updateChartSpec,
} from "../../lib/chartStore";
import { chartsBackend } from "../../lib/chartsBackend";
import { publishChartSelection, resetChartSelectionRegistry } from "@api/chartSelection";
import { dataPointKey } from "../../lib/dataPointOverrides";
import type { ChartSpec } from "../../types";

const ID = "chart-series-colour-1";
const PICKED = "#ed7d31";

function fixtureSpec(extra: Partial<ChartSpec> = {}): ChartSpec {
  return {
    mark: "bar",
    data: "Sheet1!A1:C4",
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [
      { name: "Revenue", sourceIndex: 1, color: null },
      { name: "Cost", sourceIndex: 2, color: null },
    ],
    title: "Colours",
    xAxis: {},
    yAxis: {},
    legend: { visible: true, position: "right" },
    palette: "default",
    ...extra,
  } as unknown as ChartSpec;
}

const invokeBackend = vi.fn();

async function seed(spec: ChartSpec): Promise<void> {
  invokeBackend.mockImplementation(async (command: string) => {
    if (command === "get_charts") {
      return [
        {
          id: ID,
          sheetIndex: 0,
          specJson: JSON.stringify({
            chartId: ID,
            name: "Chart 1",
            sheetIndex: 0,
            x: 10,
            y: 20,
            width: 400,
            height: 300,
            spec,
          }),
        },
      ];
    }
    return undefined;
  });
  await loadChartsFromBackend();
  invokeBackend.mockClear();
}

function liveSpec(): ChartSpec {
  const chart = getChartById(ID);
  if (chart === null) throw new Error("fixture chart is gone");
  return chart.spec;
}

// ----------------------------------------------------------------------------
// Rendering harness
// ----------------------------------------------------------------------------

let container: HTMLDivElement;
let root: Root | null = null;

async function render(node: React.ReactElement): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(node);
  });
}

async function unmount(): Promise<void> {
  if (root === null) return;
  const r = root;
  root = null;
  await act(async () => {
    r.unmount();
  });
  container.remove();
}

function colourInput(label: string): HTMLInputElement {
  const el = container.querySelector(`input[aria-label="${label}"]`);
  if (el === null) throw new Error(`no colour input labelled "${label}"`);
  return el as HTMLInputElement;
}

function swatch(field: string, hex: string): HTMLElement {
  const strip = container.querySelector(`[data-chart-swatches="${field}"]`);
  if (strip === null) throw new Error(`no swatch strip for "${field}"`);
  const el = strip.querySelector(`[data-chart-swatch="${hex}"]`);
  if (el === null) throw new Error(`no swatch ${hex} in "${field}"`);
  return el as HTMLElement;
}

async function clickEl(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

async function setColour(el: HTMLInputElement, hex: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(el, hex);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function selectSeries(index = 1, name = "Cost"): void {
  publishChartSelection({
    chartId: ID,
    chartName: "Chart 1",
    level: "series",
    seriesIndex: index,
    seriesName: name,
  });
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetChartStore();
  resetChartSelectionRegistry();
  invokeBackend.mockReset();
  invalidateChartCache.mockClear();
  chartsBackend.set(invokeBackend);
  currentChartId = ID;
  cachedSeries = [{ name: "Revenue" }, { name: "Cost" }];
  cachedCategories = ["Jan", "Feb", "Mar"];
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  await unmount();
  warnSpy.mockRestore();
  resetChartStore();
  resetChartSelectionRegistry();
});

// ============================================================================
// The resolver itself — ONE reader, ONE writer
// ============================================================================

describe("seriesColorPatch / readSeriesColor — the one spelling", () => {
  it("writes the name-keyed field, never spec.series[].color", () => {
    const spec = fixtureSpec();
    const patch = seriesColorPatch(spec, "Cost", PICKED);
    expect(patch).toEqual({ seriesColors: { Cost: PICKED } });
    expect(patch).not.toHaveProperty("series");
  });

  it("keeps sibling series' colours when one is set", () => {
    const spec = fixtureSpec({ seriesColors: { Revenue: "#123456" } });
    expect(seriesColorPatch(spec, "Cost", PICKED)).toEqual({
      seriesColors: { Revenue: "#123456", Cost: PICKED },
    });
  });

  it("clears a colour by writing the key as undefined, because a record MERGES", () => {
    // `deepMergeSpec` merges plain objects field by field, so a patch that
    // simply left the key out would keep the colour it promised to remove.
    const spec = fixtureSpec({ seriesColors: { Revenue: "#123456", Cost: PICKED } });
    const patch = seriesColorPatch(spec, "Cost", null);
    expect(patch).not.toBeNull();
    expect(Object.keys(patch!.seriesColors!)).toContain("Cost");
    expect(patch!.seriesColors!.Cost).toBeUndefined();
    expect(patch!.seriesColors!.Revenue).toBe("#123456");
  });

  it("drops the whole field when the last colour is cleared", () => {
    const spec = fixtureSpec({ seriesColors: { Cost: PICKED } });
    expect(seriesColorPatch(spec, "Cost", null)).toEqual({ seriesColors: undefined });
  });

  it("commits nothing when there is nothing to clear", () => {
    expect(seriesColorPatch(fixtureSpec(), "Cost", null)).toBeNull();
  });

  it("refuses a series it cannot name", () => {
    expect(seriesColorPatch(fixtureSpec(), undefined, PICKED)).toBeNull();
    expect(seriesColorPatch(fixtureSpec(), "", PICKED)).toBeNull();
  });

  it("reads back exactly what it wrote, and nothing for an unset series", () => {
    const spec = fixtureSpec({ seriesColors: { Cost: PICKED } });
    expect(readSeriesColor(spec, "Cost")).toBe(PICKED);
    expect(readSeriesColor(spec, "Revenue")).toBeUndefined();
    expect(readSeriesColor(spec, undefined)).toBeUndefined();
  });

  it("counts how many parsed series answer to a name", () => {
    const data = { series: [{ name: "Cost" }, { name: "Cost" }, { name: "Revenue" }] };
    expect(seriesNameArity(data, "Cost")).toBe(2);
    expect(seriesNameArity(data, "Revenue")).toBe(1);
    expect(seriesNameArity(data, "Margin")).toBe(0);
    expect(seriesNameArity(data, undefined)).toBe(0);
  });
});

// ============================================================================
// (a) The Format pane wrote the losing spelling
// ============================================================================

describe("OB-1(a) the Format pane and the Design panel agree", () => {
  it("READS BACK a colour the Design panel set", async () => {
    await seed(fixtureSpec({ seriesColors: { Cost: "#123456" } }));
    selectSeries();
    await render(React.createElement(ChartFormatPane, {} as never));

    // Before the fix this showed the #4472c4 fallback: the pane read
    // spec.series[1].color, which the Design panel never touches.
    expect(colourInput("Colour").value).toBe("#123456");
  });

  it("writes a colour the Design panel READS BACK", async () => {
    await seed(fixtureSpec());
    selectSeries();
    await render(React.createElement(ChartFormatPane, {} as never));

    await clickEl(swatch("Colour", PICKED));

    expect(liveSpec().seriesColors).toEqual({ Cost: PICKED });
    // The losing spelling is left alone, so nothing can out-rank the write.
    expect(liveSpec().series[1].color).toBeNull();

    await unmount();
    await render(React.createElement(SeriesColorsSection, {} as never));
    const select = container.querySelector("select") as HTMLSelectElement;
    await act(async () => {
      select.value = "1";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect((container.querySelector('input[type="color"]') as HTMLInputElement).value).toBe(
      PICKED,
    );
  });

  it("is not out-ranked by a stale spec.series[].color", async () => {
    // The shape the defect left behind: an index-keyed colour already stored.
    await seed(fixtureSpec({ series: [
      { name: "Revenue", sourceIndex: 1, color: null },
      { name: "Cost", sourceIndex: 2, color: "#999999" },
    ] } as Partial<ChartSpec>));
    selectSeries();
    await render(React.createElement(ChartFormatPane, {} as never));

    await clickEl(swatch("Colour", PICKED));

    // The name-keyed colour is what the reader applies, so the chart obeys it.
    expect(readSeriesColor(liveSpec(), "Cost")).toBe(PICKED);
  });
});

// ============================================================================
// (b) The patch bailed when there was no spec.series entry
// ============================================================================

describe("OB-1(b) a series with no spec.series entry", () => {
  it("colours a pivot-shaped chart whose spec carries no series at all", async () => {
    await seed(fixtureSpec({ series: [] } as Partial<ChartSpec>));
    selectSeries();
    await render(React.createElement(ChartFormatPane, {} as never));

    await clickEl(swatch("Colour", PICKED));

    // Before the fix `spec.series?.[1] === undefined` made this a silent no-op.
    expect(liveSpec().seriesColors).toEqual({ Cost: PICKED });
  });

  it("says so instead of offering a dead swatch when the series has no name", async () => {
    cachedSeries = [];
    await seed(fixtureSpec({ series: [] } as Partial<ChartSpec>));
    publishChartSelection({
      chartId: ID,
      chartName: "Chart 1",
      level: "series",
      seriesIndex: 1,
    });
    await render(React.createElement(ChartFormatPane, {} as never));

    expect(container.querySelector('[data-chart-swatches="Colour"]')).toBeNull();
    expect(container.textContent).toContain("cannot be named");
  });
});

// ============================================================================
// A radial mark has no series fill at all
// ============================================================================

describe("OB-1 radial marks", () => {
  it("offers no series swatch on a pie, because the painter reads the palette per slice", async () => {
    cachedSeries = [{ name: "Share" }];
    await seed(fixtureSpec({ mark: "pie" } as Partial<ChartSpec>));
    publishChartSelection({
      chartId: ID,
      chartName: "Chart 1",
      level: "series",
      seriesIndex: 0,
      seriesName: "Share",
    });
    await render(React.createElement(ChartFormatPane, {} as never));

    expect(container.querySelector('[data-chart-swatches="Colour"]')).toBeNull();
    expect(container.textContent).toContain("slice");
  });
});

// ============================================================================
// The point-then-series case the owner actually described
// ============================================================================

describe("OB-1 a per-point override outranks the series colour, and the pane says so", () => {
  it("keeps the override and tells the reader how many points carry one", async () => {
    await seed(
      fixtureSpec({
        dataPointOverrides: [
          {
            seriesIndex: 1,
            categoryIndex: 2,
            key: dataPointKey("Cost", "Mar"),
            color: "#123456",
          },
        ],
      } as Partial<ChartSpec>),
    );
    selectSeries();
    await render(React.createElement(ChartFormatPane, {} as never));

    // The sentence exists BEFORE the series colour is set — this is what makes
    // the behaviour legible rather than looking like a dead control.
    expect(container.textContent).toContain("1 point in this series has its own colour");

    await clickEl(swatch("Colour", PICKED));

    expect(liveSpec().seriesColors).toEqual({ Cost: PICKED });
    // Excel's precedence: the overridden point is untouched.
    expect(liveSpec().dataPointOverrides?.[0].color).toBe("#123456");
  });

  it("offers the escape hatch the sentence points at, scoped to the series", async () => {
    // The other half of "say so rather than change the precedence": a reader
    // told that a point keeps its own colour needs the action that clears it,
    // in reach and ENABLED. A sentence with a dead button beside it is worse
    // than no sentence.
    await seed(
      fixtureSpec({
        dataPointOverrides: [
          {
            seriesIndex: 1,
            categoryIndex: 2,
            key: dataPointKey("Cost", "Mar"),
            color: "#123456",
          },
        ],
      } as Partial<ChartSpec>),
    );
    selectSeries();
    await render(React.createElement(ChartFormatPane, {} as never));

    const reset = container.querySelector(
      '[data-testid="chart-reset-to-match-style"]',
    ) as HTMLButtonElement;
    expect(reset).not.toBeNull();
    expect(reset.getAttribute("data-reset-scope")).toBe("series");
    expect(reset.disabled).toBe(false);

    await clickEl(reset);
    expect(liveSpec().dataPointOverrides).toBeUndefined();
  });

  it("counts only the overrides that actually carry a colour", async () => {
    await seed(
      fixtureSpec({
        dataPointOverrides: [
          { seriesIndex: 1, categoryIndex: 2, key: dataPointKey("Cost", "Mar"), exploded: 4 },
        ],
      } as Partial<ChartSpec>),
    );
    selectSeries();
    await render(React.createElement(ChartFormatPane, {} as never));

    expect(container.textContent).not.toContain("has its own colour");
  });
});

// ============================================================================
// Two series can share a name
// ============================================================================

describe("OB-1 an ambiguous series name", () => {
  it("colours every series that answers to the name, and says how many", async () => {
    cachedSeries = [{ name: "Cost" }, { name: "Cost" }];
    await seed(fixtureSpec());
    selectSeries(1, "Cost");
    await render(React.createElement(ChartFormatPane, {} as never));

    expect(container.textContent).toContain("2 series are named");

    await clickEl(swatch("Colour", PICKED));
    expect(liveSpec().seriesColors).toEqual({ Cost: PICKED });
  });

  it("says nothing when the name is unique", async () => {
    await seed(fixtureSpec());
    selectSeries();
    await render(React.createElement(ChartFormatPane, {} as never));
    expect(container.textContent).not.toContain("series are named");
  });
});

// ============================================================================
// The ribbon Design panel's "Auto" actually clears
// ============================================================================

describe("OB-1 the Design panel Auto button", () => {
  it("removes the override instead of merging a smaller record over it", async () => {
    await seed(fixtureSpec({ seriesColors: { Revenue: "#111111", Cost: PICKED } }));
    await render(React.createElement(SeriesColorsSection, {} as never));

    const select = container.querySelector("select") as HTMLSelectElement;
    await act(async () => {
      select.value = "1";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const auto = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Auto",
    );
    expect(auto).toBeDefined();
    await clickEl(auto as HTMLElement);

    // Before the fix `deepMergeSpec` merged the smaller record field by field
    // and Cost survived its own removal.
    expect(liveSpec().seriesColors).toEqual({ Revenue: "#111111" });
  });

  it("writes through the shared patch, so the Format pane reads it back", async () => {
    await seed(fixtureSpec());
    await render(React.createElement(SeriesColorsSection, {} as never));

    const select = container.querySelector("select") as HTMLSelectElement;
    await act(async () => {
      select.value = "1";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await setColour(container.querySelector('input[type="color"]') as HTMLInputElement, PICKED);

    expect(readSeriesColor(liveSpec(), "Cost")).toBe(PICKED);

    await unmount();
    selectSeries();
    await render(React.createElement(ChartFormatPane, {} as never));
    expect(colourInput("Colour").value).toBe(PICKED);
  });
});

// ============================================================================
// The dialog's Design tab uses the same patch
// ============================================================================

describe("OB-1 the dialog Design tab", () => {
  it("builds its set and its clear through seriesColorPatch", async () => {
    let spec = fixtureSpec({ seriesColors: { Cost: PICKED } });
    const onSpecChange = vi.fn((updates: Partial<ChartSpec>) => {
      spec = { ...spec, ...updates } as ChartSpec;
    });

    await render(
      React.createElement(DesignTab, {
        spec,
        onSpecChange,
        previewSeriesNames: ["Revenue", "Cost"],
      }),
    );

    const auto = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Auto",
    );
    expect(auto).toBeDefined();
    await clickEl(auto as HTMLElement);

    // The dialog's own overlay REPLACES a key, but the patch must still be the
    // shared one — an explicit undefined is correct under both merge rules.
    expect(onSpecChange).toHaveBeenCalledWith({ seriesColors: undefined });
  });
});

// ============================================================================
// The dialog's DATA tab — the fourth surface
// ============================================================================
//
// Found by the OB-1 agent and left as a handoff: the Insert Chart dialog's Data
// tab had its OWN series swatch, and it wrote `spec.series[i].color` through
// `onSeriesChange`. Residually that is the same defect in a fourth place — a
// colour set there is out-ranked by any `seriesColors` entry for the same name,
// and a colour set in the Format pane is not reflected by that swatch. It now
// goes through the shared reader and writer like everything else.

describe("OB-1 the dialog Data tab", () => {
  const AXES = [
    { index: 0, label: "Month" },
    { index: 1, label: "Revenue" },
    { index: 2, label: "Cost" },
  ];

  const SERIES = [
    { name: "Revenue", sourceIndex: 1, color: null },
    { name: "Cost", sourceIndex: 2, color: null },
  ];

  async function renderDataTab(
    spec: ChartSpec | null,
    onSpecChange: (u: Partial<ChartSpec>) => void,
    onSeriesChange: (s: typeof SERIES) => void = () => {},
  ): Promise<void> {
    await render(
      React.createElement(DataTab, {
        sourceRange: "Sheet1!A1:C4",
        onSourceRangeChange: () => {},
        sourceMode: "range",
        onSourceModeChange: () => {},
        designQueryAvailable: false,
        dslText: "",
        onDslTextChange: () => {},
        connectionId: "",
        onConnectionIdChange: () => {},
        connections: [],
        hasHeaders: true,
        onHasHeadersChange: () => {},
        orientation: "columns",
        onOrientationChange: () => {},
        categoryIndex: 0,
        onCategoryIndexChange: () => {},
        series: SERIES,
        onSeriesChange,
        spec,
        onSpecChange,
        availableAxes: AXES,
        palette: "default",
      } as never),
    );
  }

  /** The series swatches, in the order the list renders them. */
  function seriesSwatches(): HTMLInputElement[] {
    return Array.from(container.querySelectorAll('input[type="color"]'));
  }

  it("shows the name-keyed colour, not the index-keyed base", async () => {
    // Against the old code this read `seriesDef.color` — null — and fell
    // through to the palette, so the swatch disagreed with the painted chart.
    await renderDataTab(fixtureSpec({ seriesColors: { Cost: PICKED } }), () => {});
    const swatches = seriesSwatches();
    expect(swatches).toHaveLength(2);
    expect(swatches[1].value).toBe(PICKED);
  });

  it("writes seriesColors and never touches spec.series[].color", async () => {
    const onSpecChange = vi.fn();
    const onSeriesChange = vi.fn();
    await renderDataTab(fixtureSpec(), onSpecChange, onSeriesChange);

    await setColour(seriesSwatches()[1], PICKED);

    expect(onSpecChange).toHaveBeenCalledWith({ seriesColors: { Cost: PICKED } });
    // The old route. A call here is the defect coming back.
    expect(onSeriesChange).not.toHaveBeenCalled();
  });

  it("keeps a sibling's colour when it writes its own", async () => {
    const onSpecChange = vi.fn();
    await renderDataTab(fixtureSpec({ seriesColors: { Revenue: "#70ad47" } }), onSpecChange);

    await setColour(seriesSwatches()[1], PICKED);

    expect(onSpecChange).toHaveBeenCalledWith({
      seriesColors: { Revenue: "#70ad47", Cost: PICKED },
    });
  });

  it("still renders before the range parses, when there is no spec yet", async () => {
    // currentSpec is null until the source range parses. The swatch must fall
    // back to the palette rather than throw — the tab is shown either way.
    const onSpecChange = vi.fn();
    await renderDataTab(null, onSpecChange);
    expect(seriesSwatches()).toHaveLength(2);
    await setColour(seriesSwatches()[0], PICKED);
    expect(onSpecChange).toHaveBeenCalledWith({ seriesColors: { Revenue: PICKED } });
  });
});
