//! FILENAME: app/extensions/Charts/lib/chartSpecNormalize.ts
// PURPOSE: Complete a ChartSpec that arrived from OUTSIDE the type system, so a
//          missing structural field can never make a chart paint its own
//          exception into the workbook.
// CONTEXT: `ChartSpec` declares `xAxis`, `yAxis`, `legend`, `palette`, `series`
//          and `categoryIndex` as REQUIRED, and the painters believe it: forty
//          call sites read `spec.xAxis.title`, `spec.legend.visible` and friends
//          with no guard. That is the right shape for the painters — a painter
//          that has to defend against a half-built spec is a painter nobody can
//          read.
//
//          The declaration is a lie at exactly one place: the boundary where a
//          chart comes back as JSON. `chartStore.fromEntry` does
//          `JSON.parse(entry.specJson) as ChartDefinition` — an unchecked cast
//          over a blob that may have been written by an older build, by an
//          `.xlsx` import, by a `.calp`, by a sandboxed script, or by anything
//          at all that can reach the `save_chart` command. When such a blob is
//          missing `yAxis`, `computeLayout` throws
//
//              Cannot read properties of undefined (reading 'title')
//
//          the renderer catches it and paints an error CARD — "Chart data error"
//          plus the exception text — into the grid. The chart is not broken data
//          being reported honestly; it is a structurally incomplete record that
//          nothing completed. The user sees a red error where a bar chart should
//          be, and no action in the product fixes it.
//
//          WHY COMPLETE AND NOT REJECT. Dropping the chart loses the user's
//          object and its placement over a field that has a perfectly good
//          default; refusing to render leaves a blank rectangle, which reads as
//          "the chart disappeared". Completing it renders the chart the author
//          meant, with default axes — the same defaults `buildDefaultSpec` gives
//          every new chart. `validateChartSpec` still runs at load and still
//          warns, so a genuinely malformed spec is not hidden; it is simply no
//          longer allowed to take the paint path down with it.
//
//          This is a REPAIR, not a schema. It fills absent structure only. It
//          never rewrites a value the spec actually carries, so a round-trip
//          through the store cannot change a chart that was already complete.

import type {
  AxisSpec,
  ChartDefinition,
  ChartSpec,
  LegendSpec,
} from "../types";

/** True for non-null, non-array objects. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The axis every painter can render without checking anything. */
function defaultAxis(gridLines: boolean): AxisSpec {
  return {
    title: null,
    gridLines,
    showLabels: true,
    labelAngle: 0,
    min: null,
    max: null,
  };
}

/** The legend every painter can lay out without checking anything. */
function defaultLegend(): LegendSpec {
  return { visible: true, position: "bottom" };
}

/**
 * Complete an axis: keep every field the spec supplies, supply the rest.
 *
 * A spec that carries `{ "xAxis": { "title": "Month" } }` — which is exactly
 * what a hand-written spec or a partial script patch looks like — is as fatal to
 * `spec.xAxis.gridLines` as a missing axis is, so the fields are filled
 * individually rather than only the object as a whole.
 */
function completeAxis(raw: unknown, gridLines: boolean): AxisSpec {
  const base = defaultAxis(gridLines);
  if (!isPlainObject(raw)) return base;
  return { ...base, ...(raw as Partial<AxisSpec>) };
}

/** Complete a legend the same way, field by field. */
function completeLegend(raw: unknown): LegendSpec {
  const base = defaultLegend();
  if (!isPlainObject(raw)) return base;
  return { ...base, ...(raw as Partial<LegendSpec>) };
}

/**
 * Whether `raw` is missing any structure the painters dereference unguarded.
 *
 * Exported so a caller can tell "this was repaired" from "this was already
 * whole" — `loadChartsFromBackend` uses it to keep its load-time warning honest
 * instead of announcing a repair that did nothing.
 */
export function chartSpecNeedsRepair(raw: unknown): boolean {
  if (!isPlainObject(raw)) return true;
  const axisIncomplete = (v: unknown): boolean => {
    if (!isPlainObject(v)) return true;
    for (const key of ["title", "gridLines", "showLabels", "labelAngle", "min", "max"]) {
      if (!(key in v)) return true;
    }
    return false;
  };
  if (axisIncomplete(raw.xAxis)) return true;
  if (axisIncomplete(raw.yAxis)) return true;
  if (!isPlainObject(raw.legend)) return true;
  if (!("visible" in raw.legend) || !("position" in raw.legend)) return true;
  if (typeof raw.palette !== "string") return true;
  if (!Array.isArray(raw.series)) return true;
  if (typeof raw.categoryIndex !== "number") return true;
  if (!("title" in raw)) return true;
  return false;
}

/**
 * Return a spec that every painter can render.
 *
 * Pure: `raw` is never mutated. When nothing is missing the result is a shallow
 * copy with the same values, so calling this on a complete spec is a no-op in
 * everything but identity.
 */
export function normalizeChartSpec(raw: unknown): ChartSpec {
  const source: Record<string, unknown> = isPlainObject(raw) ? raw : {};
  const spec = { ...source } as unknown as ChartSpec;

  spec.xAxis = completeAxis(source.xAxis, false);
  // The Y axis carries gridlines by default and the X axis does not — the same
  // asymmetry buildDefaultSpec gives a new chart, so a repaired chart looks like
  // a created one rather than like a repaired one.
  spec.yAxis = completeAxis(source.yAxis, true);
  spec.legend = completeLegend(source.legend);

  if (typeof spec.palette !== "string") spec.palette = "default";
  if (!Array.isArray(spec.series)) spec.series = [];
  if (typeof spec.categoryIndex !== "number") spec.categoryIndex = 0;
  if (!("title" in source)) spec.title = null;
  if (typeof spec.hasHeaders !== "boolean") spec.hasHeaders = true;
  if (spec.seriesOrientation !== "rows" && spec.seriesOrientation !== "columns") {
    spec.seriesOrientation = "columns";
  }
  return spec;
}

/**
 * Complete a persisted chart RECORD, not just its spec.
 *
 * Two shapes reach this. The one the store writes is a `ChartDefinition` with a
 * nested `spec`. The other is a bare `ChartSpec` — what you get when something
 * calls the `save_chart` command directly with the spec as the whole payload,
 * which is a thing scripts, the MCP tools and the E2E harness all do. Parsing
 * the second as the first yields `spec: undefined`, and every read after that is
 * a crash. Detect it by the fields only a spec has (`mark`) and wrap it.
 *
 * `fallback` supplies the identity and geometry a bare spec has no room for.
 */
export function normalizeChartDefinition(
  raw: unknown,
  fallback: { chartId: string; sheetIndex: number },
): ChartDefinition {
  const source: Record<string, unknown> = isPlainObject(raw) ? raw : {};
  const looksLikeBareSpec = !isPlainObject(source.spec) && typeof source.mark === "string";
  const specSource = looksLikeBareSpec ? source : source.spec;

  return {
    chartId: typeof source.chartId === "string" ? source.chartId : fallback.chartId,
    name: typeof source.name === "string" ? source.name : "Chart",
    sheetIndex:
      typeof source.sheetIndex === "number" ? source.sheetIndex : fallback.sheetIndex,
    // A bare spec carries no placement. These are the same numbers the create
    // path uses for a chart dropped without an explicit rectangle, so the object
    // is visible and selectable rather than a zero-sized invisible region the
    // user cannot click to delete.
    x: typeof source.x === "number" ? source.x : 100,
    y: typeof source.y === "number" ? source.y : 100,
    width: typeof source.width === "number" ? source.width : 600,
    height: typeof source.height === "number" ? source.height : 400,
    spec: normalizeChartSpec(specSource),
  };
}
