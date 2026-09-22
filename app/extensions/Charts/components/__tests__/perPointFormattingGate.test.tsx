//! FILENAME: app/extensions/Charts/components/__tests__/perPointFormattingGate.test.tsx
// PURPOSE: "Format this ONE data point" is offered only where it can actually
//          be painted. Every built-in mark can; a CUSTOM mark paints in a Worker
//          realm and returns an opaque ImageBitmap, so the host ships it the
//          resolved per-datum styles (`paint.datumStyles`) and the mark DECLARES
//          whether it reads them (`ChartMarkMeta.honoursDataPointOverrides`).
// CONTEXT: The declaration existed and nothing consulted it. Both doors into
//          per-point formatting — the Format pane's Data Point sections and the
//          context menu's "Format Data Point..." — accepted a colour on any
//          mark whatsoever. For a mark that ignores the payload that is the
//          silent no-op in its purest form: the pane takes the colour, the spec
//          stores it, the document goes dirty, the chart is unchanged, and
//          nothing anywhere reports a problem.
//
//          THE REFUSAL IS SHAPED DIFFERENTLY AT EACH DOOR, on purpose. The pane
//          always has a body, so it EXPLAINS ("this chart type does not support
//          formatting a single data point"). The menu is a list of verbs, so it
//          WITHHOLDS the row rather than offering one that opens a dialog only
//          to refuse. Both are asserted here, because a gate applied at one door
//          is a gate the other door walks around.
//
//          THE POSITIVE CONTROLS ARE THE POINT. A gate that refuses everything
//          would pass a test that only checked the refusal, and would silently
//          take per-point formatting away from all eighteen built-ins. So each
//          refusal case is paired with a built-in and with a custom mark that
//          DID declare.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

import type { ChartDefinition, ChartSpec } from "../../types";

// ---------------------------------------------------------------------------
// Doubles — everything outside the two components under test
// ---------------------------------------------------------------------------

let store: ChartDefinition | null = null;

const showDialog = vi.fn();

vi.mock("@api", () => ({ showDialog: (...a: unknown[]) => showDialog(...a) }));
vi.mock("@api/commands", () => ({ CommandRegistry: { execute: vi.fn() } }));
vi.mock("@api/events", () => ({
  AppEvents: {
    CHART_SELECTION_CHANGED: "app:chart-selection-changed",
    GRID_REFRESH: "app:grid-refresh",
  },
  emitAppEvent: vi.fn(),
  onAppEvent: vi.fn(() => () => undefined),
}));
vi.mock("../../lib/chartStore", () => ({
  getChartById: (id: string) => (store && store.chartId === id ? store : null),
  updateChartSpec: vi.fn(),
  syncChartRegions: vi.fn(),
}));
vi.mock("../../rendering/chartRenderer", () => ({
  getCachedChartData: () => null,
  invalidateChartCache: vi.fn(),
}));
vi.mock("../../handlers/selectionHandler", () => ({
  getCurrentChartId: () => null,
  getSubSelection: () => ({ level: "none" }),
  setSubSelection: vi.fn(),
  selectionAfterHidingLegendEntry: vi.fn(() => null),
}));
vi.mock("../../manifest", () => ({ CHART_DIALOG_ID: "chart:createDialog" }));

import {
  publishChartSelection,
  resetChartSelectionRegistry,
  type ChartSelectionTarget,
} from "@api/chartSelection";
import { setChartRightClickTarget } from "@api/chartData";
import {
  registerChartMark,
  unregisterChartMark,
  chartMarkHonoursDataPointOverrides,
} from "@api/chartMarks";
import { markOffersPerPointFormatting } from "../../lib/dataPointOverrides";
// SIDE-EFFECT IMPORT, and it is load-bearing. `chartMarkHonoursDataPointOverrides`
// answers FALSE for an id that is not registered — a mark that never registered
// cannot have promised anything — and registering the eighteen built-ins is
// chartDispatch's job, done at import time. In the product the pane reaches it
// through rendering/chartRenderer, which this file replaces with a double; so
// without this line the built-in POSITIVE CONTROLS below would fail for a reason
// that has nothing to do with the gate, and "bar" would look like a mark that
// declines per-point formatting.
import "../../rendering/chartDispatch";
import { ChartFormatPane } from "../ChartFormatPane";
import { ChartContextMenu } from "../ChartContextMenu";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A custom mark id that declares nothing — the case the gate exists for. */
const SILENT = "sandbox:silent-mark";
/** A custom mark id that declares it honours per-point formatting. */
const DECLARED = "sandbox:declared-mark";

function axis(): ChartSpec["xAxis"] {
  return { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null };
}

function chart(mark: string): ChartDefinition {
  return {
    chartId: "c1",
    name: "Chart 1",
    sheetIndex: 0,
    x: 0,
    y: 0,
    width: 400,
    height: 300,
    spec: {
      mark,
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
    },
  } as ChartDefinition;
}

function registerCustomMark(markId: string, honours: boolean): void {
  registerChartMark(markId, {
    meta: {
      label: markId,
      layoutFamily: "cartesian",
      sandboxed: true,
      ...(honours ? { honoursDataPointOverrides: true } : {}),
    },
    paint: () => undefined,
    computeLayout: () => ({}),
    computeGeometry: () => null,
  } as unknown as Parameters<typeof registerChartMark>[1]);
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;

async function mountPane(): Promise<void> {
  await act(async () => {
    root.render(React.createElement(ChartFormatPane, {}));
  });
}

async function mountMenu(): Promise<void> {
  await act(async () => {
    root.render(
      React.createElement(ChartContextMenu, {
        onClose: () => undefined,
        data: { chartId: "c1", screenX: 10, screenY: 10 },
      }),
    );
  });
}

function menuItem(id: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-chart-menu-item="${id}"]`);
}

function labelled(label: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[aria-label="${label}"]`);
}

const POINT: ChartSelectionTarget = {
  chartId: "c1",
  chartName: "Chart 1",
  level: "dataPoint",
  seriesIndex: 0,
  categoryIndex: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  resetChartSelectionRegistry();
  registerCustomMark(SILENT, false);
  registerCustomMark(DECLARED, true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  unregisterChartMark(SILENT);
  unregisterChartMark(DECLARED);
  resetChartSelectionRegistry();
  setChartRightClickTarget(null);
  store = null;
});

// ---------------------------------------------------------------------------
// The predicate the two doors share
// ---------------------------------------------------------------------------

describe("markOffersPerPointFormatting", () => {
  it("offers a built-in and a DECLARED custom mark, refuses a silent one", () => {
    expect(markOffersPerPointFormatting("bar")).toBe(true);
    expect(markOffersPerPointFormatting(DECLARED)).toBe(true);
    expect(markOffersPerPointFormatting(SILENT)).toBe(false);
  });

  it("OFFERS an unregistered id, where the declaration predicate refuses it", () => {
    // The asymmetry is the whole point, and it is load-bearing rather than
    // cosmetic. `chartMarkHonoursDataPointOverrides` says false for an unknown
    // id — a mark that never registered cannot have promised anything — and
    // gating on that directly made the pane tell a reader that a BAR CHART does
    // not support per-point formatting whenever the registry had not been
    // populated yet (it took 15 previously-green tests with it). A false
    // refusal is a lie about the product; the case it would catch cannot arise,
    // because an unregistered mark paints nothing and there is no datum to
    // click.
    expect(chartMarkHonoursDataPointOverrides("sandbox:never-registered")).toBe(false);
    expect(markOffersPerPointFormatting("sandbox:never-registered")).toBe(true);
  });

  it("starts refusing the moment a silent mark registers, and stops when it goes", () => {
    // Registration is what makes the refusal knowable, so the rule is pinned
    // across the transition rather than at one instant.
    const id = "sandbox:transient-mark";
    expect(markOffersPerPointFormatting(id)).toBe(true);
    registerCustomMark(id, false);
    expect(markOffersPerPointFormatting(id)).toBe(false);
    unregisterChartMark(id);
    expect(markOffersPerPointFormatting(id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Door 1 — the Format pane
// ---------------------------------------------------------------------------

describe("the Format pane's Data Point sections", () => {
  it("offers the colour control on a built-in mark (the positive control)", async () => {
    store = chart("bar");
    await act(async () => {
      publishChartSelection(POINT);
    });
    await mountPane();

    expect(labelled("Fill colour")).not.toBeNull();
    expect(container.textContent).not.toContain("does not support formatting a single data point");
  });

  it("offers it on a custom mark that DECLARED", async () => {
    store = chart(DECLARED);
    await act(async () => {
      publishChartSelection(POINT);
    });
    await mountPane();

    expect(labelled("Fill colour")).not.toBeNull();
  });

  it("refuses, in words, on a custom mark that did not", async () => {
    store = chart(SILENT);
    await act(async () => {
      publishChartSelection(POINT);
    });
    await mountPane();

    // No control at all: a disabled-looking field the reader can still click is
    // the same trap one step later.
    expect(labelled("Fill colour")).toBeNull();
    expect(container.textContent).toContain("does not support formatting a single data point");
  });

  it("still shows the pane and its subject — only the controls are withheld", async () => {
    // The refusal must not read as "nothing is selected". The reader clicked a
    // datum and the pane must go on saying so.
    store = chart(SILENT);
    await act(async () => {
      publishChartSelection(POINT);
    });
    await mountPane();

    expect(container.querySelector('[data-testid="chart-format-pane"]')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="chart-format-subject"]')?.textContent ?? "",
    ).toContain("Point");
  });
});

// ---------------------------------------------------------------------------
// Door 2 — the context menu
// ---------------------------------------------------------------------------

describe("the context menu's Format verb on a data point", () => {
  function rightClickAPoint(): void {
    setChartRightClickTarget({
      chartId: "c1",
      element: "datum",
      seriesIndex: 0,
      pointIndex: 1,
      seriesName: "Sales",
      categoryName: "Feb",
      value: 42,
    });
  }

  it("offers Format Data Point... on a built-in mark (the positive control)", async () => {
    store = chart("bar");
    rightClickAPoint();
    await mountMenu();

    const row = menuItem("formatElement");
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain("Data Point");
  });

  it("offers it on a custom mark that DECLARED", async () => {
    store = chart(DECLARED);
    rightClickAPoint();
    await mountMenu();

    expect(menuItem("formatElement")).not.toBeNull();
  });

  it("withholds the row entirely on a custom mark that did not", async () => {
    store = chart(SILENT);
    rightClickAPoint();
    await mountMenu();

    expect(menuItem("formatElement")).toBeNull();
    // ...and the menu is still a menu: the destructive and structural verbs,
    // which have nothing to do with per-point formatting, are untouched.
    expect(menuItem("deleteChart")).not.toBeNull();
  });

  it("keeps the Format verb for the CHART on a silent mark — only the POINT is refused", async () => {
    // The gate is about the subject, not about the mark as a whole. A
    // right-click on the chart area of the very same chart still formats.
    store = chart(SILENT);
    setChartRightClickTarget({ chartId: "c1", element: "chartArea" });
    await mountMenu();

    expect(menuItem("formatElement")).not.toBeNull();
  });
});
