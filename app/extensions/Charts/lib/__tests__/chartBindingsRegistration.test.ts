//! FILENAME: app/extensions/Charts/lib/__tests__/chartBindingsRegistration.test.ts
// PURPOSE: The Charts half of the object-binding seam (D-BIND S8b):
//            - a binding change repaints THIS chart only -- the render cache
//              of exactly the charts the change names is invalidated, other
//              kinds and unknown charts are ignored, and the repaint is an
//              overlay redraw, never AppEvents.GRID_REFRESH (which the bridge
//              would answer with a re-evaluation: the volatile-binding loop);
//            - the `chart` registration turns a chart region (and a script
//              chart instance) into `{kind:"chart", id: chartId}`;
//            - what a chart offers to bind is a set of CONCRETE catalog
//              pointers, chosen per chart (its series, its params, the mark
//              options its mark declares).
// CONTEXT: The real seam (registry, catalog, cache, listener list); the chart
//          store, the renderer's cache and the overlay redraw are doubled.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ChartSpec } from "../../types";

const h = vi.hoisted(() => ({
  charts: new Map<string, { chartId: string; spec: unknown }>(),
  invalidated: [] as string[],
  redraws: 0,
}));

vi.mock("../chartStore", () => ({
  getChartById: (id: string) => h.charts.get(id) ?? null,
}));
vi.mock("../../rendering/chartRenderer", () => ({
  invalidateChartCache: (id: string) => {
    h.invalidated.push(id);
  },
}));
vi.mock("@api/gridOverlays", () => ({
  requestOverlayRedraw: () => {
    h.redraws++;
  },
}));

import {
  chartBindableProperties,
  handleChartBindingsChanged,
  installChartBindings,
  CHART_REGION_TYPE,
} from "../chartBindingsRegistration";
import {
  bindingRefForInstance,
  bindingRefForRegion,
  getBindableProperties,
  isBindablePath,
} from "@api/objectBindings";
import { notifyBindingsChanged } from "@api/objectBindings/cache";
import { registerObjectFormatProvider, resetObjectFormatProviders } from "@api/objectFormat";
import { createChartObjectFormatProvider } from "../chartObjectFormat";
import type { GridRegion } from "@api/gridOverlays";

const baseAxis = { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null };
function spec(over: Partial<ChartSpec> = {}): ChartSpec {
  return {
    mark: "bar",
    data: { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 3, endCol: 2 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [
      { name: "Sales", sourceIndex: 1, color: null },
      { name: "Cost", sourceIndex: 2, color: null },
    ],
    title: "T",
    xAxis: { ...baseAxis },
    yAxis: { ...baseAxis },
    legend: { visible: true, position: "bottom" },
    palette: "default",
    ...over,
  } as ChartSpec;
}

function region(chartId: string): GridRegion {
  return {
    id: `chart-${chartId}`,
    type: CHART_REGION_TYPE,
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    floating: { x: 0, y: 0, width: 200, height: 100 },
    data: { chartId, name: "Chart" },
  } as GridRegion;
}

const gridRefreshes: Event[] = [];
const onGridRefresh = (e: Event) => gridRefreshes.push(e);

beforeEach(() => {
  h.charts.clear();
  h.invalidated.length = 0;
  h.redraws = 0;
  gridRefreshes.length = 0;
  h.charts.set("c1", { chartId: "c1", spec: spec() });
  h.charts.set("c2", { chartId: "c2", spec: spec({ mark: "kpi" } as Partial<ChartSpec>) });
  window.addEventListener("app:grid-refresh", onGridRefresh);
});

afterEach(() => {
  window.removeEventListener("app:grid-refresh", onGridRefresh);
});

describe("a binding change repaints THIS chart only", () => {
  it("invalidates exactly the named chart and asks for ONE overlay redraw", () => {
    const ids = handleChartBindingsChanged({ objects: [{ kind: "chart", id: "c1" }], reload: false });
    expect(ids).toEqual(["c1"]);
    expect(h.invalidated).toEqual(["c1"]);
    expect(h.redraws).toBe(1);
  });

  it("a reload names only the charts whose bindings changed -- the others keep their cache", () => {
    handleChartBindingsChanged({ objects: [{ kind: "chart", id: "c2" }], reload: true });
    expect(h.invalidated).toEqual(["c2"]);
  });

  it("ignores other kinds, unknown charts, and duplicates", () => {
    const ids = handleChartBindingsChanged({
      objects: [
        { kind: "control", id: "c1" },
        { kind: "slicer", id: "s1" },
        { kind: "chart", id: "gone" },
        { kind: "chart", id: "c2" },
        { kind: "chart", id: "c2" },
      ],
      reload: false,
    });
    expect(ids).toEqual(["c2"]);
    expect(h.invalidated).toEqual(["c2"]);
    expect(h.redraws).toBe(1);
  });

  it("a change that names no chart repaints nothing", () => {
    handleChartBindingsChanged({ objects: [{ kind: "control", id: "u1" }], reload: true });
    expect(h.invalidated).toEqual([]);
    expect(h.redraws).toBe(0);
  });

  it("never emits GRID_REFRESH (the bridge would answer it with a re-evaluation)", () => {
    handleChartBindingsChanged({ objects: [{ kind: "chart", id: "c1" }], reload: true });
    expect(gridRefreshes).toEqual([]);
  });

  it("is wired to the seam's listener list by installChartBindings, and unwired by its teardown", () => {
    const teardown = installChartBindings();
    try {
      notifyBindingsChanged({ objects: [{ kind: "chart", id: "c1" }], reload: false });
      expect(h.invalidated).toEqual(["c1"]);
    } finally {
      teardown();
    }
    notifyBindingsChanged({ objects: [{ kind: "chart", id: "c2" }], reload: false });
    expect(h.invalidated).toEqual(["c1"]);
  });
});

describe("the chart registration", () => {
  it("turns a chart region and a chart script instance into the chart's ref", async () => {
    const teardown = installChartBindings();
    try {
      expect(await bindingRefForRegion(region("c1"))).toEqual({ kind: "chart", id: "c1" });
      expect(await bindingRefForRegion(region("gone"))).toBeNull();
      expect(await bindingRefForInstance("chart", "c2")).toEqual({ kind: "chart", id: "c2" });
      expect(await bindingRefForInstance("chart", "gone")).toBeNull();
    } finally {
      teardown();
    }
    expect(await bindingRefForRegion(region("c1"))).toBeNull();
  });

  it("offers only properties the catalog accepts (nothing is dropped by the seam)", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const teardown = installChartBindings();
    try {
      const got = await getBindableProperties(region("c1"));
      expect(got?.ref).toEqual({ kind: "chart", id: "c1" });
      expect(got?.properties.length).toBe(chartBindableProperties(spec()).length);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      teardown();
      errors.mockRestore();
    }
  });

  it("APPENDS the chart's container fields once its format provider is registered (WP-C, one registration per kind)", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const teardown = installChartBindings();
    const unprovide = registerObjectFormatProvider(
      createChartObjectFormatProvider({
        getStoredSpec: (id) => (h.charts.get(id)?.spec as ChartSpec | undefined) ?? null,
        updateSpec: () => {},
        previewSpec: () => {},
        restorePreview: () => null,
        repaint: () => {},
        flushQuietly: async () => [],
        reportOther: () => {},
      }),
    );
    try {
      const got = await getBindableProperties(region("c1"));
      const pointers = got!.properties.map((p) => p.pointer);
      // The chart's own rows come first and are not repeated...
      expect(pointers.slice(0, chartBindableProperties(spec()).length)).toEqual(
        chartBindableProperties(spec()).map((d) => d.pointer),
      );
      expect(pointers.filter((p) => p === "/spec/title")).toHaveLength(1);
      expect(pointers.filter((p) => p === "/spec/config/theme/titleColor")).toHaveLength(1);
      // ...then the container's, grouped under "Format"; lockAspect never.
      const border = got!.properties.find((p) => p.pointer === "/spec/container/border/radius");
      expect(border?.group).toBe("Format");
      expect(pointers).not.toContain("/spec/container/lockAspect");
      // Every pointer passes the catalog (none dropped and logged by the seam).
      expect(errors).not.toHaveBeenCalled();
    } finally {
      unprovide();
      teardown();
      resetObjectFormatProviders();
      errors.mockRestore();
    }
  });
});

describe("what a chart offers to bind", () => {
  it("every pointer is concrete and passes the catalog", () => {
    const props = chartBindableProperties(
      spec({ params: [{ name: "Threshold", value: 3 }], mark: "kpi" } as Partial<ChartSpec>),
    );
    expect(props.length).toBeGreaterThan(10);
    for (const p of props) {
      expect(p.pointer.includes("*")).toBe(false);
      expect(isBindablePath("chart", p.pointer)).not.toBeNull();
    }
  });

  it("offers the titles, each series' name and colour, and each param's value", () => {
    const pointers = chartBindableProperties(
      spec({ params: [{ name: "Threshold", value: 3 }] } as Partial<ChartSpec>),
    ).map((p) => p.pointer);
    for (const p of [
      "/spec/title",
      "/spec/xAxis/title",
      "/spec/yAxis/title",
      "/spec/yAxis/max",
      "/spec/series/0/name",
      "/spec/series/1/name",
      "/spec/seriesColors/Sales",
      "/spec/seriesColors/Cost",
      "/spec/params/0/value",
      "/spec/config/theme/titleColor",
    ]) {
      expect(pointers).toContain(p);
    }
    expect(pointers).not.toContain("/spec/series/2/name");
  });

  it("offers a KPI's goal but not a bar chart's (the mark's declared options only)", () => {
    const kpi = chartBindableProperties(spec({ mark: "kpi" } as Partial<ChartSpec>)).map((p) => p.pointer);
    const bar = chartBindableProperties(spec()).map((p) => p.pointer);
    expect(kpi).toContain("/spec/markOptions/goal");
    expect(bar.some((p) => p.startsWith("/spec/markOptions/"))).toBe(false);
  });

  it("a series name the catalog's key rule refuses is offered for its name, not its colour", () => {
    const pointers = chartBindableProperties(
      spec({ series: [{ name: "Sales/Cost", sourceIndex: 1, color: null }] } as Partial<ChartSpec>),
    ).map((p) => p.pointer);
    expect(pointers).toContain("/spec/series/0/name");
    expect(pointers.some((p) => p.startsWith("/spec/seriesColors/"))).toBe(false);
  });
});
