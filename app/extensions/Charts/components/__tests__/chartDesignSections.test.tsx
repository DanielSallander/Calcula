//! FILENAME: app/extensions/Charts/components/__tests__/chartDesignSections.test.tsx
// PURPOSE: The rebuilt Chart Design band — six clusters on the @api/layout
//          control grammar (Type, Elements, Layout, Style, Data, Actions) and
//          the Chart JSON task pane that replaced the fixed-position overlay.
// CONTEXT: Every cluster is rendered under BOTH surfaces (the ribbon band and a
//          sidebar panel) and must render no native <select>, nothing
//          `position: fixed`, and no hardcoded colour (findHardcodedColours;
//          palette bars and series swatches are data and carry
//          data-colour-data). Then the behaviour: a type tile writes the mark,
//          the element toggles toggle, the option cards write their options,
//          a pie drops the Layout cluster, and the JSON hero drives the pane.
//
//          The chart STORE is real (seeded through the backend double), so
//          every assertion reads the spec the product actually stored.

/* eslint-disable @typescript-eslint/naming-convention -- the module doubles
   below mirror PascalCase exports (AppEvents, MonacoJsonEditor) and DOM
   attribute names (data-testid). */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// ----------------------------------------------------------------------------
// Doubles
// ----------------------------------------------------------------------------

vi.mock("@api/dialogs", () => ({ alertAsync: vi.fn(() => Promise.resolve()) }));

let cachedSeries: Array<{ name: string; values: number[]; color: string | null }> = [];
let cachedCategories: string[] = [];

vi.mock("../../rendering/chartRenderer", () => ({
  getCachedChartData: () => ({
    data: { series: cachedSeries, categories: cachedCategories },
    unfilteredData: { series: cachedSeries, categories: cachedCategories },
  }),
  invalidateChartCache: vi.fn(),
}));

let currentChartId: string | null = null;
let subSelection: Record<string, unknown> = { level: "chart" };
vi.mock("../../handlers/selectionHandler", () => ({
  getCurrentChartId: () => currentChartId,
  getSubSelection: () => subSelection,
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

const showDialog = vi.fn();
vi.mock("@api", () => ({
  showDialog: (...a: unknown[]) => showDialog(...a),
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
  CHART_DESIGN_TAB_ID: "chart-design",
}));

const openTaskPane = vi.fn();
const closeTaskPane = vi.fn();
let openPaneIds: string[] = [];
let paneContainerOpen = false;
vi.mock("@api/ui", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    openTaskPane: (...a: unknown[]) => openTaskPane(...a),
    closeTaskPane: (...a: unknown[]) => closeTaskPane(...a),
    useTaskPaneOpenPaneIds: () => openPaneIds,
    useIsTaskPaneOpen: () => paneContainerOpen,
  };
});

const getObjectJson = vi.fn();
vi.mock("@api/jsonView", () => ({
  getObjectJson: (...a: unknown[]) => getObjectJson(...a),
  setObjectJson: vi.fn(() => Promise.resolve()),
}));

// Monaco cannot run in jsdom; the pane's contract is what surrounds it.
vi.mock("../../../_shared/components/jsonToggle/MonacoJsonEditor", async () => {
  const R = await import("react");
  return {
    MonacoJsonEditor: ({ value }: { value: string }) =>
      R.createElement("textarea", { "data-testid": "json-editor", value, readOnly: true }),
  };
});

import {
  ChartTypeSection,
  ChartElementsSection,
  ChartLayoutSection,
  ChartStyleSection,
  ChartDataSection,
  ChartActionsSection,
  buildChartDesignSections,
} from "../ChartDesignSections";
import { ChartJsonPane, CHART_JSON_PANE_ID } from "../ChartJsonPane";
import { summarizeChartFilters } from "../ChartFilterDropdown";
import { CHART_TYPES, QUICK_CHART_TYPES } from "../chartTypeCatalog";
import { getStackModeFromSpec, setStackModeInOptions, supportsStacking } from "../../lib/stackMode";
import { getChartById, loadChartsFromBackend, resetChartStore } from "../../lib/chartStore";
import { chartsBackend } from "../../lib/chartsBackend";
import { publishChartSelection, resetChartSelectionRegistry } from "@api/chartSelection";
import { RibbonIcon } from "@api/ribbonIcons";
import {
  SurfaceLayoutProvider,
  bandLayout,
  panelLayout,
  findHardcodedColours,
  type SurfaceLayout,
} from "@api/layout";
import type { PanelSectionProps } from "@api/uiTypes";
import type { ChartSpec } from "../../types";

const ID = "chart-design-1";

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
    title: "Sales",
    xAxis: { title: null, gridLines: false, showLabels: true },
    yAxis: { title: null, gridLines: false, showLabels: true },
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

async function render(node: React.ReactElement, layout: SurfaceLayout = bandLayout()): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<SurfaceLayoutProvider value={layout}>{node}</SurfaceLayoutProvider>);
  });
}

async function rerender(node: React.ReactElement, layout: SurfaceLayout = bandLayout()): Promise<void> {
  await act(async () => {
    root!.render(<SurfaceLayoutProvider value={layout}>{node}</SurfaceLayoutProvider>);
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

async function click(el: Element | null): Promise<void> {
  if (el === null) throw new Error("click target missing");
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

function byTestId(testId: string, scope: ParentNode = document): HTMLElement {
  const el = scope.querySelector(`[data-testid="${testId}"]`);
  if (el === null) throw new Error(`no element [data-testid="${testId}"]`);
  return el as HTMLElement;
}

async function setRange(el: HTMLInputElement, value: number): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter?.call(el, String(value));
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

/** Elements painted `position: fixed` (inline or through a stylesheet rule). */
function fixedElements(scope: Element): Element[] {
  return Array.from(scope.querySelectorAll("*")).filter(
    (el) =>
      (el as HTMLElement).style?.position === "fixed" ||
      window.getComputedStyle(el).position === "fixed",
  );
}

/** The open card popover (a body portal tagged as a section flyout). */
function openFlyout(): HTMLElement {
  const flyouts = document.body.querySelectorAll("[data-section-flyout]");
  if (flyouts.length === 0) throw new Error("no popover is open");
  return flyouts[flyouts.length - 1] as HTMLElement;
}

beforeEach(() => {
  resetChartStore();
  resetChartSelectionRegistry();
  invokeBackend.mockReset();
  chartsBackend.set(invokeBackend);
  currentChartId = ID;
  subSelection = { level: "chart" };
  cachedSeries = [
    { name: "Revenue", values: [1, 2, 3], color: null },
    { name: "Cost", values: [3, 2, 1], color: null },
  ];
  cachedCategories = ["Jan", "Feb", "Mar"];
  openPaneIds = [];
  paneContainerOpen = false;
  openTaskPane.mockClear();
  closeTaskPane.mockClear();
  showDialog.mockClear();
  getObjectJson.mockReset();
});

afterEach(async () => {
  await unmount();
  document.body.innerHTML = "";
  resetChartStore();
  resetChartSelectionRegistry();
});

// ============================================================================
// Every cluster, on both surfaces: no <select>, nothing fixed, no literals
// ============================================================================

type Section = React.ComponentType<PanelSectionProps>;

const CLUSTERS: ReadonlyArray<[string, Section]> = [
  ["Type", ChartTypeSection],
  ["Elements", ChartElementsSection],
  ["Layout", ChartLayoutSection],
  ["Style", ChartStyleSection],
  ["Data", ChartDataSection],
  ["Actions", ChartActionsSection],
];

const SURFACES: ReadonlyArray<[string, () => SurfaceLayout]> = [
  ["band", () => bandLayout()],
  ["panel", () => panelLayout(320)],
];

describe("every Chart Design cluster follows the control grammar", () => {
  for (const [name, Component] of CLUSTERS) {
    for (const [surface, layout] of SURFACES) {
      it(`${name} (${surface}): renders, no <select>, nothing fixed, no hardcoded colours`, async () => {
        await seed(
          fixtureSpec({
            filters: { hiddenSeries: [], hiddenCategories: [0] },
            trendlines: [{ type: "linear", seriesIndex: 0 }],
          } as Partial<ChartSpec>),
        );
        await render(<Component placement={surface === "band" ? "ribbon" : "sidebar"} />, layout());

        expect(container.childElementCount).toBeGreaterThan(0);
        expect(container.querySelector("select")).toBeNull();
        expect(fixedElements(container)).toEqual([]);
        expect(findHardcodedColours(container)).toEqual([]);
      });
    }
  }

  it("the band clusters fill the 61px content box (one tall row or two 28px rows)", async () => {
    await seed(fixtureSpec());
    for (const [, Component] of CLUSTERS) {
      await render(<Component placement="ribbon" />);
      const top = container.firstElementChild as HTMLElement;
      expect(top).not.toBeNull();
      // Elements is a pill (61 by its own size); the others set the box height.
      expect(window.getComputedStyle(top).height).toBe("61px");
      await unmount();
    }
  });

  it("the open cards paint with tokens only", async () => {
    await seed(fixtureSpec());
    await render(<ChartLayoutSection placement="ribbon" />);
    await click(byTestId("chart-marks", container));
    expect(findHardcodedColours(openFlyout())).toEqual([]);
    expect(openFlyout().querySelector("select")).toBeNull();
    await unmount();

    await render(<ChartDataSection placement="ribbon" />);
    await click(byTestId("chart-filter", container));
    // The series dots are colour DATA and are skipped; the chrome is not.
    expect(findHardcodedColours(openFlyout())).toEqual([]);
  });
});

// ============================================================================
// Type
// ============================================================================

describe("Type", () => {
  it("offers the six quick types as tall radios named like Excel", async () => {
    await seed(fixtureSpec());
    await render(<ChartTypeSection placement="ribbon" />);

    const radios = Array.from(container.querySelectorAll('[role="radio"]'));
    expect(radios.map((r) => r.getAttribute("aria-label"))).toEqual([
      "Column chart",
      "Bar chart",
      "Line chart",
      "Area chart",
      "Pie chart",
      "Scatter chart",
    ]);
    expect(byTestId("chart-type-bar", container).getAttribute("aria-checked")).toBe("true");
    expect(byTestId("chart-type-more", container)).toBeTruthy();
  });

  it("clicking a type tile writes the mark", async () => {
    await seed(fixtureSpec());
    await render(<ChartTypeSection placement="ribbon" />);

    await click(byTestId("chart-type-line", container));

    expect(liveSpec().mark).toBe("line");
    expect(byTestId("chart-type-line", container).getAttribute("aria-checked")).toBe("true");
  });

  it("More opens every type as a gallery and marks itself when the type lives there", async () => {
    await seed(fixtureSpec());
    await render(<ChartTypeSection placement="ribbon" />);

    await click(byTestId("chart-type-more", container));
    const gallery = byTestId("chart-type-gallery");
    expect(gallery.querySelectorAll('[role="option"]')).toHaveLength(CHART_TYPES.length);

    await click(byTestId("chart-type-gallery-waterfall"));

    expect(liveSpec().mark).toBe("waterfall");
    expect(document.querySelector('[data-testid="chart-type-gallery"]')).toBeNull();
    expect(byTestId("chart-type-more", container).getAttribute("aria-pressed")).toBe("true");
  });

  it("in a panel the whole catalog is the inline gallery", async () => {
    await seed(fixtureSpec());
    await render(<ChartTypeSection placement="sidebar" />, panelLayout(320));

    expect(container.querySelectorAll('[role="option"]')).toHaveLength(CHART_TYPES.length);
    await click(byTestId("chart-type-pie", container));
    expect(liveSpec().mark).toBe("pie");
  });
});

// ============================================================================
// Elements
// ============================================================================

describe("Elements", () => {
  it("each toggle turns its element on and off in one click", async () => {
    await seed(fixtureSpec());
    await render(<ChartElementsSection placement="ribbon" />);

    const title = byTestId("chart-elem-title", container);
    expect(title.getAttribute("aria-pressed")).toBe("true");
    await click(title);
    expect(liveSpec().title).toBeNull();
    await click(byTestId("chart-elem-title", container));
    expect(liveSpec().title).toBe("Chart");

    await click(byTestId("chart-elem-gridlines", container));
    expect(liveSpec().yAxis.gridLines).toBe(true);
    await click(byTestId("chart-elem-gridlines", container));
    expect(liveSpec().yAxis.gridLines).toBe(false);

    await click(byTestId("chart-elem-legend", container));
    expect(liveSpec().legend.visible).toBe(false);

    await click(byTestId("chart-elem-axisLabels", container));
    expect(liveSpec().xAxis.showLabels).toBe(false);

    await click(byTestId("chart-elem-dataLabels", container));
    expect(liveSpec().dataLabels?.enabled).toBe(true);
    expect(byTestId("chart-elem-dataLabels", container).getAttribute("aria-pressed")).toBe("true");
  });

  it("the title chevron edits the title text", async () => {
    await seed(fixtureSpec());
    await render(<ChartElementsSection placement="ribbon" />);

    await click(byTestId("chart-elem-title-options", container));
    const input = byTestId("chart-title-input") as HTMLInputElement;
    expect(input.value).toBe("Sales");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "Quarterly sales");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(liveSpec().title).toBe("Quarterly sales");
  });

  it("the legend chevron is a menu of positions", async () => {
    await seed(fixtureSpec());
    await render(<ChartElementsSection placement="ribbon" />);

    await click(byTestId("chart-elem-legend-options", container));
    const items = Array.from(openFlyout().querySelectorAll('[role="menuitemradio"]'));
    expect(items.map((i) => i.textContent)).toEqual(["Bottom", "Top", "Left", "Right"]);
    expect(byTestId("chart-legend-right").getAttribute("aria-checked")).toBe("true");

    await click(byTestId("chart-legend-top"));

    expect(liveSpec().legend.position).toBe("top");
    expect(document.querySelector('[data-testid="chart-legend-top"]')).toBeNull();
  });

  it("the data-label chevron sets position and size, turning labels on", async () => {
    await seed(fixtureSpec());
    await render(<ChartElementsSection placement="ribbon" />);

    await click(byTestId("chart-elem-dataLabels-options", container));
    await click(byTestId("chart-datalabel-position-above"));
    expect(liveSpec().dataLabels).toMatchObject({ enabled: true, position: "above" });

    await setRange(byTestId("chart-datalabel-size") as HTMLInputElement, 14);
    expect(liveSpec().dataLabels?.fontSize).toBe(14);
  });

  it("a pie has no gridlines or axis-label toggles", async () => {
    await seed(fixtureSpec({ mark: "pie" } as Partial<ChartSpec>));
    await render(<ChartElementsSection placement="ribbon" />);

    expect(container.querySelector('[data-testid="chart-elem-gridlines"]')).toBeNull();
    expect(container.querySelector('[data-testid="chart-elem-axisLabels"]')).toBeNull();
    expect(container.querySelector('[data-testid="chart-elem-title"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="chart-elem-legend"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="chart-elem-dataLabels"]')).not.toBeNull();
  });
});

// ============================================================================
// Layout
// ============================================================================

describe("Layout", () => {
  it("the stacking pill writes the stack mode", async () => {
    await seed(fixtureSpec());
    await render(<ChartLayoutSection placement="ribbon" />);

    expect(byTestId("chart-stacking-none", container).getAttribute("aria-checked")).toBe("true");
    await click(byTestId("chart-stacking-stacked", container));
    expect(getStackModeFromSpec(liveSpec())).toBe("stacked");
    await click(byTestId("chart-stacking-percentStacked", container));
    expect(getStackModeFromSpec(liveSpec())).toBe("percentStacked");
  });

  it("the Bars card holds the gap / overlap / radius sliders", async () => {
    await seed(fixtureSpec());
    await render(<ChartLayoutSection placement="ribbon" />);

    const hero = byTestId("chart-marks", container);
    expect(hero.textContent).toContain("Bars");
    await click(hero);
    await setRange(byTestId("chart-bars-gap") as HTMLInputElement, 80);
    await setRange(byTestId("chart-bars-overlap") as HTMLInputElement, -20);
    await setRange(byTestId("chart-bars-radius") as HTMLInputElement, 6);
    expect(liveSpec().markOptions).toMatchObject({ gapWidth: 80, seriesOverlap: -20, borderRadius: 6 });
  });

  it("an area's card has width, shape, markers and fill", async () => {
    await seed(fixtureSpec({ mark: "area" } as Partial<ChartSpec>));
    await render(<ChartLayoutSection placement="ribbon" />);

    expect(byTestId("chart-marks", container).textContent).toContain("Area");
    await click(byTestId("chart-marks", container));
    await click(byTestId("chart-line-shape-smooth"));
    await click(byTestId("chart-line-markers"));
    await setRange(byTestId("chart-area-fill") as HTMLInputElement, 50);
    expect(liveSpec().markOptions).toMatchObject({
      interpolation: "smooth",
      showMarkers: true,
      fillOpacity: 0.5,
    });
  });

  it("a scatter chart keeps the pill in place, disabled; a combo adds the 2nd-axis switch", async () => {
    await seed(fixtureSpec({ mark: "scatter" } as Partial<ChartSpec>));
    await render(<ChartLayoutSection placement="ribbon" />);
    expect((byTestId("chart-stacking-stacked", container) as HTMLButtonElement).disabled).toBe(true);
    expect(container.querySelector('[data-testid="chart-marks"]')).toBeNull();
    await unmount();

    await seed(fixtureSpec({ mark: "combo" } as Partial<ChartSpec>));
    await render(<ChartLayoutSection placement="ribbon" />);
    const axis = byTestId("chart-secondary-axis", container) as HTMLInputElement;
    expect(axis.getAttribute("role")).toBe("switch");
    await click(axis);
    expect(liveSpec().markOptions).toMatchObject({ secondaryYAxis: true });
  });

  it("renders nothing for a pie (the section is not even registered)", async () => {
    await seed(fixtureSpec({ mark: "pie" } as Partial<ChartSpec>));
    await render(<ChartLayoutSection placement="ribbon" />);
    expect(container.childElementCount).toBe(0);
  });
});

// ============================================================================
// Style
// ============================================================================

describe("Style", () => {
  it("the palette strip writes the palette", async () => {
    await seed(fixtureSpec());
    await render(<ChartStyleSection placement="ribbon" />);

    expect(byTestId("chart-palette-default", container).getAttribute("aria-checked")).toBe("true");
    await click(byTestId("chart-palette-ocean", container));
    expect(liveSpec().palette).toBe("ocean");
  });

  it("the Series card hosts the per-series colour controls", async () => {
    await seed(fixtureSpec());
    await render(<ChartStyleSection placement="ribbon" />);

    await click(byTestId("chart-series", container));
    const card = openFlyout();
    expect(card.querySelector('[role="combobox"]')).not.toBeNull();
    expect(card.querySelector('input[type="color"]')).not.toBeNull();
    expect(card.querySelector("select")).toBeNull();
  });

  it("the Series button stays, disabled, on a pie", async () => {
    await seed(fixtureSpec({ mark: "pie" } as Partial<ChartSpec>));
    await render(<ChartStyleSection placement="ribbon" />);
    expect((byTestId("chart-series", container) as HTMLButtonElement).disabled).toBe(true);
  });
});

// ============================================================================
// Data
// ============================================================================

describe("Data", () => {
  it("shows an 'N of M' chip only while something is hidden", async () => {
    await seed(fixtureSpec());
    await render(<ChartDataSection placement="ribbon" />);
    expect(container.querySelector('[data-testid="chart-filter-chip"]')).toBeNull();
    await unmount();

    await seed(fixtureSpec({ filters: { hiddenSeries: [], hiddenCategories: [0, 2] } } as Partial<ChartSpec>));
    await render(<ChartDataSection placement="ribbon" />);
    expect(byTestId("chart-filter-chip", container).textContent).toBe("1 of 3");
  });

  it("the Filter card is a checklist whose changes go through the filter model", async () => {
    await seed(fixtureSpec());
    await render(<ChartDataSection placement="ribbon" />);

    await click(byTestId("chart-filter", container));
    await click(byTestId("chart-filter-series-0"));
    expect(liveSpec().filters).toEqual({ hiddenSeries: [0], hiddenCategories: [] });

    await click(byTestId("chart-filter-category-1"));
    expect(liveSpec().filters).toEqual({ hiddenSeries: [0], hiddenCategories: [1] });

    await click(byTestId("chart-filter-clear"));
    expect(liveSpec().filters).toEqual({ hiddenSeries: [], hiddenCategories: [] });
  });

  it("the Trendline menu sets the type and the chip names it", async () => {
    await seed(fixtureSpec());
    await render(<ChartDataSection placement="ribbon" />);

    await click(byTestId("chart-trendline", container));
    const radios = Array.from(openFlyout().querySelectorAll('[role="menuitemradio"]'));
    expect(radios.map((r) => r.textContent)).toEqual([
      "None",
      "Linear",
      "Exponential",
      "Polynomial",
      "Logarithmic",
      "Power",
      "Moving average",
    ]);
    await click(byTestId("chart-trendline-linear"));

    expect(liveSpec().trendlines).toEqual([{ type: "linear", seriesIndex: 0 }]);
    expect(byTestId("chart-trendline-chip", container).textContent).toBe("Linear");

    await click(byTestId("chart-trendline", container));
    await click(byTestId("chart-trendline-equation"));
    expect(liveSpec().trendlines?.[0]).toMatchObject({ type: "linear", showEquation: true });
  });

  it("a pie drops the trendline row; a pivot chart drops Switch", async () => {
    await seed(fixtureSpec({ mark: "pie" } as Partial<ChartSpec>));
    await render(<ChartDataSection placement="ribbon" />);
    expect(container.querySelector('[data-testid="chart-trendline"]')).toBeNull();
    expect(container.querySelector('[data-testid="chart-switch-rowcol"]')).not.toBeNull();
    await unmount();

    const pivot = { type: "pivot", pivotId: "p1" };
    await seed(fixtureSpec({ data: pivot } as unknown as Partial<ChartSpec>));
    await render(<ChartDataSection placement="ribbon" />);
    expect(container.querySelector('[data-testid="chart-switch-rowcol"]')).toBeNull();
    expect((byTestId("chart-trendline", container) as HTMLButtonElement).disabled).toBe(false);
    await unmount();

    // A pivot PIE has neither Switch nor a trendline: the row stays, disabled,
    // so the cluster is two rows and not one short row alone.
    await seed(fixtureSpec({ mark: "pie", data: pivot } as unknown as Partial<ChartSpec>));
    await render(<ChartDataSection placement="ribbon" />);
    expect((byTestId("chart-trendline", container) as HTMLButtonElement).disabled).toBe(true);
  });
});

// ============================================================================
// Actions + the Chart JSON pane
// ============================================================================

describe("Actions", () => {
  it("Edit Chart opens the chart dialog for this chart", async () => {
    await seed(fixtureSpec());
    await render(<ChartActionsSection placement="ribbon" />);
    await click(byTestId("chart-edit", container));
    expect(showDialog).toHaveBeenCalledWith("chart:createDialog", { editChartId: ID });
  });

  it("Format Point appears only while a data point is selected", async () => {
    await seed(fixtureSpec());
    await render(<ChartActionsSection placement="ribbon" />);
    expect(container.querySelector('[data-testid="chart-format-point"]')).toBeNull();
    await unmount();

    subSelection = { level: "dataPoint", seriesIndex: 1, categoryIndex: 2 };
    await render(<ChartActionsSection placement="ribbon" />);
    await click(byTestId("chart-format-point", container));
    expect(showDialog).toHaveBeenCalledWith(
      "chart:dataPointFormat",
      expect.objectContaining({ chartId: ID, seriesIndex: 1, categoryIndex: 2, categoryName: "Mar" }),
    );
  });

  it("JSON opens the chart-json pane, and is pressed (and closes it) while it is open", async () => {
    await seed(fixtureSpec());
    await render(<ChartActionsSection placement="ribbon" />);

    const json = byTestId("chart-json-toggle", container);
    expect(json.getAttribute("aria-pressed")).toBe("false");
    await click(json);
    expect(openTaskPane).toHaveBeenCalledWith(CHART_JSON_PANE_ID);

    openPaneIds = [CHART_JSON_PANE_ID];
    paneContainerOpen = true;
    await rerender(<ChartActionsSection placement="ribbon" />);
    expect(byTestId("chart-json-toggle", container).getAttribute("aria-pressed")).toBe("true");
    await click(byTestId("chart-json-toggle", container));
    expect(closeTaskPane).toHaveBeenCalledWith(CHART_JSON_PANE_ID);
  });
});

describe("ChartJsonPane", () => {
  it("invites a selection when no chart is selected", async () => {
    await render(<ChartJsonPane />, panelLayout(320));
    expect(container.textContent).toContain("Select a chart");
    expect(getObjectJson).not.toHaveBeenCalled();
  });

  it("loads the selected chart's JSON into the editor, and reloads for another chart", async () => {
    getObjectJson.mockImplementation(async (_type: string, id: string) => `{ "id": "${id}" }`);
    publishChartSelection({ chartId: ID, chartName: "Chart 1", level: "chart" });
    await render(<ChartJsonPane />, panelLayout(320));
    await act(async () => {
      await Promise.resolve();
    });

    expect(getObjectJson).toHaveBeenCalledWith("chart", ID);
    expect((byTestId("json-editor", container) as HTMLTextAreaElement).value).toContain(ID);
    expect(container.textContent).toContain("Chart 1");
    expect(fixedElements(container)).toEqual([]);

    await act(async () => {
      publishChartSelection({ chartId: "chart-2", chartName: "Chart 2", level: "chart" });
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(getObjectJson).toHaveBeenLastCalledWith("chart", "chart-2");
    expect((byTestId("json-editor", container) as HTMLTextAreaElement).value).toContain("chart-2");
  });
});

// ============================================================================
// The section list, the catalog and the stack-mode helpers
// ============================================================================

describe("buildChartDesignSections", () => {
  it("is six clusters for an axis chart, each with an icon and a 320 flyout", async () => {
    await seed(fixtureSpec());
    const sections = buildChartDesignSections();
    expect(sections.map((s) => s.id)).toEqual([
      "chart-design.type",
      "chart-design.elements",
      "chart-design.layout",
      "chart-design.style",
      "chart-design.data",
      "chart-design.actions",
    ]);
    expect(sections.map((s) => s.label)).toEqual(["Type", "Elements", "Layout", "Style", "Data", "Actions"]);
    for (const s of sections) {
      expect(React.isValidElement(s.icon)).toBe(true);
      expect(s.flyoutWidth).toBe(320);
    }
    // Layout demotes first, Type last.
    const byPriority = [...sections].sort((a, b) => (a.collapsePriority ?? 0) - (b.collapsePriority ?? 0));
    expect(byPriority.map((s) => s.label)).toEqual(["Layout", "Actions", "Data", "Style", "Elements", "Type"]);
  });

  it("a pie drops Layout and nothing else; a type switch within a family keeps the ids", async () => {
    await seed(fixtureSpec({ mark: "pie" } as Partial<ChartSpec>));
    expect(buildChartDesignSections().map((s) => s.label)).toEqual([
      "Type",
      "Elements",
      "Style",
      "Data",
      "Actions",
    ]);

    await seed(fixtureSpec({ mark: "bar" } as Partial<ChartSpec>));
    const bar = buildChartDesignSections().map((s) => s.id).join("|");
    await seed(fixtureSpec({ mark: "line" } as Partial<ChartSpec>));
    const line = buildChartDesignSections().map((s) => s.id).join("|");
    expect(line).toBe(bar);
  });
});

describe("chartTypeCatalog", () => {
  it("lists all 18 built-in types, six quick, every icon a real RibbonIcon key", () => {
    expect(CHART_TYPES).toHaveLength(18);
    expect(new Set(CHART_TYPES.map((t) => t.value)).size).toBe(18);
    expect(QUICK_CHART_TYPES.map((t) => [t.value, t.label])).toEqual([
      ["bar", "Column"],
      ["horizontalBar", "Bar"],
      ["line", "Line"],
      ["area", "Area"],
      ["pie", "Pie"],
      ["scatter", "Scatter"],
    ]);
    for (const t of CHART_TYPES) {
      expect(typeof RibbonIcon[t.icon]).toBe("function");
    }
  });
});

describe("stackMode", () => {
  it("reads and writes the mode per mark, honouring area's legacy flag", () => {
    const area = fixtureSpec({ mark: "area", markOptions: { stacked: true } } as Partial<ChartSpec>);
    expect(getStackModeFromSpec(area)).toBe("stacked");
    expect(setStackModeInOptions(area, "none")).toMatchObject({ stackMode: "none", stacked: false });

    const bar = fixtureSpec({ markOptions: { gapWidth: 90 } } as Partial<ChartSpec>);
    expect(setStackModeInOptions(bar, "percentStacked")).toEqual({ gapWidth: 90, stackMode: "percentStacked" });

    expect(supportsStacking("horizontalBar")).toBe(true);
    expect(supportsStacking("scatter")).toBe(false);
  });
});

describe("summarizeChartFilters", () => {
  const data = {
    series: [
      { name: "A", values: [], color: null },
      { name: "B", values: [], color: null },
    ],
    categories: ["x", "y", "z", "w"],
  };

  it("counts only the filtered dimension", () => {
    expect(summarizeChartFilters({ hiddenSeries: [], hiddenCategories: [] }, data)).toBeNull();
    expect(summarizeChartFilters({ hiddenSeries: [], hiddenCategories: [1, 2, 3] }, data)).toEqual({
      hidden: 3,
      shown: 1,
      total: 4,
      noun: "categories",
    });
    expect(summarizeChartFilters({ hiddenSeries: [1], hiddenCategories: [] }, data)).toMatchObject({
      shown: 1,
      total: 2,
      noun: "series",
    });
    expect(summarizeChartFilters({ hiddenSeries: [1], hiddenCategories: [0] }, undefined)).toEqual({
      hidden: 2,
      shown: null,
      total: null,
      noun: "items",
    });
  });
});
