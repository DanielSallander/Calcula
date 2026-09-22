// FILENAME: app/extensions/Charts/components/__tests__/ChartFormatPaneStepUp.test.tsx
// PURPOSE: From a single data point there is a way back to the whole SERIES.
// CONTEXT: The owner's report, verbatim: "when I select an individual data
//          point and give it a color I cannot select a color for the entire
//          series after that."
//
//          He is right, and the ladder says why. `advanceSelection`
//          (handlers/selectionHandler.ts:363) has no arm from a data point back
//          to its OWN series: at `level: "dataPoint"` a click on a datum of the
//          same series selects THAT datum, and a click on a datum of another
//          series selects that other series. So every click inside the series
//          keeps the reader on a point, the pane shows the Data Point sections,
//          and "Series fill" is not on screen at all. Escape steps up, but
//          nothing says so; the mouse routes are a trip out to the chart's
//          outer margin and back, or via a different series.
//
//          This file proves the second door: the pane offers it, only from the
//          rung that needs it, and pressing it lands on the series.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import {
  publishChartSelection,
  resetChartSelectionRegistry,
  type ChartSelectionTarget,
} from "@api/chartSelection";
import type { ChartDefinition, ChartSpec, ParsedChartData } from "../../types";

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

let store: ChartDefinition | null = null;
const getChartById = vi.fn((id: string) => (store && store.chartId === id ? store : null));
const updateChartSpec = vi.fn();
const syncChartRegions = vi.fn();
const invalidateChartCache = vi.fn();
const setSubSelection = vi.fn();
const emitAppEvent = vi.fn();

let cached: { data: ParsedChartData } | null = null;

vi.mock("../../lib/chartStore", () => ({
  getChartById: (id: string) => getChartById(id),
  updateChartSpec: (id: string, patch: Partial<ChartSpec>) => updateChartSpec(id, patch),
  syncChartRegions: () => syncChartRegions(),
}));
vi.mock("../../rendering/chartRenderer", () => ({
  getCachedChartData: () => cached,
  invalidateChartCache: (id: string) => invalidateChartCache(id),
}));
vi.mock("../../handlers/selectionHandler", () => ({
  getCurrentChartId: () => "c1",
  getSubSelection: () => ({ level: "none" }),
  setSubSelection: (id: string, next: unknown) => setSubSelection(id, next),
}));
vi.mock("@api/events", () => ({
  AppEvents: {
    CHART_SELECTION_CHANGED: "app:chart-selection-changed",
    GRID_REFRESH: "app:grid-refresh",
  },
  emitAppEvent: (...args: unknown[]) => emitAppEvent(...args),
  onAppEvent: vi.fn(() => () => undefined),
}));

import { ChartFormatPane } from "../ChartFormatPane";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function axis(): ChartSpec["xAxis"] {
  return { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null };
}

function chart(over: Partial<ChartSpec> = {}): ChartDefinition {
  return {
    chartId: "c1",
    name: "Chart 1",
    sheetIndex: 0,
    x: 0, y: 0, width: 400, height: 300,
    spec: {
      mark: "bar",
      data: "Sheet1!A1:C4",
      hasHeaders: true,
      seriesOrientation: "columns",
      categoryIndex: 0,
      series: [
        { name: "Sales", sourceIndex: 1, color: null },
        { name: "Costs", sourceIndex: 2, color: null },
      ],
      title: "Quarterly",
      xAxis: axis(),
      yAxis: axis(),
      legend: { visible: true, position: "right" },
      palette: "default",
      // The owner's state: point 1 of series 0 already has its own colour.
      dataPointOverrides: [{ seriesIndex: 0, categoryIndex: 1, color: "#ed7d31" }],
      ...over,
    },
  } as ChartDefinition;
}

function parsed(): ParsedChartData {
  return {
    categories: ["Jan", "Feb", "Mar"],
    series: [
      { name: "Sales", values: [10, 20, 30] },
      { name: "Costs", values: [5, 10, 15] },
    ],
  } as unknown as ParsedChartData;
}

function target(over: Partial<ChartSelectionTarget>): ChartSelectionTarget {
  return { chartId: "c1", chartName: "Chart 1", level: "chart", ...over };
}

let container: HTMLDivElement;
let root: Root;

async function mount(): Promise<void> {
  await act(async () => {
    root.render(React.createElement(ChartFormatPane, {}));
  });
}

async function retarget(next: ChartSelectionTarget | null): Promise<void> {
  await act(async () => {
    publishChartSelection(next);
  });
}

function stepUp(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(
    '[data-testid="chart-format-step-up-to-series"]',
  );
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetChartSelectionRegistry();
  store = chart();
  cached = { data: parsed() };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetChartSelectionRegistry();
});

// ---------------------------------------------------------------------------

describe("the Format pane offers a way back to the whole series", () => {
  it("shows the step-up button while a single datum is selected, naming the series", async () => {
    await mount();
    await retarget(target({
      level: "dataPoint", seriesIndex: 0, categoryIndex: 1, seriesName: "Sales",
    }));
    const button = stepUp();
    expect(button, "no way back to the series from a data point").not.toBeNull();
    expect(button!.textContent).toContain("Sales");
  });

  it("pressing it selects the SERIES, and writes nothing", async () => {
    await mount();
    await retarget(target({
      level: "dataPoint", seriesIndex: 0, categoryIndex: 1, seriesName: "Sales",
    }));
    await click(stepUp()!);

    expect(setSubSelection).toHaveBeenCalledWith("c1", { level: "series", seriesIndex: 0 });
    // A selection move is not an edit: nothing is persisted and nothing is
    // merged into the spec.
    expect(updateChartSpec).not.toHaveBeenCalled();
    // ...but the selection chrome has to be repainted, because it is drawn from
    // the sub-selection and not from the spec.
    expect(invalidateChartCache).toHaveBeenCalledWith("c1");
    expect(syncChartRegions).toHaveBeenCalled();
  });

  it("carries the datum's OWN series index, not a hard-coded zero", async () => {
    await mount();
    await retarget(target({
      level: "dataPoint", seriesIndex: 1, categoryIndex: 2, seriesName: "Costs",
    }));
    expect(stepUp()!.textContent).toContain("Costs");
    await click(stepUp()!);
    expect(setSubSelection).toHaveBeenCalledWith("c1", { level: "series", seriesIndex: 1 });
  });

  it("is NOT offered from the rungs that already have a mouse route out", async () => {
    await mount();
    for (const level of ["series", "chart"] as const) {
      await retarget(target({ level, seriesIndex: 0, seriesName: "Sales" }));
      expect(stepUp(), `the step-up row appeared at level "${level}"`).toBeNull();
    }
    await retarget(target({ level: "element", elementId: "title" } as Partial<ChartSelectionTarget>));
    expect(stepUp()).toBeNull();
  });

  it("the series rung then shows the Series fill control the owner was looking for", async () => {
    // The point of the button: what it lands on is the control that was
    // unreachable. The pane retargets from the published selection, which is
    // what `selectWholeSeries` refreshes in the product.
    await mount();
    await retarget(target({
      level: "dataPoint", seriesIndex: 0, categoryIndex: 1, seriesName: "Sales",
    }));
    expect(container.querySelector('[aria-label="Colour"]')).toBeNull();

    await retarget(target({ level: "series", seriesIndex: 0, seriesName: "Sales" }));
    expect(
      container.querySelector('[aria-label="Colour"]'),
      "the series rung still has no series fill control",
    ).not.toBeNull();
  });
});
