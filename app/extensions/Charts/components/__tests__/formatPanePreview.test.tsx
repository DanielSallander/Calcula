//! FILENAME: app/extensions/Charts/components/__tests__/formatPanePreview.test.tsx
// PURPOSE: CI-14 — hovering a colour swatch in the Format pane is a TRANSIENT
//          WRITE, and CI-11 — Reset to Match Style is scoped to the selection.
// CONTEXT:
//          WHAT "NO UNDO ENTRY AND NO DIRTY FLAG" MEANS AT THIS LAYER. Neither
//          lives in TypeScript: the undo entry is recorded by the Rust
//          `update_chart` command (`record_chart_undo`) and the dirty flag is
//          set by its `DocumentEffect`. Both are therefore observable here as
//          exactly one thing — whether `update_chart` was invoked. So the store
//          is driven with a REAL `chartStore` over a doubled backend channel,
//          the 300 ms debounce is allowed to fire for real, and the assertion
//          is on the invocations that reached the channel. A preview that
//          produced an `update_chart` would be a preview that dirtied the
//          document and pushed an undo entry.
//
//          WHY THE STORE IS NOT MOCKED. The named hazard is inside it:
//          `updateChartSpec` ends in `scheduleSave` unconditionally, so a
//          preview routed through it PERSISTS. A test with a doubled store
//          would prove only that the pane called the function it was told to
//          call. Here the preview path is proved by the absence of a backend
//          write after the debounce has actually run.
//
//          EVERY EXIT PATH IS ENUMERATED AND TESTED. A preview left standing is
//          not cosmetic: the next real edit would deep-merge onto it and
//          persist it as authored state — a corruption authored by the preview,
//          through a command innocent of it. The store-level exits (deletion,
//          File > New, the `updateChartSpec` backstop, a concurrent flush) are
//          in formatPanePreviewStore.test.ts; the pane-level ones are here.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ----------------------------------------------------------------------------
// Doubles. Everything OUTSIDE the store/pane pair is stubbed; the store itself
// is real, because the defect being guarded lives in it.
// ----------------------------------------------------------------------------

const alertAsync = vi.fn<(message: string, options?: unknown) => Promise<void>>(
  () => Promise.resolve(),
);
vi.mock("@api/dialogs", () => ({ alertAsync: (m: string, o?: unknown) => alertAsync(m, o) }));

const invalidateChartCache = vi.fn();
const cachedData = {
  data: {
    series: [{ name: "Revenue" }, { name: "Cost" }],
    categories: ["Jan", "Feb", "Mar"],
  },
};
vi.mock("../../rendering/chartRenderer", () => ({
  getCachedChartData: () => cachedData,
  invalidateChartCache: (id: string) => invalidateChartCache(id),
}));

vi.mock("../../handlers/selectionHandler", () => ({
  getCurrentChartId: () => null,
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

vi.mock("@api", () => ({ showDialog: vi.fn() }));
vi.mock("../../manifest", () => ({ CHART_DIALOG_ID: "chart:createDialog" }));

import { ChartFormatPane, runResetToMatchStyleCommand } from "../ChartFormatPane";
import {
  getChartById,
  loadChartsFromBackend,
  resetChartStore,
  updateChartSpec,
} from "../../lib/chartStore";
import { chartsBackend } from "../../lib/chartsBackend";
import { publishChartSelection, resetChartSelectionRegistry } from "@api/chartSelection";
import { dataPointKey } from "../../lib/dataPointOverrides";
import type { ChartSpec, DataPointOverride } from "../../types";

/**
 * The identity keys, BUILT rather than spelled. `DATA_POINT_KEY_SEPARATOR` is
 * not a pipe and is not even printable, so a hand-written "Cost|Mar" matches
 * nothing and every key-first lookup silently falls through to the index leg.
 */
const KEY_COST_MAR = dataPointKey("Cost", "Mar");
const KEY_REVENUE_JAN = dataPointKey("Revenue", "Jan");
const KEY_REVENUE_FEB = dataPointKey("Revenue", "Feb");

// ----------------------------------------------------------------------------
// Fixture
// ----------------------------------------------------------------------------

const ID = "chart-preview-1";

/** A swatch that is NOT the fallback, so a preview is visible in the spec. */
const HOVERED = "#ed7d31";
const OTHER = "#70ad47";

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
    title: "Preview",
    xAxis: {},
    yAxis: {},
    legend: { visible: true, position: "right" },
    palette: "default",
    ...extra,
  } as unknown as ChartSpec;
}

const invokeBackend = vi.fn();

/** Load ONE chart with `spec` into the real store, then forget the load. */
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

/** The live spec, as the painters would read it. */
function liveSpec(): ChartSpec {
  const chart = getChartById(ID);
  if (chart === null) throw new Error("fixture chart is gone");
  return chart.spec;
}

function overrides(): DataPointOverride[] {
  return liveSpec().dataPointOverrides ?? [];
}

/** Every `update_chart` that reached the backend channel. */
function updates(): unknown[] {
  return invokeBackend.mock.calls.filter((c) => c[0] === "update_chart").map((c) => c[1]);
}

/** Let the 300 ms debounce fire for real, then settle the promise chain. */
async function settleDebounce(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 360));
    await Promise.resolve();
  });
}

// ----------------------------------------------------------------------------
// Rendering harness
// ----------------------------------------------------------------------------

let container: HTMLDivElement;
let root: Root | null = null;

async function renderPane(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(React.createElement(ChartFormatPane, {} as never));
  });
}

async function unmountPane(): Promise<void> {
  if (root === null) return;
  const r = root;
  root = null;
  await act(async () => {
    r.unmount();
  });
  container.remove();
}

function swatch(field: string, hex: string): HTMLElement {
  const strip = container.querySelector(`[data-chart-swatches="${field}"]`);
  if (strip === null) throw new Error(`no swatch strip for "${field}"`);
  const el = strip.querySelector(`[data-chart-swatch="${hex}"]`);
  if (el === null) throw new Error(`no swatch ${hex} in "${field}"`);
  return el as HTMLElement;
}

/**
 * React 18 synthesises onMouseEnter/onMouseLeave from `mouseover`/`mouseout`
 * on the root container, so the raw `mouseenter` event does nothing at all.
 * These dispatch what React actually listens for.
 */
async function hover(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(
      new MouseEvent("mouseover", { bubbles: true, cancelable: true, relatedTarget: null }),
    );
  });
}

async function unhover(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(
      new MouseEvent("mouseout", {
        bubbles: true,
        cancelable: true,
        relatedTarget: document.body,
      }),
    );
  });
}

async function clickEl(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

function selectDatum(): void {
  publishChartSelection({
    chartId: ID,
    chartName: "Chart 1",
    level: "dataPoint",
    seriesIndex: 1,
    categoryIndex: 2,
    seriesName: "Cost",
    categoryName: "Mar",
  });
}

function selectSeries(): void {
  publishChartSelection({
    chartId: ID,
    chartName: "Chart 1",
    level: "series",
    seriesIndex: 1,
    seriesName: "Cost",
  });
}

function selectChart(): void {
  publishChartSelection({ chartId: ID, chartName: "Chart 1", level: "chart" });
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetChartStore();
  resetChartSelectionRegistry();
  invokeBackend.mockReset();
  invalidateChartCache.mockClear();
  alertAsync.mockReset();
  alertAsync.mockImplementation(() => Promise.resolve());
  chartsBackend.set(invokeBackend);
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  await unmountPane();
  warnSpy.mockRestore();
  resetChartStore();
  resetChartSelectionRegistry();
});

// ============================================================================
// CI-14 — the preview itself
// ============================================================================

describe("CI-14 hovering a swatch is a transient write", () => {
  it("repaints the chart and writes NOTHING to the backend", async () => {
    await seed(fixtureSpec());
    selectDatum();
    await renderPane();

    await hover(swatch("Fill colour", HOVERED));

    // Visible: the datum the reader is pointing at now carries the colour.
    expect(overrides()).toEqual([
      { seriesIndex: 1, categoryIndex: 2, key: KEY_COST_MAR, color: HOVERED },
    ]);
    // Repainted: the render cache was dropped so the canvas redraws.
    expect(invalidateChartCache).toHaveBeenCalledWith(ID);

    // Not written: no undo entry, no dirty flag, nothing scheduled. The
    // debounce is given its full 300 ms to prove it.
    await settleDebounce();
    expect(updates()).toEqual([]);
  });

  it("restores the stored spec on mouse-out", async () => {
    await seed(fixtureSpec());
    selectDatum();
    await renderPane();

    const target = swatch("Fill colour", HOVERED);
    await hover(target);
    expect(overrides()).toHaveLength(1);

    await unhover(target);
    expect(liveSpec().dataPointOverrides).toBeUndefined();

    await settleDebounce();
    expect(updates()).toEqual([]);
  });

  it("previews against the STORED spec, so crossing two swatches leaves one", async () => {
    await seed(fixtureSpec());
    selectDatum();
    await renderPane();

    // No mouse-out between them — the pointer slid straight across two
    // DIFFERENT properties. Each preview is built from the stored spec, so the
    // second replaces the first rather than adding to it. (The nested-object
    // form of the same rule is pinned in formatPanePreviewStore.test.ts, where
    // an array replacement cannot hide the difference.)
    await hover(swatch("Fill colour", HOVERED));
    await hover(swatch("Border colour", OTHER));

    expect(overrides()).toEqual([
      { seriesIndex: 1, categoryIndex: 2, key: KEY_COST_MAR, borderColor: OTHER },
    ]);

    await unhover(swatch("Border colour", OTHER));
    // One restore puts everything back: the first preview was never a base.
    expect(liveSpec().dataPointOverrides).toBeUndefined();
  });

  it("CLICKING commits exactly one backend write", async () => {
    await seed(fixtureSpec());
    selectDatum();
    await renderPane();

    const target = swatch("Fill colour", HOVERED);
    await hover(target);
    await clickEl(target);
    await settleDebounce();

    const written = updates();
    expect(written).toHaveLength(1);
    const entry = (written[0] as { entry: { specJson: string } }).entry;
    const persisted = JSON.parse(entry.specJson) as { spec: ChartSpec };
    expect(persisted.spec.dataPointOverrides).toEqual([
      { seriesIndex: 1, categoryIndex: 2, key: KEY_COST_MAR, color: HOVERED },
    ]);
  });
});

// ============================================================================
// CI-14 — the pane-level exit paths
// ============================================================================

describe("CI-14 every pane exit path restores", () => {
  it("restores when the pane closes mid-hover", async () => {
    await seed(fixtureSpec());
    selectDatum();
    await renderPane();

    await hover(swatch("Fill colour", HOVERED));
    expect(overrides()).toHaveLength(1);

    await unmountPane();

    expect(liveSpec().dataPointOverrides).toBeUndefined();
    await settleDebounce();
    expect(updates()).toEqual([]);
  });

  it("restores when the chart is DESELECTED mid-hover", async () => {
    await seed(fixtureSpec());
    selectDatum();
    await renderPane();

    await hover(swatch("Fill colour", HOVERED));
    expect(overrides()).toHaveLength(1);

    await act(async () => {
      publishChartSelection(null);
    });

    expect(liveSpec().dataPointOverrides).toBeUndefined();
    await settleDebounce();
    expect(updates()).toEqual([]);
  });

  it("restores when the selection moves to another element mid-hover", async () => {
    await seed(fixtureSpec());
    selectDatum();
    await renderPane();

    await hover(swatch("Fill colour", HOVERED));
    await act(async () => {
      selectSeries();
    });

    expect(liveSpec().dataPointOverrides).toBeUndefined();
  });

  it("survives the republish that the preview's own repaint provokes", async () => {
    // The live publisher re-reads the selection on CHART_UPDATED, and the
    // display name it derives comes from the render cache the preview has just
    // invalidated. A pane that restored on "a snapshot arrived" rather than on
    // "the subject changed" would kill every preview at birth.
    await seed(fixtureSpec());
    selectDatum();
    await renderPane();

    await hover(swatch("Fill colour", HOVERED));
    await act(async () => {
      // Same subject, different derived name — what the publisher would emit.
      publishChartSelection({
        chartId: ID,
        chartName: "Chart 1",
        level: "dataPoint",
        seriesIndex: 1,
        categoryIndex: 2,
      });
    });

    expect(overrides()).toHaveLength(1);
  });
});

// ============================================================================
// CI-11 — Reset to Match Style
// ============================================================================

/**
 * How many times the pane announced an edit.
 *
 * ONE UNDO ENTRY means one store write, and `announceChartEdit` fires
 * CHART_UPDATED once per write. The backend count alone cannot prove it: the
 * 300 ms debounce would coalesce two writes into one `update_chart`, so a reset
 * split across two `updateChartSpec` calls would look identical from there —
 * right up until the two straddled a window boundary and the reader needed two
 * Ctrl+Z.
 */
function countEdits(): { stop: () => number } {
  let n = 0;
  const onUpdated = (): void => {
    n += 1;
  };
  window.addEventListener("chart:updated", onUpdated);
  return {
    stop: () => {
      window.removeEventListener("chart:updated", onUpdated);
      return n;
    },
  };
}

function resetButton(): HTMLButtonElement {
  const el = container.querySelector('[data-testid="chart-reset-to-match-style"]');
  if (el === null) throw new Error("no reset button");
  return el as HTMLButtonElement;
}

describe("CI-11 Reset to Match Style follows the selection", () => {
  const overrideCost: DataPointOverride = {
    seriesIndex: 1,
    categoryIndex: 2,
    key: KEY_COST_MAR,
    color: "#ff0000",
  };
  const overrideRevenue: DataPointOverride = {
    seriesIndex: 0,
    categoryIndex: 0,
    key: KEY_REVENUE_JAN,
    color: "#00ff00",
  };

  it("is disabled, with its scope named, when nothing manual is in scope", async () => {
    await seed(fixtureSpec());
    selectDatum();
    await renderPane();

    expect(resetButton().disabled).toBe(true);
    expect(resetButton().getAttribute("data-reset-scope")).toBe("dataPoint");
  });

  it("drops ONE override at data-point level, in ONE backend write", async () => {
    await seed(fixtureSpec({ dataPointOverrides: [overrideCost, overrideRevenue] }));
    selectDatum();
    await renderPane();

    expect(resetButton().disabled).toBe(false);
    const edits = countEdits();
    await clickEl(resetButton());

    expect(overrides()).toEqual([overrideRevenue]);
    // ONE operation: one announced edit, one backend write, one undo entry.
    expect(edits.stop()).toBe(1);
    await settleDebounce();
    expect(updates()).toHaveLength(1);
  });

  it("drops the series' overrides, its palette entry AND its own colour", async () => {
    await seed(
      fixtureSpec({
        dataPointOverrides: [overrideCost, overrideRevenue],
        seriesColors: { Cost: "#123456", Revenue: "#abcdef" },
        series: [
          { name: "Revenue", sourceIndex: 1, color: null },
          { name: "Cost", sourceIndex: 2, color: "#999999" },
        ],
      } as Partial<ChartSpec>),
    );
    selectSeries();
    await renderPane();

    expect(resetButton().getAttribute("data-reset-scope")).toBe("series");
    const edits = countEdits();
    await clickEl(resetButton());
    // Three collections rewritten (overrides, seriesColors, series[].color) —
    // still ONE operation.
    expect(edits.stop()).toBe(1);

    const spec = liveSpec();
    expect(spec.dataPointOverrides).toEqual([overrideRevenue]);
    expect(spec.seriesColors).toEqual({ Revenue: "#abcdef" });
    // `series[i].color` is what THIS pane's series swatch writes; a reset that
    // cleared only `seriesColors` would leave the override it just promised to
    // remove.
    expect(spec.series?.[1]?.color).toBeNull();
    expect(spec.series?.[0]?.color).toBeNull();

    await settleDebounce();
    expect(updates()).toHaveLength(1);
  });

  it("resets the WHOLE chart when the command names one that is not selected", async () => {
    // The `chart.resetToMatchStyle` command body. A caller who names a chart
    // rather than relying on the selection can only have meant the chart, so
    // the scope is forced — this is also the leg `chart.clearDataPointOverrides`
    // becomes.
    await seed(
      fixtureSpec({
        dataPointOverrides: [overrideCost, overrideRevenue],
        seriesColors: { Cost: "#123456" },
      }),
    );
    publishChartSelection(null);

    expect(runResetToMatchStyleCommand(ID)).toBe(true);

    expect(liveSpec().dataPointOverrides).toBeUndefined();
    expect(liveSpec().seriesColors).toBeUndefined();
    // Nothing to reset the second time, and it says so rather than writing.
    expect(runResetToMatchStyleCommand(ID)).toBe(false);
    expect(runResetToMatchStyleCommand()).toBe(false);
  });

  it("clears every manual fill AND the per-element theme at chart level", async () => {
    await seed(
      fixtureSpec({
        dataPointOverrides: [overrideCost, overrideRevenue],
        seriesColors: { Cost: "#123456" },
        config: { theme: { titleColor: "#ff00ff", background: "#eeeeee" } },
      } as Partial<ChartSpec>),
    );
    selectChart();
    await renderPane();

    expect(resetButton().getAttribute("data-reset-scope")).toBe("chart");
    await clickEl(resetButton());

    const spec = liveSpec();
    expect(spec.dataPointOverrides).toBeUndefined();
    expect(spec.seriesColors).toBeUndefined();
    expect(spec.config?.theme).toBeUndefined();

    await settleDebounce();
    expect(updates()).toHaveLength(1);
  });
});

// ============================================================================
// THE ARRAY HAZARD — deepMergeSpec replaces arrays wholesale
// ============================================================================

describe("a concurrent spec edit inside the debounce window is not dropped", () => {
  it("keeps BOTH the pane's swatch and the spec editor's override", async () => {
    await seed(fixtureSpec());
    selectDatum();
    await renderPane();

    // The JSON spec editor adds an override for a DIFFERENT datum while the
    // pane is on screen, inside the 300 ms window and without re-rendering it.
    updateChartSpec(ID, {
      dataPointOverrides: [
        { seriesIndex: 0, categoryIndex: 0, key: KEY_REVENUE_JAN, color: "#00ff00" },
      ],
    });

    // The pane now commits its own swatch. A write built from the array the
    // pane rendered with (empty) would replace the editor's array wholesale.
    await clickEl(swatch("Fill colour", HOVERED));

    expect(overrides()).toEqual([
      { seriesIndex: 0, categoryIndex: 0, key: KEY_REVENUE_JAN, color: "#00ff00" },
      { seriesIndex: 1, categoryIndex: 2, key: KEY_COST_MAR, color: HOVERED },
    ]);

    // One debounce window, one write, carrying both.
    await settleDebounce();
    expect(updates()).toHaveLength(1);
  });

  it("keeps a concurrent override when RESET drops the selected one", async () => {
    await seed(
      fixtureSpec({
        dataPointOverrides: [{ seriesIndex: 1, categoryIndex: 2, key: KEY_COST_MAR, color: "#f00" }],
      }),
    );
    selectDatum();
    await renderPane();

    updateChartSpec(ID, {
      dataPointOverrides: [
        { seriesIndex: 1, categoryIndex: 2, key: KEY_COST_MAR, color: "#f00" },
        { seriesIndex: 0, categoryIndex: 1, key: KEY_REVENUE_FEB, color: "#0f0" },
      ],
    });

    await clickEl(resetButton());

    expect(overrides()).toEqual([
      { seriesIndex: 0, categoryIndex: 1, key: KEY_REVENUE_FEB, color: "#0f0" },
    ]);
  });

  it("a preview raised BEFORE the concurrent edit does not swallow it", async () => {
    await seed(fixtureSpec());
    selectDatum();
    await renderPane();

    await hover(swatch("Fill colour", HOVERED));
    // The spec editor writes while the preview is up. `updateChartSpec`
    // restores first, so the editor's array lands on the STORED spec.
    updateChartSpec(ID, {
      dataPointOverrides: [
        { seriesIndex: 0, categoryIndex: 0, key: KEY_REVENUE_JAN, color: "#00ff00" },
      ],
    });

    expect(overrides()).toEqual([
      { seriesIndex: 0, categoryIndex: 0, key: KEY_REVENUE_JAN, color: "#00ff00" },
    ]);

    await settleDebounce();
    const written = updates();
    expect(written).toHaveLength(1);
    const persisted = JSON.parse(
      (written[0] as { entry: { specJson: string } }).entry.specJson,
    ) as { spec: ChartSpec };
    // The hovered colour never reached the backend.
    expect(JSON.stringify(persisted.spec)).not.toContain(HOVERED);
  });
});
