//! FILENAME: app/extensions/Charts/lib/chartBindingsRegistration.ts
// PURPOSE: The Charts extension's half of the object-binding seam: which chart
//          properties the UI offers to bind (the `chart` registration), and the
//          repaint when a chart's bound values change.
// CONTEXT: D-BIND §3.18. Rust owns the catalog; this file only CHOOSES, per
//          chart, which catalog rows to offer and what the pane calls them.
//          Every offered pointer is derived from the catalog mirror
//          (`rowsOf("chart")`) and passes `isBindablePath`, so the pane can
//          never offer an fx button Rust would refuse.
//
//          THE REPAINT. A binding change invalidates the render cache of the
//          charts it names and asks for an overlay redraw -- never
//          `AppEvents.GRID_REFRESH`, which the bridge would otherwise answer
//          with a re-evaluation (the feedback loop of §3.16: a volatile
//          `=NOW()` title would re-evaluate once per frame forever). Only the
//          charts the change names are invalidated: the seam's cache diffs every
//          answer, and a reload lists every object whose bindings or values
//          really changed, so a binding edit on one chart never re-reads the
//          data of every other chart in the workbook.

import {
  isBindablePath,
  onBindingsChanged,
  registerBindableProperties,
  rowsOf,
  escapePointerSegment,
  type BindablePropertiesRegistration,
  type BindablePropertyDescriptor,
  type ObjectBindingsChange,
  type ObjectBindingRef,
} from "@api/objectBindings";
import { requestOverlayRedraw, type GridRegion } from "@api/gridOverlays";
import { appendContainerBindableDescriptors } from "@api/objectFormat";
import type { ChartSpec } from "../types";
import { CHART_BINDING_KIND, chartBindingRef } from "./chartBindings";
import { getChartById } from "./chartStore";
import { chartRegionOf } from "./chartObjectPane";
import { invalidateChartCache } from "../rendering/chartRenderer";
import { chartSpecJsonSchema, markOptionsDefinitionFor } from "./chartSpecSchema";

/** The grid region type a chart is drawn as (chartStore `syncChartRegions`). */
export const CHART_REGION_TYPE = "chart";

const MARK_OPTIONS_PREFIX = "/spec/markOptions/";
const THEME_PREFIX = "/spec/config/theme/";

/** What the Format pane calls a mark option a KPI / card / gauge can bind. */
const MARK_OPTION_LABELS: Readonly<Record<string, string>> = {
  goal: "Goal",
  min: "Minimum",
  max: "Maximum",
  target: "Target",
  calloutFontSize: "Callout font size",
  decimals: "Decimal places",
  displayUnits: "Display units",
  goodColor: "Good colour",
  badColor: "Bad colour",
  neutralColor: "Neutral colour",
  trackColor: "Track colour",
  targetColor: "Target colour",
};

/** What the Format pane calls a bindable theme field. */
const THEME_LABELS: Readonly<Record<string, string>> = {
  plotBackground: "Plot area background",
  gridLineColor: "Gridline colour",
  axisColor: "Axis line colour",
  axisLabelColor: "Axis label colour",
  axisTitleColor: "Axis title colour",
  titleColor: "Title colour",
  legendTextColor: "Legend text colour",
  titleFontSize: "Title size",
  axisTitleFontSize: "Axis title size",
  labelFontSize: "Label size",
  legendFontSize: "Legend text size",
};

/** The last segment of a concrete catalog pointer under `prefix`, or null. */
function leafUnder(pointer: string, prefix: string): string | null {
  if (!pointer.startsWith(prefix)) return null;
  const leaf = pointer.slice(prefix.length);
  return leaf !== "" && !leaf.includes("/") && leaf !== "*" ? leaf : null;
}

/** The mark-option keys the chart's mark declares (null: the mark does not narrow). */
function declaredMarkOptionKeys(mark: string): ReadonlySet<string> | null {
  const defName = markOptionsDefinitionFor(mark);
  if (defName === null) return null;
  const defs = (chartSpecJsonSchema as { definitions?: Record<string, { properties?: Record<string, unknown> }> })
    .definitions;
  return new Set(Object.keys(defs?.[defName]?.properties ?? {}));
}

/**
 * The properties a chart offers to bind, in pane order. Pure in `spec`: the
 * series names, colour keys and params are the chart's own; every pointer is a
 * concrete instance of a catalog row and is checked against the catalog before
 * it is offered.
 */
export function chartBindableProperties(spec: ChartSpec | null | undefined): BindablePropertyDescriptor[] {
  const out: BindablePropertyDescriptor[] = [];
  const offer = (pointer: string, label: string, group: string): void => {
    if (isBindablePath(CHART_BINDING_KIND, pointer)) out.push({ pointer, label, group });
  };

  offer("/spec/title", "Title", "Chart Title");
  offer("/spec/xAxis/title", "Title", "Horizontal Axis");
  offer("/spec/xAxis/min", "Minimum", "Horizontal Axis");
  offer("/spec/xAxis/max", "Maximum", "Horizontal Axis");
  offer("/spec/yAxis/title", "Title", "Vertical Axis");
  offer("/spec/yAxis/min", "Minimum", "Vertical Axis");
  offer("/spec/yAxis/max", "Maximum", "Vertical Axis");
  if (!spec) return out;

  (spec.series ?? []).forEach((series, i) => {
    const shown = typeof series?.name === "string" && series.name !== "" ? series.name : `Series ${i + 1}`;
    offer(`/spec/series/${i}/name`, `${shown}: name`, "Series");
    // `seriesColors` is keyed by the series' NAME (the colour a selected series
    // takes, types.ts); a name the catalog's key rule refuses is not offered.
    if (typeof series?.name === "string" && series.name !== "") {
      offer(`/spec/seriesColors/${escapePointerSegment(series.name)}`, `${shown}: colour`, "Series");
    }
  });

  (spec.params ?? []).forEach((param, i) => {
    const name = typeof param?.name === "string" && param.name !== "" ? param.name : `Parameter ${i + 1}`;
    offer(`/spec/params/${i}/value`, `${name}: value`, "Parameters");
  });

  const declared = declaredMarkOptionKeys(spec.mark);
  if (declared !== null) {
    for (const row of rowsOf(CHART_BINDING_KIND)) {
      const key = leafUnder(row.pointer, MARK_OPTIONS_PREFIX);
      if (key === null || !declared.has(key)) continue;
      offer(row.pointer, MARK_OPTION_LABELS[key] ?? key, "Visual");
    }
  }

  for (const row of rowsOf(CHART_BINDING_KIND)) {
    const key = leafUnder(row.pointer, THEME_PREFIX);
    if (key === null) continue;
    offer(row.pointer, THEME_LABELS[key] ?? key, "Colours and Text");
  }
  return out;
}

/** The chart id a chart region carries (chartStore `syncChartRegions`), or null. */
function chartIdOfRegion(region: GridRegion): string | null {
  const id = (region.data as { chartId?: unknown } | undefined)?.chartId;
  return typeof id === "string" && id !== "" ? id : null;
}

/** The `chart` registration (one per kind; WP-C appends its container rows in `properties`). */
export const chartBindingsRegistration: BindablePropertiesRegistration = {
  kind: CHART_BINDING_KIND,
  regionTypes: [CHART_REGION_TYPE],
  refOf: (region) => {
    const id = chartIdOfRegion(region);
    return id !== null && getChartById(id) ? chartBindingRef(id) : null;
  },
  // A chart's script instance id IS its chart id (ChartContextMenu "Edit Script...").
  refForInstance: (instanceId) => (getChartById(instanceId) ? chartBindingRef(instanceId) : null),
  // The chart's own rows, then its VISUAL CONTAINER's (WP-C, @api/objectFormat): every
  // container field the chart's format provider binds, never repeating a pointer
  // listed above (the title's text / colour / size are the chart's own rows). A
  // script that names the chart by instance id gets them too, from the chart's
  // published region when it is on screen.
  properties: (ref: ObjectBindingRef, region: GridRegion | null) =>
    appendContainerBindableDescriptors(
      chartBindableProperties(getChartById(ref.id)?.spec),
      region ?? chartRegionOf(ref.id),
    ),
};

/**
 * The charts a binding change names, existing ones only, each once. Every other
 * kind is ignored: a control's or a slicer's binding never repaints a chart.
 */
export function chartIdsInBindingChange(change: ObjectBindingsChange): string[] {
  const ids = new Set<string>();
  for (const object of change.objects) {
    if (object.kind !== CHART_BINDING_KIND) continue;
    if (getChartById(object.id)) ids.add(object.id);
  }
  return [...ids];
}

/**
 * `onBindingsChanged` for charts: invalidate the render cache of exactly the
 * charts the change names and request ONE overlay redraw. Returns the charts it
 * invalidated (the test reads it).
 */
export function handleChartBindingsChanged(change: ObjectBindingsChange): string[] {
  const ids = chartIdsInBindingChange(change);
  if (ids.length === 0) return ids;
  for (const id of ids) invalidateChartCache(id);
  requestOverlayRedraw();
  return ids;
}

/** Register the `chart` kind and listen for binding changes. Returns the teardown. */
export function installChartBindings(): () => void {
  const unregister = registerBindableProperties(chartBindingsRegistration);
  const unsubscribe = onBindingsChanged(handleChartBindingsChanged);
  return () => {
    unsubscribe();
    unregister();
  };
}
