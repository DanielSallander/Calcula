/**
 * Plumbing for the live cross-filter journey (`journeys/canvas-crossfilter.spec.ts`,
 * P4 S13): Power BI cross-filter / cross-highlight on a canvas page, Canvas > Edit
 * interactions, and ribbon filters on every model visual (G2-B), against the
 * owner's AdventureWorks model.
 *
 * WHAT IS IN HERE, AND WHERE EACH ANSWER COMES FROM
 *
 *   * `selectionState` -- the page's visual selections, read from the ONE seam
 *     that holds them (`@api/reportFilters` `getCrossFilters`), through the
 *     module instance the app loaded. View state: nothing in the backend holds it.
 *   * `layoutInteractions` -- a canvas page's `interactions`, as the BACKEND
 *     holds them (`get_sheets` -> `canvasLayout.interactions`).
 *   * `designQueryOracle` -- the independent oracle every expected number comes
 *     from. The DSL is compiled by the product's own pure compiler
 *     (`compileDesignQuery`, which applies NO report filter: it never reads
 *     `@api/reportFilters`), and the request is sent to `run_design_query`
 *     DIRECTLY with the explicit `pageFilterFields` / `tupleFilters` the step
 *     names. A chart reads through the resolver; the oracle never does, so a
 *     resolver defect cannot make both agree.
 *   * `cardText` -- what a Card computed and what its painter WROTE (the
 *     `fillText` recorder of chart-paint.ts).
 *   * `pieHighlight` -- a pie slice's inner-arc and outer-band colours, sampled
 *     from the SCREEN (viewportSample.ts `samplePixels`), so "the slice shows a
 *     highlighted part" is a relative pixel fact, never a golden (R14).
 *   * point helpers -- the client point of a bar, a slice or a plot gap, from
 *     the renderer's own cached hit geometry (chart-local) and the chart's own
 *     content rect, so a point is where the product itself paints and hit-tests.
 *
 * Nothing in here asserts. It reads and it acts; the spec decides.
 */
import type { Page } from "@playwright/test";
import {
  MOD,
  bounded,
  callModule,
  installAppImport,
  invoke,
  objects,
  sheetPointToPage,
  sheetsResult,
  type AppWindow,
} from "./canvas-live";
import { cachedData, recordedTexts, type CachedData } from "./chart-paint";
import { samplePixels, type PixelClip } from "../viewportSample";
import { averageRgb } from "./object-pane";

// ---------------------------------------------------------------------------
// Module paths (the instances the app loaded)
// ---------------------------------------------------------------------------

export const XF_MOD = {
  REPORT_FILTERS: "/src/api/reportFilters/index.ts",
  MODEL_VISUALS: "/src/api/modelVisuals.ts",
  DESIGN_QUERY: "/extensions/_shared/dsl/pivotLayout/designQuery.ts",
  PIVOT_XF_VIEW: "/extensions/Pivot/lib/pivotCrossFilterView.ts",
  LOCALE: "/src/api/locale.ts",
  SLICER_CLEAR: "/src/api/slicerClearService.ts",
  FILTER_STORE: "/extensions/ControlsPane/lib/filterPaneStore.ts",
  PIVOT_API: "/extensions/Pivot/lib/pivot-api.ts",
} as const;

// ---------------------------------------------------------------------------
// Wire shapes (read-only mirrors of @api/reportFilters / tauri-api)
// ---------------------------------------------------------------------------

export interface XfVisualRef {
  kind: "chart" | "pivot" | "slicer";
  id: string;
}

/** One visual's cross-filter selection (`CrossFilterSelection`). */
export interface XfSelection {
  source: XfVisualRef;
  sourceName: string;
  pageSheetId: string;
  connectionId: string;
  fields: string[];
  tuples: string[][];
}

export interface XfPair {
  source: XfVisualRef;
  target: XfVisualRef;
  mode: "filter" | "highlight" | "none";
}

export interface XfInteractions {
  defaultMode?: "filter" | "highlight";
  pairs: XfPair[];
}

/** A member coordinate of a datum's path (`MemberCoord`). */
export interface XfMemberCoord {
  field: string;
  key: string;
}

/** What the chart renderer last computed, with the P4 identity fields. */
export interface XfChartData extends CachedData {
  categoryMembers?: XfMemberCoord[][];
  seriesMembers?: XfMemberCoord[][];
  highlightValues?: Array<Array<number | null>>;
  crossFilterSelf?: { categories: boolean[]; series?: boolean[]; datums: boolean[][] };
}

/** A page filter / tuple filter in the oracle's own terms ("Table.Column" keys). */
export interface OracleFieldFilter {
  field: string;
  keys: string[];
}

export interface OracleTupleFilter {
  fields: string[];
  tuples: string[][];
}

/** One cell of a design-query / pivot view as the backend answers it. */
export interface ViewCell {
  cellType?: string;
  value?: unknown;
  formattedValue?: string;
  member?: { key: string; label: string };
}

export interface ViewRow {
  rowType?: string;
  cells?: ViewCell[];
}

export interface DesignQueryView {
  rows?: ViewRow[];
  groupMembers?: Array<{ fieldIndex: number; fieldKey: string; members: Array<[number, string]> }>;
}

// ---------------------------------------------------------------------------
// Field keys
// ---------------------------------------------------------------------------

/**
 * "BI.dim_territory.territorygroup" -> { table: "BI.dim_territory", column:
 * "territorygroup" }. The owner's tables are schema-qualified (they carry a
 * dot); no column of the model does, so the LAST dot is the split.
 */
export function fieldRef(key: string): { table: string; column: string } {
  const at = key.lastIndexOf(".");
  if (at <= 0) throw new Error(`fieldRef: "${key}" is not a Table.Column key`);
  return { table: key.slice(0, at), column: key.slice(at + 1) };
}

// ---------------------------------------------------------------------------
// The selection seam and the interactions
// ---------------------------------------------------------------------------

/** Every visual selection the seam holds now (all pages), in the seam's own order. */
export async function selectionState(page: Page): Promise<XfSelection[]> {
  const raw = await callModule<XfSelection[]>(page, XF_MOD.REPORT_FILTERS, "getCrossFilters", []);
  return (raw ?? []).map((s) => ({
    source: { kind: s.source.kind, id: s.source.id },
    sourceName: s.sourceName,
    pageSheetId: s.pageSheetId,
    connectionId: s.connectionId,
    fields: [...s.fields],
    tuples: s.tuples.map((t) => [...t]),
  }));
}

/** Clear every selection through the seam (a set-up step between phases, never the thing under test). */
export async function clearAllSelections(page: Page): Promise<void> {
  await callModule(page, XF_MOD.REPORT_FILTERS, "clearCrossFilters", []);
  await page.waitForTimeout(250);
}

/** The interactions of canvas `sheetIndex` as the BACKEND holds them (null when the sheet has none). */
export async function layoutInteractions(page: Page, sheetIndex: number): Promise<XfInteractions | null> {
  const res = await sheetsResult(page);
  const sheet = res.sheets.find((s) => s.index === sheetIndex);
  const i = (sheet?.canvasLayout as { interactions?: XfInteractions } | undefined)?.interactions;
  if (!i) return null;
  return { ...(i.defaultMode ? { defaultMode: i.defaultMode } : {}), pairs: (i.pairs ?? []).map((p) => ({ source: { ...p.source }, target: { ...p.target }, mode: p.mode })) };
}

/** `kind:id -> kind:id = mode`, sorted: a comparable spelling of a pair list. */
export function pairKeys(i: XfInteractions | null): string[] {
  return (i?.pairs ?? []).map((p) => `${p.source.kind}:${p.source.id} -> ${p.target.kind}:${p.target.id} = ${p.mode}`).sort();
}

// ---------------------------------------------------------------------------
// The oracle
// ---------------------------------------------------------------------------

const modelCache = new Map<string, unknown>();

/** Forget the cached model of a connection (a reopen may re-create it under a new id). */
export function forgetOracleModels(): void {
  modelCache.clear();
}

/** A backend call that may take long (a query against Postgres). */
async function invokeLong<T>(page: Page, cmd: string, args: unknown, ms = 180_000): Promise<T> {
  return bounded(
    `invoke ${cmd}`,
    page.evaluate(async ({ c, a }) => (window as unknown as AppWindow).__TAURI__.core.invoke(c, a), { c: cmd, a: args }) as Promise<T>,
    ms,
  );
}

/**
 * The model's own answer to `dsl` under EXPLICIT page filters and tuple
 * filters, from `run_design_query` invoked directly (never through a chart,
 * never through `@api/reportFilters`). Returns the raw view.
 */
export async function designQueryOracle(
  page: Page,
  connectionId: string,
  dsl: string,
  pageFilterFields: OracleFieldFilter[] = [],
  tupleFilters: OracleTupleFilter[] = [],
): Promise<DesignQueryView> {
  await installAppImport(page);
  if (!modelCache.has(connectionId)) {
    modelCache.set(connectionId, await invokeLong(page, "get_connection_bi_model", { connectionId }, 120_000));
  }
  const biModel = modelCache.get(connectionId);
  const compiled = await bounded(
    "compileDesignQuery",
    page.evaluate(
      async ({ mod, dsl, connectionId, biModel }) => {
        const m = (await (window as unknown as AppWindow).__appImport!(mod)) as {
          compileDesignQuery: (t: string, c: string, b: unknown) => { request: Record<string, unknown> | null; errors: unknown[] };
        };
        return m.compileDesignQuery(dsl, connectionId, biModel);
      },
      { mod: XF_MOD.DESIGN_QUERY, dsl, connectionId, biModel },
    ),
  );
  if (!compiled.request) throw new Error(`the oracle's DSL does not compile: ${dsl} (${JSON.stringify(compiled.errors).slice(0, 400)})`);
  const request = {
    ...compiled.request,
    pageFilterFields: pageFilterFields.map((f) => ({ ...fieldRef(f.field), includedItems: [...f.keys] })),
    tupleFilters: tupleFilters.map((t) => ({ fields: t.fields.map(fieldRef), tuples: t.tuples.map((x) => [...x]) })),
  };
  return invokeLong<DesignQueryView>(page, "run_design_query", { request });
}

/** The same oracle, answering `{ error }` instead of throwing (a refusal under test). */
export async function designQueryOracleOutcome(
  page: Page,
  connectionId: string,
  dsl: string,
  pageFilterFields: OracleFieldFilter[] = [],
  tupleFilters: OracleTupleFilter[] = [],
): Promise<{ view: DesignQueryView } | { error: string }> {
  try {
    return { view: await designQueryOracle(page, connectionId, dsl, pageFilterFields, tupleFilters) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** The one value of a measure-only view (its grand total, else its one data cell). */
export function measureOf(view: DesignQueryView): number {
  const rows = view.rows ?? [];
  const of = (type: string): number[] =>
    rows.flatMap((r) => (r.cells ?? []).filter((c) => c.cellType === type && typeof c.value === "number").map((c) => c.value as number));
  const grand = of("GrandTotal");
  if (grand.length > 0) return grand[grand.length - 1];
  const data = of("Data");
  if (data.length > 0) return data[0];
  throw new Error(`the view carries no measure value: ${JSON.stringify(view).slice(0, 600)}`);
}

/** A grand total, or NaN when the view has none (a pivot box's real / filtered view). */
export function grandTotalOf(view: DesignQueryView | null | undefined): number {
  if (!view) return Number.NaN;
  try {
    return measureOf(view);
  } catch {
    return Number.NaN;
  }
}

/**
 * Member KEY -> value of a one-ROWS-field, one-measure view: each data row's
 * row header (its `member.key` when the backend sends one, else its text) and
 * the first numeric Data cell after it. A member the view does not have is
 * absent from the map (the caller reads it as 0).
 */
export function valuesByMember(view: DesignQueryView, opts: { byLabel?: boolean } = {}): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of view.rows ?? []) {
    const cells = row.cells ?? [];
    const header = cells.find((c) => c.cellType === "RowHeader");
    if (!header) continue;
    const key = header.member?.key ?? (header.formattedValue && header.formattedValue !== "" ? header.formattedValue : String(header.value ?? ""));
    const data = cells.find((c) => c.cellType === "Data" && typeof c.value === "number");
    if (!data) continue;
    // By KEY -- the blank member's key is "" (ruling Q8) and is kept -- and,
    // with `byLabel`, also by its LABEL ("(Blank)"), the name a chart's category
    // axis carries, so a caller indexing by a painted category finds the member.
    if (header.member) {
      out[header.member.key] = data.value as number;
      if (opts.byLabel && header.member.label !== header.member.key) out[header.member.label] = data.value as number;
    } else if (key !== "") {
      out[key] = data.value as number;
    }
  }
  return out;
}

/** The member keys `run_design_query` sent in `groupMembers` for one field. */
export function groupMemberKeys(view: DesignQueryView, fieldKey: string): string[] {
  const g = (view.groupMembers ?? []).find((m) => m.fieldKey === fieldKey);
  return (g?.members ?? []).map(([, key]) => key);
}

/** Equal within float noise (a sum of two engine answers against one). */
export function near(actual: number, expected: number): boolean {
  return Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) <= 0.01 + 1e-9 * Math.abs(expected);
}

// ---------------------------------------------------------------------------
// Charts: data, card text, geometry
// ---------------------------------------------------------------------------

/** The renderer's cached data of a chart, with the identity fields S5 added. */
export async function chartCache(page: Page, chartId: string): Promise<XfChartData | null> {
  return (await cachedData(page, chartId)) as XfChartData | null;
}

/** The sum of a chart's first series (a one-measure chart's total). */
export function seriesTotal(d: XfChartData | null): number {
  if (!d || d.series.length === 0) return Number.NaN;
  return d.series[0].values.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
}

/** Read text with the APP locale's own parser (`@api/locale` parseNumber). */
export async function parseAppNumber(page: Page, text: string): Promise<number | null> {
  return callModule<number | null>(page, XF_MOD.LOCALE, "parseNumber", [text]);
}

/**
 * What a Card shows: the value the renderer computed, the display string it
 * formatted, and whether the painter WROTE that string since the recorder last
 * started (chart-paint.ts `startTextRecorder` must be running).
 */
export async function cardText(page: Page, chartId: string): Promise<{ value: number; display: string | null; painted: boolean }> {
  const d = await chartCache(page, chartId);
  const value = d?.series[0]?.values[0] ?? Number.NaN;
  const texts = await recordedTexts(page);
  const display = d?.displayValues?.[0]?.[0] ?? null;
  if (display !== null) return { value, display, painted: texts.includes(display) };
  // A DESIGN-QUERY Card has no source text (`displayValues` exists only for a
  // card over cells, chartDataReader.ts): the painter formats the number itself.
  // Its display is then the most recent recorded text that the APP locale's own
  // parser reads as the card's value (a "#,##0" card is within 0.5 of it). The
  // value is the renderer's, never the oracle, so a wrong value cannot pick a
  // matching text.
  if (!Number.isFinite(value)) return { value, display: null, painted: false };
  const candidates = [...new Set(texts.filter((t) => /\d/.test(t)).reverse())].slice(0, 400);
  await installAppImport(page);
  const values = await page.evaluate(
    async ({ list, mod }) => {
      const m = (await (window as unknown as AppWindow).__appImport!(mod)) as { parseNumber: (t: string) => number | null };
      return list.map((t) => m.parseNumber(t));
    },
    { list: candidates, mod: XF_MOD.LOCALE },
  );
  const tol = 0.5 + 1e-9 * Math.abs(value);
  const i = values.findIndex((v) => v !== null && Math.abs(v - value) <= tol);
  return i < 0 ? { value, display: null, painted: false } : { value, display: candidates[i], painted: true };
}

/** Raw hit geometry + plot area of a chart (chart-local, logical px). */
export interface XfGeometry {
  type: string;
  rects?: Array<{ seriesIndex: number; categoryIndex: number; x: number; y: number; width: number; height: number; categoryName: string; seriesName: string }>;
  arcs?: Array<{ seriesIndex: number; startAngle: number; endAngle: number; innerRadius: number; outerRadius: number; centerX: number; centerY: number; label: string }>;
  plotArea: { x: number; y: number; width: number; height: number } | null;
}

export async function hitGeometryOf(page: Page, chartId: string): Promise<XfGeometry | null> {
  await installAppImport(page);
  return page.evaluate(
    async ({ id, mod }) => {
      const m = (await (window as unknown as AppWindow).__appImport!(mod)) as {
        getCachedChartData: (id: string) => {
          hitGeometry?: { type: string; rects?: unknown[]; arcs?: unknown[] };
          layout?: { plotArea?: { x: number; y: number; width: number; height: number } };
        } | null;
      };
      const d = m.getCachedChartData(id);
      if (!d?.hitGeometry) return null;
      return {
        type: d.hitGeometry.type,
        rects: d.hitGeometry.rects as never,
        arcs: d.hitGeometry.arcs as never,
        plotArea: d.layout?.plotArea ? { ...d.layout.plotArea } : null,
      };
    },
    { id: chartId, mod: MOD.CHART_RENDERER },
  );
}

/** The client point of a chart-local point (the chart's CONTENT rect is the origin of its geometry). */
export async function chartLocalToPage(page: Page, chartId: string, lx: number, ly: number): Promise<{ x: number; y: number }> {
  const content = await callModule<{ x: number; y: number; width: number; height: number } | null>(page, MOD.CHART_RENDERER, "chartContentRect", [chartId]);
  if (!content) throw new Error(`chart ${chartId} has no content rect`);
  return sheetPointToPage(page, content.x + lx, content.y + ly);
}

/** The client point at the centre of the bar of (category, series) -- by NAME, as the painter labels it. */
export async function barPoint(page: Page, chartId: string, categoryName: string, seriesName?: string): Promise<{ x: number; y: number }> {
  const g = await hitGeometryOf(page, chartId);
  if (g?.type !== "bars") throw new Error(`chart ${chartId} is not drawing bars (${g?.type ?? "no geometry"})`);
  const r = (g.rects ?? []).find((b) => b.categoryName === categoryName && (seriesName === undefined || b.seriesName === seriesName));
  if (!r) {
    const seen = (g.rects ?? []).map((b) => `${b.categoryName}/${b.seriesName}`).join(", ");
    throw new Error(`chart ${chartId} draws no bar ${categoryName}${seriesName ? `/${seriesName}` : ""} (bars: ${seen})`);
  }
  return chartLocalToPage(page, chartId, r.x + r.width / 2, r.y + r.height / 2);
}

/** The client point at the centre of the bar at (categoryIndex, seriesIndex). */
export async function barPointAt(page: Page, chartId: string, categoryIndex: number, seriesIndex = 0): Promise<{ x: number; y: number }> {
  const g = await hitGeometryOf(page, chartId);
  if (g?.type !== "bars") throw new Error(`chart ${chartId} is not drawing bars (${g?.type ?? "no geometry"})`);
  const r = (g.rects ?? []).find((b) => b.categoryIndex === categoryIndex && b.seriesIndex === seriesIndex);
  if (!r) throw new Error(`chart ${chartId} draws no bar at category ${categoryIndex}, series ${seriesIndex}`);
  return chartLocalToPage(page, chartId, r.x + r.width / 2, r.y + r.height / 2);
}

/**
 * A client point of the PLOT background between the first two bars, near the
 * top of the plot (above every bar but the tallest is NOT assumed: the point is
 * the horizontal middle of the gap, so no bar covers it at any height).
 */
export async function plotGapPoint(page: Page, chartId: string): Promise<{ x: number; y: number }> {
  const g = await hitGeometryOf(page, chartId);
  if (g?.type !== "bars" || !g.plotArea) throw new Error(`chart ${chartId} has no bar plot`);
  const bars = [...(g.rects ?? [])].sort((a, b) => a.x - b.x);
  if (bars.length < 2) throw new Error(`chart ${chartId} draws fewer than two bars`);
  const gapLeft = bars[0].x + bars[0].width;
  const next = bars.find((b) => b.x > gapLeft + 2);
  if (!next) throw new Error(`chart ${chartId} has no gap between its bars`);
  const x = (gapLeft + next.x) / 2;
  const y = g.plotArea.y + Math.min(12, g.plotArea.height / 4);
  return chartLocalToPage(page, chartId, x, y);
}

/** A small square clip (CSS px) around a client point. */
export function patchAt(at: { x: number; y: number }, half = 3): PixelClip {
  return { x: at.x - half, y: at.y - half, width: half * 2, height: half * 2 };
}

/**
 * A pie's widest slice, sampled on screen: the average colour of a patch on
 * its mid-angle near the centre (where the highlighted INNER arc paints) and
 * one near the rim (the faded outer band). Without a highlight both are the
 * slice's one colour; with one they differ.
 */
export async function pieHighlight(
  page: Page,
  chartId: string,
): Promise<{ label: string; inner: [number, number, number]; outer: [number, number, number] }> {
  const g = await hitGeometryOf(page, chartId);
  if (g?.type !== "slices" || !g.arcs || g.arcs.length === 0) throw new Error(`chart ${chartId} is not drawing slices (${g?.type ?? "no geometry"})`);
  const arc = g.arcs.reduce((a, b) => (b.endAngle - b.startAngle > a.endAngle - a.startAngle ? b : a));
  const mid = (arc.startAngle + arc.endAngle) / 2;
  const span = arc.outerRadius - arc.innerRadius;
  const at = (r: number) => ({ x: arc.centerX + Math.cos(mid) * r, y: arc.centerY + Math.sin(mid) * r });
  const innerLocal = at(arc.innerRadius + span * 0.18);
  const outerLocal = at(arc.innerRadius + span * 0.9);
  const innerPt = await chartLocalToPage(page, chartId, innerLocal.x, innerLocal.y);
  const outerPt = await chartLocalToPage(page, chartId, outerLocal.x, outerLocal.y);
  const inner = averageRgb(await samplePixels(page, patchAt(innerPt, 2)));
  const outer = averageRgb(await samplePixels(page, patchAt(outerPt, 2)));
  return { label: arc.label, inner, outer };
}

/** Sum of absolute channel differences between two average colours. */
export function rgbDistance(a: [number, number, number], b: [number, number, number]): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}

// ---------------------------------------------------------------------------
// Pointer and regions
// ---------------------------------------------------------------------------

/**
 * Move the real mouse onto `p` and read the cursor the USER SEES there (the
 * computed cursor of the element under the pointer: an inline cursor on the
 * canvas child beats Core's answer on the grid area, so reading the element is
 * the honest read -- moving-objects.spec.ts `cursorAt`).
 */
export async function cursorAt(page: Page, p: { x: number; y: number }): Promise<string> {
  await page.mouse.move(p.x - 3, p.y - 3);
  await page.mouse.move(p.x, p.y, { steps: 3 });
  await page.waitForTimeout(300);
  return page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    if (!el) return "<nothing under the pointer>";
    return getComputedStyle(el).cursor;
  }, p);
}

/** The id of the published region of a canvas object (`chart:<id>`, `pivot:<id>`, `slicer:<id>`). */
export async function regionIdOf(page: Page, ref: XfVisualRef): Promise<string> {
  const all = await objects(page);
  const o = all.find((x) => x.refKey === `${ref.kind}:${ref.id}`);
  if (!o) throw new Error(`no region is published for ${ref.kind}:${ref.id} (published: ${all.map((x) => x.refKey).join(", ")})`);
  return o.id;
}

/**
 * Select ONE object through Core's selection seam (`@api/objectSelection`
 * `selectObject`, the provider-routed act a press on its frame makes) -- used
 * where a press on the object's body would ACT (a slicer item, a source bar).
 */
export async function selectObjectByRef(page: Page, ref: XfVisualRef): Promise<void> {
  await installAppImport(page);
  const ok = await page.evaluate(
    async ({ ov, os, key }) => {
      const w = window as unknown as AppWindow;
      const g = (await w.__appImport!(ov)) as { getGridRegions: () => unknown[] };
      const s = (await w.__appImport!(os)) as {
        selectableFloatingRegions: (r?: unknown) => unknown[];
        objectRefOf: (r: unknown) => { kind: string; id: string } | null;
        selectObject: (r: unknown) => boolean;
      };
      const region = s.selectableFloatingRegions(g.getGridRegions()).find((r) => {
        const ref = s.objectRefOf(r);
        return !!ref && `${ref.kind}:${ref.id}` === key;
      });
      return region ? s.selectObject(region) : false;
    },
    { ov: MOD.GRID_OVERLAYS, os: MOD.OBJ_SEL, key: `${ref.kind}:${ref.id}` },
  );
  if (!ok) throw new Error(`selecting ${ref.kind}:${ref.id} through the object-selection seam was refused`);
  await page.waitForTimeout(250);
}

// ---------------------------------------------------------------------------
// Pivot boxes under a selection
// ---------------------------------------------------------------------------

/** The filtered view a box paints now (undefined when none applies). */
export async function filteredPivotView(page: Page, pivotId: string): Promise<DesignQueryView | null> {
  return (await callModule<DesignQueryView | undefined>(page, XF_MOD.PIVOT_XF_VIEW, "getFilteredPivotView", [pivotId])) ?? null;
}

/** The badge a box paints ("Filtered by ..." / "Not filtered by ...: reason"), or null. */
export async function pivotBadge(page: Page, pivotId: string): Promise<{ kind: string; text: string } | null> {
  return callModule<{ kind: string; text: string } | null>(page, XF_MOD.PIVOT_XF_VIEW, "getPivotCrossFilterBadge", [pivotId]);
}

/** A field's hidden items in a pivot's STORED definition (the canvas holding it must be active). */
export async function pivotHiddenItems(page: Page, pivotId: string, column: string): Promise<string[]> {
  const cfg = await callModule<{
    rowFields: Array<{ name: string; hiddenItems?: string[] }>;
    columnFields: Array<{ name: string; hiddenItems?: string[] }>;
    filterFields: Array<{ name: string; hiddenItems?: string[] }>;
  } | null>(page, XF_MOD.PIVOT_API, "getPivotFieldConfiguration", [pivotId]);
  if (!cfg) throw new Error(`the active sheet shows no pivot ${pivotId}`);
  const all = [...cfg.rowFields, ...cfg.columnFields, ...cfg.filterFields];
  return all.filter((f) => f.name === column || f.name.endsWith(`.${column}`)).flatMap((f) => f.hiddenItems ?? []);
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

/** The title-bar asterisk as the USER sees it (census-followon.spec.ts). */
export async function titleShowsDirty(page: Page): Promise<boolean> {
  return page.evaluate(() => / \* - Calcula$/.test(document.title));
}

/** The whole undo state as a comparable string. */
export async function undoSignature(page: Page): Promise<string> {
  return JSON.stringify(await invoke(page, "get_undo_state"));
}
