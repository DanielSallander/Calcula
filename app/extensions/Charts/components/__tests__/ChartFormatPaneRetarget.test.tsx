// FILENAME: app/extensions/Charts/components/__tests__/ChartFormatPaneRetarget.test.tsx
// PURPOSE: The Format pane in jsdom — that it RE-TARGETS in place instead of
//          closing and reopening, that it never reads its target from
//          `props.data`, that the active section survives a retarget, that
//          every control applies immediately, and that a commit RE-READS the
//          spec so a concurrent edit is not silently dropped.
// CONTEXT: @testing-library/react is not installed in this repo, so this file
//          drives react-dom + `act` directly, as its sibling component tests do
//          (ModelEditor/__tests__/StrategySection.test.tsx).
//
//          THE STORE DOUBLE'S `updateChartSpec` IS A TOP-LEVEL ASSIGN, and that
//          is faithful for what is under test. The real `deepMergeSpec`
//          (lib/chartStore.ts) merges nested plain objects field-by-field and
//          REPLACES ARRAYS WHOLESALE. Every patch this pane builds is either an
//          array (`dataPointOverrides`, `series`) or a fully rebuilt object
//          (`xAxis`, `legend`, `config`), so an assign and a deep merge agree
//          on all of them — and the array half is the rule the hazard case is
//          about, reproduced exactly.
//
//          THE CONCURRENCY CASE IS THE ONE THAT CAUGHT A REAL DEFECT CLASS. A
//          pane that caches `spec.dataPointOverrides` at render and writes its
//          cached copy back looks correct in every single-writer test: its
//          array contains its own edit. The loss only appears when SOMETHING
//          ELSE wrote between the render and the commit — the JSON spec editor
//          inside the same 300 ms debounce window, a script, a filter — and
//          then the stale array wins wholesale and the other edit is gone with
//          no error anywhere. So the case writes through a second door mid-way
//          and asserts BOTH edits survive.
//
//          THE RETARGET CASE ASSERTS THE DOM NODE IS THE SAME ONE. "The header
//          changed" would also be true of a pane that unmounted and remounted,
//          which is the behaviour Excel does NOT have and which would throw
//          away the active section every time.
//
//          A CONTROL IS CHANGED THROUGH THE PROTOTYPE SETTER. React patches
//          `value` on the element instance to track it, so `el.value = x`
//          updates the tracker too and the change event is then dropped as a
//          no-op.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import {
  publishChartSelection,
  resetChartSelectionRegistry,
  type ChartSelectionTarget,
} from "@api/chartSelection";
import type { ChartDefinition, ChartSpec, ParsedChartData } from "../../types";
// The key is built with the repo's own helper: hard-coding the separator here
// would be a second spelling of DATA_POINT_KEY_SEPARATOR that drifts silently.
import { dataPointKey } from "../../lib/dataPointOverrides";

// ---------------------------------------------------------------------------
// The store double
// ---------------------------------------------------------------------------

let store: ChartDefinition | null = null;

const getChartById = vi.fn((id: string) => (store && store.chartId === id ? store : null));
const updateChartSpec = vi.fn((id: string, patch: Partial<ChartSpec>) => {
  if (store === null || store.chartId !== id) return;
  // See the header: a top-level assign is what deepMergeSpec does for every
  // patch shape this pane produces.
  store.spec = { ...store.spec, ...patch };
});
const syncChartRegions = vi.fn();
const invalidateChartCache = vi.fn();

let cached: { data: ParsedChartData } | null = null;
const getCachedChartData = vi.fn(() => cached);

vi.mock("../../lib/chartStore", () => ({
  getChartById: (id: string) => getChartById(id),
  updateChartSpec: (id: string, patch: Partial<ChartSpec>) => updateChartSpec(id, patch),
  syncChartRegions: () => syncChartRegions(),
}));
vi.mock("../../rendering/chartRenderer", () => ({
  getCachedChartData: () => getCachedChartData(),
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
  },
  emitAppEvent: vi.fn(),
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
    x: 0,
    y: 0,
    width: 400,
    height: 300,
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
      ...over,
    },
  };
}

/** Parsed data with a CATEGORY FILTER live: painter 1 is authoring 2. */
function parsedWithFilter(): ParsedChartData {
  return {
    categories: ["Jan", "Mar"],
    series: [
      { name: "Sales", values: [10, 30] },
      { name: "Costs", values: [5, 15] },
    ],
    keptCategoryIndices: [0, 2],
  } as unknown as ParsedChartData;
}

function target(over: Partial<ChartSelectionTarget>): ChartSelectionTarget {
  return { chartId: "c1", chartName: "Chart 1", level: "chart", ...over };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;

async function mount(data?: Record<string, unknown>): Promise<void> {
  await act(async () => {
    root.render(React.createElement(ChartFormatPane, { data }));
  });
}

async function retarget(next: ChartSelectionTarget | null): Promise<void> {
  await act(async () => {
    publishChartSelection(next);
  });
}

function pane(): HTMLElement {
  const el = container.querySelector<HTMLElement>('[data-testid="chart-format-pane"]');
  if (el === null) throw new Error("the pane is not rendered");
  return el;
}

function subject(): string {
  const el = container.querySelector('[data-testid="chart-format-subject"]');
  return el?.textContent ?? "";
}

function field<T extends HTMLElement>(label: string): T {
  const el = container.querySelector<T>(`[aria-label="${label}"]`);
  if (el === null) {
    const seen = [...container.querySelectorAll("[aria-label]")]
      .map((e) => e.getAttribute("aria-label"))
      .join(", ");
    throw new Error(`no control labelled "${label}" — the pane shows: ${seen}`);
  }
  return el;
}

function tabButton(text: string): HTMLButtonElement {
  const el = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (b) => b.textContent === text,
  );
  if (el === undefined) {
    const seen = [...container.querySelectorAll('[role="tab"]')].map((b) => b.textContent);
    throw new Error(`no "${text}" tab — the pane offers: ${seen.join(", ")}`);
  }
  return el;
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function change(el: HTMLInputElement | HTMLSelectElement, value: string): Promise<void> {
  const proto = el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (!setter) throw new Error("no prototype value setter — cannot drive the control");
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetChartSelectionRegistry();
  store = chart();
  cached = { data: parsedWithFilter() };
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
// Retargeting
// ---------------------------------------------------------------------------

describe("retargeting", () => {
  it("invites the reader to click something when nothing is selected", async () => {
    await mount();
    expect(container.textContent).toContain("Select a chart");
    expect(container.querySelector('[data-testid="chart-format-pane"]')).toBeNull();
  });

  it("follows the selection IN PLACE — the same pane element, a new subject", async () => {
    await retarget(target({ level: "dataPoint", seriesIndex: 0, categoryIndex: 1 }));
    await mount();
    expect(subject()).toBe("Format Series 1 Point 2");

    const before = pane();
    await retarget(target({ level: "axis", axisType: "y" }));

    expect(subject()).toBe("Format Vertical (Value) Axis");
    // Not a close-and-reopen: the very same DOM node is still on screen.
    expect(pane()).toBe(before);
  });

  it("ignores props.data — the target is the registry, not what opened the pane", async () => {
    await retarget(target({ level: "element", elementId: "legend" }));
    // A caller who opened the pane while a DIFFERENT chart element was
    // selected; `data` is frozen at open time and must not steer anything.
    await mount({ chartId: "c1", elementId: "title", seriesIndex: 9 });
    expect(subject()).toBe("Format Legend");
  });

  it("goes back to the invitation when the chart is deselected", async () => {
    await retarget(target({ level: "series", seriesIndex: 0 }));
    await mount();
    expect(subject()).toBe("Format Series 1");

    await retarget(null);
    expect(container.textContent).toContain("Select a chart");
  });
});

// ---------------------------------------------------------------------------
// The active section survives
// ---------------------------------------------------------------------------

describe("the active section", () => {
  it("is REMEMBERED through a subject that does not offer it", async () => {
    await retarget(target({ level: "axis", axisType: "y" }));
    await mount();

    await click(tabButton("Text"));
    expect(tabButton("Text").getAttribute("aria-selected")).toBe("true");
    expect(field<HTMLInputElement>("Text")).toBeTruthy();

    // A data point has no Text tab: the pane falls back to Fill & Line...
    await retarget(target({ level: "dataPoint", seriesIndex: 0, categoryIndex: 1 }));
    expect(tabButton("Fill & Line").getAttribute("aria-selected")).toBe("true");

    // ...and coming back restores what the reader chose, rather than the
    // fallback it was forced onto in between.
    await retarget(target({ level: "axis", axisType: "y" }));
    expect(tabButton("Text").getAttribute("aria-selected")).toBe("true");
  });

  it("shows no tab strip for a subject with only one section", async () => {
    await retarget(target({ level: "element", elementId: "plotArea" }));
    await mount();
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(0);
    expect(field<HTMLInputElement>("Background")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Immediate apply
// ---------------------------------------------------------------------------

describe("applying", () => {
  it("has no OK, Apply or Cancel anywhere — every control acts at once", async () => {
    await retarget(target({ level: "axis", axisType: "y" }));
    await mount();
    const labels = [...container.querySelectorAll("button")].map((b) => b.textContent ?? "");
    for (const forbidden of ["OK", "Apply", "Cancel"]) {
      expect(labels, `the pane offers a "${forbidden}" button`).not.toContain(forbidden);
    }
  });

  it("writes a legend position the moment it is chosen", async () => {
    await retarget(target({ level: "element", elementId: "legend" }));
    await mount();

    await change(field<HTMLSelectElement>("Position"), "bottom");

    expect(updateChartSpec).toHaveBeenCalledTimes(1);
    expect(store?.spec.legend).toEqual({ visible: true, position: "bottom" });
    // ...and the chart is repainted, not merely stored.
    expect(invalidateChartCache).toHaveBeenCalledWith("c1");
    expect(syncChartRegions).toHaveBeenCalled();
  });

  it("writes an axis bound rebuilt from the stored axis, keeping its siblings", async () => {
    await retarget(target({ level: "axis", axisType: "y" }));
    await mount();

    await change(field<HTMLInputElement>("Maximum"), "500");

    expect(store?.spec.yAxis.max).toBe(500);
    expect(store?.spec.yAxis.showLabels).toBe(true); // sibling survived
    expect(store?.spec.xAxis.max).toBeNull(); // the other axis untouched
  });

  it("clears a title to null rather than to an empty string", async () => {
    await retarget(target({ level: "element", elementId: "title" }));
    await mount();

    const text = field<HTMLInputElement>("Text");
    expect(text.value).toBe("Quarterly");
    await change(text, "");
    expect(store?.spec.title).toBeNull();
  });

  it("writes a data-point override in AUTHORING space with its identity key", async () => {
    // Painter category 1 is authoring category 2 (a filter hides "Feb").
    await retarget(target({ level: "dataPoint", seriesIndex: 0, categoryIndex: 1 }));
    await mount();

    await change(field<HTMLInputElement>("Fill colour"), "#ff0000");

    expect(store?.spec.dataPointOverrides).toEqual([
      { seriesIndex: 0, categoryIndex: 2, key: dataPointKey("Sales", "Mar"), color: "#ff0000" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The concurrency hazard
// ---------------------------------------------------------------------------

describe("a concurrent edit inside the debounce window", () => {
  it("does not lose the OTHER writer's override, and does not lose its own", async () => {
    await retarget(target({ level: "dataPoint", seriesIndex: 0, categoryIndex: 1 }));
    await mount();
    // The pane has now rendered against a spec with no overrides at all.
    expect(store?.spec.dataPointOverrides).toBeUndefined();

    // SOMETHING ELSE writes — the JSON spec editor, a script, a filter — inside
    // the 300 ms window before the pane's own commit lands. This goes straight
    // into the store, exactly as `updateChartSpec` would deliver it.
    store!.spec = {
      ...store!.spec,
      dataPointOverrides: [{ seriesIndex: 1, categoryIndex: 0, color: "#00ff00" }],
    };

    await change(field<HTMLInputElement>("Fill colour"), "#ff0000");

    const written = store?.spec.dataPointOverrides ?? [];
    expect(written).toHaveLength(2);
    expect(written).toContainEqual({ seriesIndex: 1, categoryIndex: 0, color: "#00ff00" });
    expect(written).toContainEqual({
      seriesIndex: 0,
      categoryIndex: 2,
      key: dataPointKey("Sales", "Mar"),
      color: "#ff0000",
    });
  });

  it("does not lose a concurrent SERIES colour either", async () => {
    await retarget(target({ level: "series", seriesIndex: 0 }));
    await mount();

    // The other writer colours the SECOND series while the pane is showing the
    // first. `series` is an array, so a cached copy would replace it wholesale.
    store!.spec = {
      ...store!.spec,
      series: [store!.spec.series[0], { ...store!.spec.series[1], color: "#00ff00" }],
    };

    await change(field<HTMLInputElement>("Colour"), "#ff0000");

    expect(store?.spec.series.map((s) => s.color)).toEqual(["#ff0000", "#00ff00"]);
  });
});
