//! FILENAME: app/src/api/chartMarks.ts
// PURPOSE: IoC registry for chart marks (chart types), so extensions can add a
//          chart type without the kernel/Charts depending on them.
// CONTEXT: The API layer cannot import from extensions (Alien Rule). Chart marks
//          need Charts-internal render types (ChartLayout/HitGeometry/...), which
//          live in the Charts extension — so the public contract types those
//          heavy params as `unknown`. The Charts extension provides a thin typed
//          wrapper (rendering/markRegistry.ts) that casts at the boundary and
//          keeps full internal type safety. Built-in marks register through the
//          same path a third party would (dogfooding).

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** A rectangle in chart-local pixel space. */
export interface ChartMarkElementRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Names of the SINGLE-RECT chart elements (the collections have their own fields). */
export type ChartMarkElementKey =
  | "chartArea"
  | "title"
  | "xAxisTitle"
  | "yAxisTitle"
  | "xAxisBand"
  | "yAxisBand"
  | "legend"
  | "displayUnitLabel"
  | "dataTable";

/**
 * Rectangles for the chart's non-datum elements, so a custom mark can see where
 * the host drew the title, the axis bands and the legend and avoid painting
 * over them (or hit-test them the same way the host does).
 *
 * Structurally identical to the Charts-internal `ChartElementRects`. The rects
 * are a LAYOUT-STAGE ESTIMATE (axis-label and legend widths are approximated
 * from character counts) until a painter measures them and writes the truth
 * back; `measured` lists the keys that are truth. A stage that changes
 * `margin`/`plotArea` after layout must have the host recompute these — a mark
 * should never mutate them itself.
 */
export interface ChartMarkElementRects {
  family: "cartesian" | "radial";
  chartArea: ChartMarkElementRect;
  title?: ChartMarkElementRect;
  xAxisTitle?: ChartMarkElementRect;
  yAxisTitle?: ChartMarkElementRect;
  xAxisBand?: ChartMarkElementRect;
  yAxisBand?: ChartMarkElementRect;
  legend?: ChartMarkElementRect;
  /**
   * One rect per legend entry. `seriesIndex` is the painter-space series index
   * for cartesian legends and the painter-space category index for radial ones.
   */
  legendItems?: Array<{ seriesIndex: number; rect: ChartMarkElementRect }>;
  displayUnitLabel?: ChartMarkElementRect;
  /**
   * One POLYLINE per painted trendline — not a rect, because a fit running
   * corner to corner has a bounding box the size of the plot. `trendlineIndex`
   * indexes the spec's trendline list; `seriesIndex` is the series it tracks.
   */
  trendlines?: Array<{
    seriesIndex: number;
    trendlineIndex: number;
    points: Array<{ x: number; y: number }>;
  }>;
  /**
   * One rect per drawn error bar. Many rects, ONE identity: error bars are a
   * per-series object in Excel, with no per-point member.
   */
  errorBars?: Array<{ seriesIndex: number; rect: ChartMarkElementRect }>;
  /** One rect per painted data label. These ARE per point, so both indices travel. */
  dataLabels?: Array<{ seriesIndex: number; pointIndex: number; rect: ChartMarkElementRect }>;
  /** The data-table grid below the plot area. */
  dataTable?: ChartMarkElementRect;
  measured: ChartMarkElementKey[];
}

/**
 * Pure geometry of a laid-out chart, exposed so a custom mark can position
 * itself. A structural subset of the Charts-internal ChartLayout — cast the
 * opaque `layout` param to this in a custom mark's paint/geometry callbacks.
 */
export interface ChartMarkLayout {
  width: number;
  height: number;
  margin: { top: number; right: number; bottom: number; left: number };
  plotArea: { x: number; y: number; width: number; height: number };
  /** Rectangles for the non-datum chart elements. Absent on a hand-built layout. */
  elements?: ChartMarkElementRects;
}

/**
 * ONE datum's per-point formatting, already RESOLVED by the host, handed to a
 * custom mark so it can honour `spec.dataPointOverrides` without re-deriving
 * them.
 *
 * WHY THE HOST RESOLVES IT. Turning `spec.dataPointOverrides` into "what colour
 * is this datum" is not a lookup: an override is matched by identity KEY first
 * and by index pair second, the index pair is in AUTHORING space (pre-filter)
 * while a painter counts in PAINTER space (post-filter), a duplicated category
 * label has a documented tie-break, and `invertIfNegative` replaces the fill.
 * A mark that re-implemented that in script-land would be a THIRD spelling of
 * the rule and would drift from the built-ins on the first change. So the host
 * runs its own resolver and ships the answer.
 *
 * `seriesIndex` / `categoryIndex` are PAINTER space — the same indices the mark
 * is looping over — so no translation is needed on the mark's side.
 *
 * Only datums an override actually reached appear (see
 * {@link ChartMarkPaintContext.datumStyles}); everything else is the mark's own
 * default, which the host does not know. A field that is `null` means "this
 * override says nothing about it, keep your own".
 */
export interface ChartMarkDatumStyle {
  /** PAINTER-space series index (post-filter) — the mark's own loop counter. */
  seriesIndex: number;
  /** PAINTER-space category index (post-filter) — the mark's own loop counter. */
  categoryIndex: number;
  /** Fill colour for this datum, or null when the override sets none. */
  fill: string | null;
  /** Alpha 0..1, or null. */
  opacity: number | null;
  borderColor: string | null;
  borderWidth: number | null;
  /**
   * Marker shape name ("circle" | "square" | "diamond" | "triangle" | "cross" |
   * "star" | "none"), or null. `"none"` means "paint nothing for this datum".
   */
  markerStyle: string | null;
  markerSize: number | null;
  markerFill: string | null;
  markerBorderColor: string | null;
  markerBorderWidth: number | null;
  /** Radial pull-out distance in px. 0 when not exploded. */
  explodeOffset: number;
  /** True when `invertIfNegative` fired and `fill` is the inverted colour. */
  inverted: boolean;
  /**
   * Gradient / pattern fill for this datum, or null. Opaque here because their
   * shapes are Charts-internal (`GradientFill` / `PatternFill` in the Charts
   * `types.ts`); they cross the worker boundary as plain cloned objects.
   */
  gradientFill: unknown;
  patternFill: unknown;
  /** How the override was matched — the host's own audit of the resolution. */
  matchedBy: "key" | "index";
}

/**
 * The paint payload a SANDBOXED mark's `markRenderer` receives as its second
 * argument (`(ctx, paint, bounds) => ...`). Structural: the worker gets a
 * structured CLONE of it, so everything here is plain data.
 */
export interface ChartMarkPaintContext {
  /** The chart spec (cloned). */
  spec: unknown;
  /** The parsed chart data (cloned). */
  data: unknown;
  /** The laid-out chart — cast to {@link ChartMarkLayout}. */
  layout: unknown;
  /** The resolved render theme (cloned). */
  theme: unknown;
  /**
   * The resolved per-point overrides, SPARSE: one entry per datum an override
   * actually reached, and an EMPTY array when the chart has none. Read it
   * rather than `spec.dataPointOverrides` — see {@link ChartMarkDatumStyle} for
   * why the raw array is the wrong thing to index.
   */
  datumStyles: ChartMarkDatumStyle[];
}

/** Descriptive metadata for a chart mark (drives UI + axis classification). */
export interface ChartMarkMeta {
  /** Human-readable name shown in the chart-type picker. */
  label: string;
  /** Axis family: "cartesian" gets X/Y axes; "radial"/"other" do not. */
  layoutFamily: "cartesian" | "radial" | "other";
  /** True for the built-in marks (lets the UI group built-in vs custom). */
  builtin?: boolean;
  /**
   * True for a SANDBOXED mark (B8.D): its `paint` is a host-side shim that blits
   * a worker-rendered ImageBitmap into the plot area rather than drawing
   * synchronously. The mark code runs in a Worker realm with no main-thread
   * canvas/DOM access. Built-in + in-process custom marks leave this unset.
   */
  sandboxed?: boolean;
  /**
   * Optional explicit Y domain `[min, max]` a sandboxed cartesian mark declares so
   * the HOST-drawn Y axis (ticks/labels) aligns with the values the worker maps
   * into the plot. Absent → the host uses the data's extent. Ignored for radial
   * marks. (Feature 2: full host-drawn chrome for sandboxed marks.)
   */
  yDomain?: [number, number];
  /**
   * The mark DECLARES that it honours `spec.dataPointOverrides` — that it reads
   * {@link ChartMarkPaintContext.datumStyles} and paints the answer.
   *
   * WHY A DECLARATION AND NOT AN ASSUMPTION. A sandboxed mark's pixels arrive
   * as an opaque `ImageBitmap`; the host hands it the resolved styles but
   * cannot make it use them and cannot inspect the pixels to check. Without
   * this flag the Format pane would accept "colour THIS point" on any custom
   * mark and, for a mark that ignores the payload, nothing would happen — the
   * same silent-no-op defect shape as a setting that writes to the wrong
   * address. So the capability is opt-in and ASKABLE: see
   * {@link chartMarkHonoursDataPointOverrides}, which is what a UI offering
   * per-point formatting must consult.
   *
   * Built-in marks leave it unset — they all honour overrides, and the coverage
   * test in the Charts extension proves it mark by mark.
   */
  honoursDataPointOverrides?: boolean;
}

/**
 * A chart mark: how to paint it, lay it out, and hit-test it. The data/spec/
 * layout/theme params are opaque (`unknown`) at the API boundary; the Charts
 * renderer supplies the real types via its typed wrapper. Custom marks may cast
 * `layout` to {@link ChartMarkLayout} to find the plot rectangle.
 */
export interface ChartMarkDefinition {
  meta: ChartMarkMeta;
  paint(ctx: Ctx, data: unknown, spec: unknown, layout: unknown, theme: unknown): void;
  computeLayout(width: number, height: number, spec: unknown, data: unknown, theme: unknown): unknown;
  computeGeometry(data: unknown, spec: unknown, layout: unknown, theme: unknown): unknown;
}

// ============================================================================
// Registry
// ============================================================================

const registry = new Map<string, ChartMarkDefinition>();

/** Register (or override) a chart mark by id. Built-ins and extensions use this.
 *  REFUSES to overwrite a registered BUILT-IN mark (so an authored/sandboxed mark
 *  can never shadow "bar"/"pie"/etc. and hijack existing charts). */
export function registerChartMark(mark: string, def: ChartMarkDefinition): void {
  const existing = registry.get(mark);
  if (existing?.meta.builtin) {
    throw new Error(`Cannot override built-in chart mark "${mark}".`);
  }
  registry.set(mark, def);
}

/** Remove a registered (non-built-in) mark — e.g. when a sandboxed mark library is
 *  uninstalled/edited. No-op for an unknown id; refuses to drop a built-in. */
export function unregisterChartMark(mark: string): void {
  if (registry.get(mark)?.meta.builtin) return;
  registry.delete(mark);
}

/** Look up a registered mark's definition, or undefined. */
export function getChartMark(mark: string): ChartMarkDefinition | undefined {
  return registry.get(mark);
}

/** Look up a registered mark's metadata, or undefined. */
export function getChartMarkMeta(mark: string): ChartMarkMeta | undefined {
  return registry.get(mark)?.meta;
}

/** Whether a mark id has a registered definition. */
export function isChartMarkRegistered(mark: string): boolean {
  return registry.has(mark);
}

/** All registered mark ids, in registration order. */
export function listChartMarks(): string[] {
  return [...registry.keys()];
}

/**
 * Can a per-point override reach a datum on this mark?
 *
 * TRUE for every BUILT-IN mark (proved mark by mark by
 * `dataPointOverrideCoverage.test.ts` in the Charts extension) and for a custom
 * mark that DECLARED {@link ChartMarkMeta.honoursDataPointOverrides}. FALSE for
 * a custom mark that did not — and for an unknown id, because a mark that is
 * not registered cannot have promised anything.
 *
 * THE POINT OF ASKING. A UI that offers "format this single data point" must
 * gate on this. Offering it for a mark that ignores the payload accepts a
 * setting, writes it into the spec, dirties the document — and paints nothing.
 * That is the defect shape this predicate exists to make impossible to ship
 * again, and it is why the answer is a declaration rather than a guess.
 */
export function chartMarkHonoursDataPointOverrides(mark: string): boolean {
  const meta = registry.get(mark)?.meta;
  if (!meta) return false;
  return meta.builtin === true || meta.honoursDataPointOverrides === true;
}
