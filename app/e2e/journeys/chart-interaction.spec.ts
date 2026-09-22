/**
 * CHART INTERACTION (CI-16) — the owner's own two sentences, proved LIVE.
 *
 *   "I cannot double click the chart title and edit it, as I can do in Excel.
 *    Same with x and y axis labels. ... I cannot select a single data point, a
 *    bar for example, and change the color of only this bar."
 *
 * Four waves of work answered those two sentences and every one of them was
 * verified in jsdom. jsdom cannot see a canvas hit-test, cannot see a DOM editor
 * positioned over a canvas, and has no double-click. So the four waves are
 * verified against a model of the app rather than against the app.
 *
 * THE PRECEDENT THIS FILE COPIES, deliberately and in detail, is
 * `insight-overlays.spec.ts`. That journey originally selected cues
 * PROGRAMMATICALLY and its only chart mouse events were right-clicks — and TWO
 * defects shipped green underneath it, both of them about what a real LEFT click
 * does. It now locates real clicks from the renderer's OWN hit geometry, so a
 * click lands where a bar is actually painted rather than where the test thinks
 * one ought to be. Everything below does the same: every gesture here is a real
 * mouse or keyboard event at a coordinate the renderer computed.
 *
 * EVERY "IT WORKED" HAS A POSITIVE CONTROL AND, WHERE IT CAN, A NEGATIVE ONE.
 * A title edit is asserted three ways — the RAW spec, the MEASURED glyph rect,
 * and the PIXELS — because each one alone has a way of being true while the
 * product is broken: the spec can be right while nothing repaints, the rect can
 * move because the chart moved, and pixels can change because a selection
 * border was drawn.
 *
 * THE DATA AREA is AH1:AI7 (cols 33-34) plus AK1 as the title-link cell.
 * Nothing else in the tree writes there — `insight-overlays` owns Z:AA, the
 * walker owns its own block — so a shared workbook cannot make this file's
 * numbers someone else's.
 *
 * EACH TEST CREATES AND DELETES ITS OWN CHART. The journey project shares one
 * app instance and one accumulating workbook; a chart left behind would sit
 * under the next test's clicks.
 *
 * ===========================================================================
 * WHAT THIS FILE FOUND ON ITS FIRST RUNS (2026-09-21), AND WHY IT IS RED
 * ===========================================================================
 * Four of the seven journeys pass. The other three were RED AGAINST THE
 * PRODUCT, not against the test: each one is reduced to a single assertion with
 * a measurement printed beside it, so the failure names the defect rather than
 * describing a symptom.
 *
 * STATUS, 2026-09-21 (later the same day): defects 1 and 2 below have been
 * FIXED AT THE SOURCE and are covered at the unit tier
 * (`components/__tests__/datumWriteAddress.test.ts` for the address,
 * `handlers/__tests__/chartPlotAreaDelete.test.ts` for the Delete claim). The
 * descriptions are kept verbatim because they are the diagnosis; this file is
 * the LIVE re-proof and has not been re-run since. Defect 3 (the preview paint
 * latency) is untouched.
 *
 *  1. A PIE SLICE accepts a per-point colour that the painter never applies.
 *     The pane writes the override at (sliceIndex, sliceIndex) because the
 *     radial hit test reports `seriesIndex === pointIndex === the CATEGORY`,
 *     while `pieChartPainter` resolves every slice at (0, categoryIndex). Slice
 *     0 works by coincidence; nothing else does — and the pane keeps SHOWING
 *     the colour, because it reads the override back at the same wrong address.
 *
 *  2. DELETE NEVER REACHES THE CHART, AND CLEARS THE USER'S CELLS. The
 *     keybinding registry binds Delete to `core.edit.clearContents` on a
 *     WINDOW capture-phase listener that calls stopPropagation on a match
 *     (`app/src/api/keybindings.ts`), and the Charts Delete listener is a
 *     DOCUMENT capture-phase listener — strictly later. With a chart title
 *     selected and the grid focused, Delete cleared the sentinel in A1 and left
 *     the title standing. Every branch of Wave E1's Delete work (the title
 *     clear, the legend-entry hide, the two-area no-op, the chart destroy) sits
 *     behind a listener the key never reaches.
 *
 *  3. THE LIVE COLOUR PREVIEW IS ARMED AND NEVER PAINTED. Re-measured on
 *     2026-09-22 across four consecutive runs, and the earlier description of
 *     it as "a race" was an artefact of WHEN the store was read. The sequence
 *     is the same every time:
 *
 *       * the hover arms it — read 400 ms after the gesture,
 *         `paneIsPreviewing=true` and the store holds
 *         `{seriesIndex:0, categoryIndex:3, key:"UnitsApr",
 *         color:"#636363"}`, with the right colour AND the right identity key;
 *       * the chart NEVER repaints — every sample over a three-second poll
 *         returns a pixel diff of exactly 0, with the pointer never leaving
 *         the swatch;
 *       * and by the end of that poll the preview has ended on its own:
 *         `paneIsPreviewing=false`, the override gone from the store, without
 *         a click or a pointer move.
 *
 *     The old ordering read the store only AFTER the poll, so it saw the third
 *     state and reported "the hover handler never ran" — a different defect
 *     with the same symptom. Both readings are now taken and printed. The
 *     COMMIT half is unaffected and still passes end to end (one undo entry,
 *     "Edit chart", the colour on screen, one undo takes it back), which is why
 *     neither the unit tier nor a click-through ever saw this.
 *
 *     THE HARNESS IS NOT THE EXPLANATION, and that was checked rather than
 *     assumed: a raw `page.mouse.move`, the same move with `steps: 8`, and
 *     `locator.hover()` all arm the preview identically. The raw move is kept
 *     as a printed probe above the gesture for exactly that reason.
 *
 * A fourth thing is measured and reported without being the subject of its own
 * journey: after a Format-pane button takes focus, a real left click on the
 * chart moves the selection ladder (proved by clicking a DIFFERENT bar and
 * watching the rung follow) but does NOT return DOM focus to the grid, so
 * Escape and the element walk stay dead until the reader clicks a cell.
 *
 * ===========================================================================
 * WHAT THE SIXTH WAVE ADDED HERE (2026-09-22), AND WHAT EACH CASE PROVES
 * ===========================================================================
 * Journeys 1-8 above are the owner's original two sentences. Journeys 9-16
 * are the two defects he found when he TESTED it, plus the furniture that
 * became selectable in the same run.
 *
 *  9. OB-1 — "when I select an individual data point and give it a color I
 *     cannot select a color for the entire series after that". The colour of a
 *     series had TWO spellings and the Format pane wrote the losing one. The
 *     journey seeds the state he was in (a name-keyed `seriesColors` already
 *     present), colours one bar, then colours the SERIES, and asserts both
 *     halves of Excel's precedence in PIXELS: every other bar follows the
 *     series, the coloured bar keeps its own. Reset to Match Style on that bar
 *     rejoins it — asserted as a COLOUR IDENTITY against its neighbour, not as
 *     "it changed", because a diff against its own past would pass for a bar
 *     that went some third colour.
 *
 * 10 + 11. OB-2 — the data table painted over the x tick labels and the axis
 *     title. The decisive proof is a PIXEL IDENTITY rather than a rect
 *     comparison: with a table shown on a category-X mark the labels belong to
 *     the table alone, so flipping `xAxis.showLabels` must change nothing at
 *     all, and it changed six large labels under the defect. The layout is
 *     identical in both states, so there is no second explanation for a
 *     difference. Its positive control is the same toggle with no table. 11 is
 *     the horizontal-bar case, where the x labels are VALUES the table does not
 *     repeat, so the band keeps all three occupants stacked in order.
 *
 * 12-15. The in-plot furniture — trendline, a series' error bars, one data
 *     label, the data table — each SELECTED by a real click, watched to
 *     RETARGET the pane, FORMATTED, and DELETED, with the chart's survival and
 *     the cells' survival asserted after every Delete. Gridlines are asserted
 *     to be REFUSED: a click where they are drawn selects the plot area, which
 *     is what "no producer, so no element id" means to a reader.
 *
 * 16. A DEFAULT AREA CHART's one formatted datum. An area series is one
 *     polygon and `showMarkers` defaults to false, so the pane used to accept a
 *     colour that could never appear. The negative control is the half that
 *     keeps a default area chart looking like one: a datum with no override
 *     still gets no marker.
 *
 * THREE THINGS THESE CASES FOUND IN THE PRODUCT ON THE WAY IN, each of which
 * is now a guard rather than a paragraph, because each one first appeared as a
 * test that looked broken:
 *
 *   * AN ERROR BAR WHOSE EXTENT RUNS OFF THE TOP OF THE SCALE records a rect
 *     with a NEGATIVE y. The painter clips, the rect does not, and a click
 *     aimed at it lands ABOVE the chart — which is a click on the GRID, which
 *     DESELECTS the chart. The ladder came back `{ level: "none" }`, reading
 *     exactly like "error bars are not selectable".
 *   * A DATA LABEL ON A BAR THAT REACHES THE TOP OF THE SCALE is clamped by
 *     `drawBarLabels` to `plotArea.y + fontSize`, which puts it INSIDE its own
 *     bar — where a datum beats furniture and the label cannot be clicked at
 *     all. Excel's own labels never go inside an "above" placement.
 *   * THE CHART CONTEXT MENU CAN OPEN OFF THE BOTTOM OF THE WINDOW. Its clamp
 *     uses `estimatedHeight = 40 + (rows + 1) * 26`; over a DATA TABLE at the
 *     default placement in a 1280x800 window the estimate came up short and
 *     the menu's last row — always "Format <element>..." — rendered below the
 *     viewport, visible and unclickable. The data-table journey now asserts the
 *     menu fits and prints its geometry.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";
// THE SAMPLER AND THE COMPARISON ARE SHARED, AND THE CAPTURE IS NEVER CLIPPED.
//
// `samplePixels` photographs the WHOLE viewport and crops afterwards, inside
// the page. This file is the one that paid for that: it measures a LIVE HOVER
// (the Format pane's colour preview, test 8 below), and for four consecutive
// runs it reported "the preview never paints" while the product was painting it
// in ~85 ms every time. Read `../viewportSample.ts` before changing anything
// here — its header carries BOTH the measured reproduction that indicted the
// clipped capture AND the re-probe, the same day on the same machine, that
// could not reproduce the cancelled hover and found a ~130 ms timing gap
// instead. Either way the unclipped path is the one that has run 15/15 twice on
// the surface that failed; the local wrapper this file used to carry is gone,
// and `pixels` is now just that shared sampler under this file's own name.
//
// `diffCount` comes from the same module. It used to live here as a tenth
// private copy of the identical twenty lines — the same one-fact-many-spellings
// shape as the product defects this wave fixed.
import { diffCount, samplePixels as pixels, type PixelClip } from "../viewportSample";
import * as os from "os";
import * as path from "path";

/* eslint-disable @typescript-eslint/naming-convention */
type AppWindow = Window & {
  __calcImport: (url: string) => Promise<unknown>;
  __appImport?: (modulePath: string) => Promise<unknown>;
  __TAURI__: { core: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } };
  __CALCULA_CHARTS__?: {
    getAllCharts: () => Array<{ chartId: string }>;
    getChartById: (id: string) => unknown;
    selectChart: (id: string) => void;
    deselectChart?: () => void;
    deleteChart?: (id: string) => boolean;
    getCurrentChartId: () => string | null;
  };
};
/* eslint-enable @typescript-eslint/naming-convention */

// Module paths, resolved through the dev server's own resource list.
const SELECTION_HANDLER = "/extensions/Charts/handlers/selectionHandler.ts";
const CHART_STORE = "/extensions/Charts/lib/chartStore.ts";
const CHART_RENDERER = "/extensions/Charts/rendering/chartRenderer.ts";
const GRID_OVERLAYS = "/src/api/gridOverlays.ts";
const GRID_MODULE = "/src/api/grid.ts";
const KEYBINDINGS = "/src/api/keybindings.ts";
const FORMAT_PANE = "/extensions/Charts/components/ChartFormatPane.tsx";

/** The seeded series. Six categories, all different heights, none of them zero. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun"];
const UNITS = [10, 40, 25, 60, 35, 50];
const CAT_COL = "AH"; // column index 33
const VAL_COL = "AI"; // column index 34
const CAT_COL_INDEX = 33;
const VAL_COL_INDEX = 34;
/** The cell a cell-linked title points at. Outside the plotted range on purpose. */
const LINK_CELL = "AK1";
const LINK_ROW = 0;
const LINK_COL = 36;

/** Where the file is saved to get a CLEAN baseline for the dirty-flag probe. */
const CLEAN_BASELINE_FILE = path.join(os.tmpdir(), "calcula-chart-interaction.cala");

// ---------------------------------------------------------------------------
// Plumbing — the same traps and the same answers as insight-overlays.spec.ts
// ---------------------------------------------------------------------------

async function installAppImport(page: Page): Promise<void> {
  // Printed once per test so the log says what the pixel assertions were taken
  // under. Nothing here DEPENDS on either number (see `settleGrid`), but a run
  // that cannot name its own display is the defect this programme keeps
  // deleting.
  const env = await page.evaluate(() => ({
    dpr: window.devicePixelRatio,
    inner: `${window.innerWidth}x${window.innerHeight}`,
  }));
  console.log(`[chart-interaction] devicePixelRatio=${env.dpr} window=${env.inner}`);
  await page.evaluate(() => {
    const w = window as unknown as AppWindow;
    if (w.__appImport) return;
    w.__appImport = async (modulePath: string) => {
      const entries = performance
        .getEntriesByType("resource")
        .map((e) => e.name)
        .filter((n) => {
          try {
            return new URL(n).pathname === modulePath;
          } catch {
            return false;
          }
        });
      entries.sort();
      const url = entries.length > 0 ? entries[entries.length - 1] : new URL(modulePath, document.baseURI).href;
      return w.__calcImport(url);
    };
  });
}

/** Invoke a backend command through the e2e-enabled `window.__TAURI__` bridge. */
async function invoke<T = unknown>(page: Page, cmd: string, args: unknown = {}): Promise<T> {
  return page.evaluate(
    async ({ c, a }) => {
      const w = window as unknown as AppWindow;
      return w.__TAURI__.core.invoke(c, a);
    },
    { c: cmd, a: args },
  ) as Promise<T>;
}

/**
 * A rectangle in CSS pixels — the sampler's own input type, not a copy of it.
 *
 * This was a private `interface Clip` with the same four fields. Aliasing the
 * real one means a geometry helper here and the sampler it feeds can never
 * disagree about the shape without the compiler saying so.
 */
type Clip = PixelClip;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The parts of a chart spec this journey READS.
 *
 * Deliberately a narrow, named shape rather than `any`: every field here is one
 * this file asserts on, so a rename in `ChartSpec` that this journey cares about
 * shows up as a compile error instead of as `undefined !== "Quarterly Revenue"`.
 * The index signature carries the rest of the spec without claiming to know it.
 */
interface ReadableSpec {
  title?: string | null;
  xAxis?: { title?: string | null } | null;
  yAxis?: { title?: string | null } | null;
  dataPointOverrides?: Array<{
    seriesIndex?: number;
    categoryIndex?: number;
    color?: string;
    markerFill?: string;
    key?: string;
  }>;
  [field: string]: unknown;
}

/** The hit geometry as this journey reads it — one shape for all three marks. */
interface HitGeometryView {
  type: "bars" | "points" | "slices" | "composite";
  rects?: Array<{ seriesIndex: number; categoryIndex: number; x: number; y: number; width: number; height: number }>;
  markers?: Array<{ seriesIndex: number; categoryIndex: number; cx: number; cy: number }>;
  arcs?: Array<{
    seriesIndex: number;
    startAngle: number;
    endAngle: number;
    innerRadius: number;
    outerRadius: number;
    centerX: number;
    centerY: number;
  }>;
}

/**
 * The chart's client box, computed the way the renderer places its region.
 *
 * ALSO ASSERTS ZOOM IS 1. Every chart-local rect below (`layout.elements`, the
 * hit geometry) is in LOGICAL chart px, and this box converts by adding them to
 * a page origin. That arithmetic is only right at zoom 1, and a run at some
 * other zoom would miss every target and read as "the hit test is broken".
 */
async function chartClientBox(page: Page, chartId: string): Promise<Clip> {
  const box = await page.evaluate(
    async ({ chartId, overlays, grid }) => {
      const w = window as unknown as AppWindow;
      const ov = (await w.__appImport!(overlays)) as {
        getGridRegions: () => Array<{
          type: string;
          data?: Record<string, unknown>;
          floating?: { x: number; y: number; width: number; height: number };
        }>;
      };
      const gm = (await w.__appImport!(grid)) as {
        getGridStateSnapshot: () => { config: Record<string, number>; viewport: { scrollX: number; scrollY: number }; zoom: number } | null;
        rowHeaderGutter: (c: Record<string, number>) => number;
        colHeaderGutter: (c: Record<string, number>) => number;
      };
      const region = ov.getGridRegions().find((r) => r.type === "chart" && r.data?.chartId === chartId);
      if (!region?.floating) return null;
      const state = gm.getGridStateSnapshot();
      if (!state) return null;
      const zoom = state.zoom ?? 1;
      const canvasX = gm.rowHeaderGutter(state.config) + region.floating.x - state.viewport.scrollX;
      const canvasY = gm.colHeaderGutter(state.config) + region.floating.y - state.viewport.scrollY;
      const layer = document.querySelector("[data-grid-canvas-layer]");
      if (!layer) return null;
      const rect = layer.getBoundingClientRect();
      return {
        x: rect.left + canvasX * zoom,
        y: rect.top + canvasY * zoom,
        width: region.floating.width * zoom,
        height: region.floating.height * zoom,
        zoom,
      };
    },
    { chartId, overlays: GRID_OVERLAYS, grid: GRID_MODULE },
  );
  expect(box, `no chart region is published for "${chartId}"`).not.toBeNull();
  expect(box!.zoom, "these coordinates are only right at zoom 1 — see chartClientBox").toBe(1);
  return { x: box!.x, y: box!.y, width: box!.width, height: box!.height };
}

/**
 * Wait for the grid to stop painting.
 *
 * DELIBERATELY NOT `waitForGridStable` from helpers/screenshots.ts, and this is
 * the reason rather than a shortcut: that helper calls `assertCaptureEnvironment`,
 * which REFUSES to proceed when `devicePixelRatio !== 1` because every committed
 * golden was recorded at 1. That guard is about COMPARABILITY WITH A COMMITTED
 * BASELINE, and this file has none: every pixel assertion below compares two
 * captures taken seconds apart in the SAME run, at the same DPR, of the same
 * clip. Borrowing the helper would make this journey unrunnable on a 200%
 * display for a reason that has nothing to do with what it measures — which is
 * exactly what happened on its first run (measured 2026-09-21: DPR 2).
 *
 * What IS borrowed is the part that matters: `__CALCULA_GRID_RENDER__`'s
 * quiescence, two consecutive frames of it, with a timer racing every rAF so an
 * occluded window cannot hang the test instead of failing it.
 */
async function settleGrid(page: Page, budgetMs = 3000): Promise<void> {
  await page.waitForSelector("[data-focus-container='spreadsheet']", { state: "visible", timeout: budgetMs });
  // Park the marching-ants dash phase, as the capture helpers do.
  await page.evaluate(() => {
    document.documentElement.dataset.reducedMotion = "true";
  });
  const floor = page.waitForTimeout(250);
  const settled = await page.evaluate(async (ms: number) => {
    const signal = () =>
      (
        window as unknown as Record<
          string,
          { fetchesInFlight: number; refetchQueued: boolean; dataSeq: number; paintedDataSeq: number } | undefined
        >
      ).__CALCULA_GRID_RENDER__;
    if (!signal()) return "absent";
    const frame = () =>
      new Promise<void>((r) => {
        let done = false;
        const go = () => {
          if (done) return;
          done = true;
          r();
        };
        requestAnimationFrame(go);
        setTimeout(go, 50);
      });
    const quiescent = () => {
      const s = signal()!;
      return s.fetchesInFlight === 0 && !s.refetchQueued && s.paintedDataSeq === s.dataSeq;
    };
    const deadline = Date.now() + ms;
    let streak = 0;
    while (Date.now() < deadline) {
      await frame();
      streak = quiescent() ? streak + 1 : 0;
      if (streak >= 2) return "quiescent";
    }
    return "timeout";
  }, budgetMs);
  await floor;
  if (settled === "timeout") {
    console.warn("[chart-interaction] the grid never went quiescent — a capture below may be racing a repaint");
  }
}

/**
 * The mean colour of a clip.
 *
 * `diffCount` answers "did these pixels change", which is the right question for
 * "the reader can see it happened" and the WRONG one for "these two bars are now
 * the same colour". The series-colour journey needs the second: after a reset,
 * the point that had its own colour must come back to the colour its siblings
 * are painted in, and a diff against its own past only says it stopped being
 * orange. Sampled over a patch small enough to sit inside one bar's fill.
 */
function averageRgb(px: number[]): { r: number; g: number; b: number } {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < px.length; i += 4) {
    r += px[i];
    g += px[i + 1];
    b += px[i + 2];
    n++;
  }
  return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
}

/** The widest per-channel gap between two mean colours. */
function channelGap(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): number {
  return Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));
}

function rgbText(c: { r: number; g: number; b: number }): string {
  return `rgb(${c.r},${c.g},${c.b})`;
}

// ---------------------------------------------------------------------------
// Reading the product's own state
// ---------------------------------------------------------------------------

/** The live sub-selection (the LADDER), straight from the handler that owns it. */
async function ladder(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(async (mod: string) => {
    const m = (await (window as unknown as AppWindow).__appImport!(mod)) as {
      getSubSelection: () => unknown;
    };
    return JSON.parse(JSON.stringify(m.getSubSelection()));
  }, SELECTION_HANDLER);
}

/**
 * The RAW stored spec — `getChartById(id).spec`, never a resolved render spec.
 *
 * The distinction is the whole point of the cell-linked-title case below: the
 * resolved spec holds the cell's TEXT where the raw one holds `=AK1`.
 */
async function rawSpec(page: Page, chartId: string): Promise<ReadableSpec> {
  return page.evaluate(
    async ({ chartId, mod }) => {
      const store = (await (window as unknown as AppWindow).__appImport!(mod)) as {
        getChartById: (id: string) => { spec: unknown } | null;
      };
      const chart = store.getChartById(chartId);
      if (!chart) throw new Error(`no chart "${chartId}" in the store`);
      return JSON.parse(JSON.stringify(chart.spec));
    },
    { chartId, mod: CHART_STORE },
  );
}

/** The spec the BACKEND holds, so a round trip is proved rather than assumed. */
async function backendSpec(page: Page, chartId: string): Promise<ReadableSpec | null> {
  return page.evaluate(async (id: string) => {
    const charts = (await (window as unknown as AppWindow).__TAURI__.core.invoke("get_charts")) as Array<{
      id: string;
      specJson: string;
    }>;
    const found = charts.find((c) => c.id === id);
    if (!found) return null;
    // `specJson` is the WHOLE ChartDefinition (chartStore.toEntry), so the spec
    // sits one level down.
    const def = JSON.parse(found.specJson) as { spec?: unknown };
    return (def.spec ?? null) as ReadableSpec | null;
  }, chartId);
}

/** One MEASURED furniture rect from `layout.elements`, chart-local. */
async function elementRect(
  page: Page,
  chartId: string,
  key: "title" | "xAxisTitle" | "yAxisTitle" | "chartArea",
): Promise<Rect | null> {
  return page.evaluate(
    async ({ chartId, key, mod }) => {
      const m = (await (window as unknown as AppWindow).__appImport!(mod)) as {
        getCachedChartData: (id: string) => { layout?: { elements?: Record<string, unknown> } } | null;
      };
      const r = m.getCachedChartData(chartId)?.layout?.elements?.[key] as Rect | undefined;
      return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
    },
    { chartId, key, mod: CHART_RENDERER },
  );
}

/** The chart's hit geometry, as the click resolver sees it. */
async function hitGeometry(page: Page, chartId: string): Promise<HitGeometryView | null> {
  return page.evaluate(
    async ({ chartId, mod }) => {
      const m = (await (window as unknown as AppWindow).__appImport!(mod)) as {
        getCachedChartData: (id: string) => { hitGeometry: unknown } | null;
      };
      const g = m.getCachedChartData(chartId)?.hitGeometry;
      return g ? (JSON.parse(JSON.stringify(g)) as HitGeometryView) : null;
    },
    { chartId, mod: CHART_RENDERER },
  );
}

/** A trendline's recorded POLYLINE, chart-local. Never a bounding box. */
interface TrendlineTrace {
  seriesIndex: number;
  trendlineIndex: number;
  points: Array<{ x: number; y: number }>;
}

/**
 * Everything `layout.elements` records, plus the plot area — all chart-local.
 *
 * `elementRect` above answers one named rect and is kept for the four cases that
 * only ever want one. This reads the WHOLE set, because the band arithmetic the
 * data-table work fixed is a statement about how several rects sit relative to
 * one another, and reading them one call at a time would compare rects measured
 * at different moments.
 */
interface LayoutView {
  plotArea: Rect;
  elements: {
    family: string;
    chartArea: Rect;
    title?: Rect;
    xAxisTitle?: Rect;
    yAxisTitle?: Rect;
    xAxisBand?: Rect;
    yAxisBand?: Rect;
    legend?: Rect;
    dataTable?: Rect;
    trendlines?: TrendlineTrace[];
    errorBars?: Array<{ seriesIndex: number; rect: Rect }>;
    dataLabels?: Array<{ seriesIndex: number; pointIndex: number; rect: Rect }>;
    measured: string[];
  } | null;
}

async function layoutView(page: Page, chartId: string): Promise<LayoutView> {
  const view = await page.evaluate(
    async ({ chartId, mod }) => {
      const m = (await (window as unknown as AppWindow).__appImport!(mod)) as {
        getCachedChartData: (id: string) => { layout?: unknown } | null;
      };
      const layout = m.getCachedChartData(chartId)?.layout as
        | { plotArea: unknown; elements?: unknown }
        | undefined;
      if (layout === undefined) return null;
      return JSON.parse(
        JSON.stringify({ plotArea: layout.plotArea, elements: layout.elements ?? null }),
      ) as LayoutView;
    },
    { chartId, mod: CHART_RENDERER },
  );
  expect(view, `no painted layout for "${chartId}" — it has not drawn yet`).not.toBeNull();
  return view!;
}

/**
 * Edit a spec through the PRODUCT'S OWN commit path — the same `applySpecPatch`
 * every Format-pane control calls, so the repaint, the cache invalidation and
 * the overlay re-sync are the product's and not the test's.
 *
 * Deliberately NOT `window.dispatchEvent(new Event("charts:refresh"))`: that
 * event makes the extension RELOAD its store from the backend, which would
 * discard a patch the 300 ms debounce has not saved yet and turn every
 * assertion below it into a measurement of the previous spec.
 */
async function patchSpecLive(
  page: Page,
  chartId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await page.evaluate(
    async ({ chartId, patch, pane }) => {
      const m = (await (window as unknown as AppWindow).__appImport!(pane)) as {
        applySpecPatch: (id: string, build: (spec: unknown) => unknown) => void;
      };
      m.applySpecPatch(chartId, () => patch);
    },
    { chartId, patch, pane: FORMAT_PANE },
  );
  await page.waitForTimeout(600);
  await settleGrid(page);
}

/** Does the store still hold this chart? */
async function chartExists(page: Page, chartId: string): Promise<boolean> {
  return page.evaluate(
    async ({ chartId, mod }) => {
      const store = (await (window as unknown as AppWindow).__appImport!(mod)) as {
        getChartById: (id: string) => unknown | null;
      };
      return store.getChartById(chartId) !== null;
    },
    { chartId, mod: CHART_STORE },
  );
}

/** Core's own "is the grid the subject at all?" predicate — gate 2 of Delete. */
async function gridFocused(page: Page): Promise<boolean> {
  return page.evaluate(async (mod: string) => {
    const m = (await (window as unknown as AppWindow).__appImport!(mod)) as {
      isGridFocused: () => boolean;
    };
    return m.isGridFocused();
  }, KEYBINDINGS);
}

/** Flush the store's 300 ms save debounce, so the backend is caught up. */
async function flushChartSaves(page: Page): Promise<void> {
  await page.evaluate(async (mod: string) => {
    const store = (await (window as unknown as AppWindow).__appImport!(mod)) as {
      flushPendingChartSaves: () => Promise<void>;
    };
    await store.flushPendingChartSaves();
  }, CHART_STORE);
}

// ---------------------------------------------------------------------------
// Making a chart
// ---------------------------------------------------------------------------

interface ChartPlacement {
  x: number;
  y: number;
  width: number;
  height: number;
}

const DEFAULT_PLACEMENT: ChartPlacement = { x: 70, y: 40, width: 540, height: 340 };

/** Create a chart through the store's own create, and wait for its first paint. */
async function makeChart(
  page: Page,
  spec: Record<string, unknown>,
  name: string,
  placement: ChartPlacement = DEFAULT_PLACEMENT,
): Promise<string> {
  const chartId = await page.evaluate(
    async ({ spec, name, placement, mod }) => {
      const store = (await (window as unknown as AppWindow).__appImport!(mod)) as {
        createChart: (spec: unknown, placement: Record<string, unknown>) => { chartId: string };
        syncChartRegions: () => void;
      };
      const created = store.createChart(spec, { sheetIndex: 0, ...placement, name });
      store.syncChartRegions();
      return created.chartId;
    },
    { spec, name, placement, mod: CHART_STORE },
  );
  // The first paint is what produces `layout.elements` and the hit geometry;
  // everything below is located from those, so it is a wait, not a courtesy.
  await expect
    .poll(async () => (await hitGeometry(page, chartId)) !== null, {
      timeout: 15_000,
      message: "the chart never produced hit geometry — it has not painted",
    })
    .toBe(true);
  await settleGrid(page);
  return chartId;
}

/** Remove a chart the way the product does (deselect, store, cache, regions). */
async function removeChart(page: Page, chartId: string): Promise<void> {
  await page.evaluate((id: string) => {
    (window as unknown as AppWindow).__CALCULA_CHARTS__?.deleteChart?.(id);
  }, chartId);
  await page.waitForTimeout(400);
}

/** Seed the plotted range. Idempotent, so every test may call it. */
async function seedData(grid: {
  setCellValueDirect: (ref: string, value: string) => Promise<void>;
}): Promise<void> {
  await grid.setCellValueDirect(`${CAT_COL}1`, "Month");
  await grid.setCellValueDirect(`${VAL_COL}1`, "Units");
  for (let i = 0; i < MONTHS.length; i++) {
    await grid.setCellValueDirect(`${CAT_COL}${i + 2}`, MONTHS[i]);
    await grid.setCellValueDirect(`${VAL_COL}${i + 2}`, String(UNITS[i]));
  }
}

/** The data block every chart in this file plots. */
const DATA_SOURCE = {
  sheetIndex: 0,
  startRow: 0,
  startCol: CAT_COL_INDEX,
  endRow: MONTHS.length,
  endCol: VAL_COL_INDEX,
};

function baseSpec(mark: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mark,
    data: DATA_SOURCE,
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [{ sourceIndex: 1, name: "Units", color: "#4472C4" }],
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Gestures
// ---------------------------------------------------------------------------

/**
 * Two SLOW single clicks, far enough apart that the browser cannot fuse them
 * into a `dblclick`.
 *
 * Chromium fuses two presses within ~500 ms at the same point. The ladder
 * behaviour under test (chart -> series -> point) is what a reader gets from two
 * separate clicks, and the double-click gesture is a DIFFERENT product rule
 * (chartTextEditing: one gesture, one answer). A test that accidentally
 * produced the second while asking about the first would be measuring the wrong
 * feature and would read as a ladder defect.
 */
const SLOW_CLICK_GAP_MS = 650;

async function slowClick(page: Page, x: number, y: number): Promise<void> {
  await page.mouse.move(x, y);
  await page.mouse.click(x, y);
  await page.waitForTimeout(SLOW_CLICK_GAP_MS);
}

/** Click somewhere on the grid that is not this chart, to commit and deselect. */
async function clickAwayFrom(page: Page, box: Clip): Promise<void> {
  const x = box.x + box.width / 2;
  const y = box.y + box.height + 60;
  await page.mouse.click(x, y);
  await page.waitForTimeout(500);
}

/** The bar rect for one (series, category) pair, chart-local. */
async function barRect(page: Page, chartId: string, categoryIndex: number, seriesIndex = 0): Promise<Rect> {
  const g = await hitGeometry(page, chartId);
  expect(g?.type, "this chart should be drawing bars").toBe("bars");
  const r = (g?.rects ?? []).find(
    (b) => b.categoryIndex === categoryIndex && b.seriesIndex === seriesIndex,
  );
  expect(r, `no bar is drawn at series ${seriesIndex}, category ${categoryIndex}`).toBeTruthy();
  return { x: r!.x, y: r!.y, width: r!.width, height: r!.height };
}

/** The page-space centre of one bar. */
async function barCentre(page: Page, chartId: string, box: Clip, categoryIndex: number): Promise<{ x: number; y: number }> {
  const r = await barRect(page, chartId, categoryIndex);
  return { x: box.x + r.x + r.width / 2, y: box.y + r.y + r.height / 2 };
}

/** The page-space mid-point of one pie slice's ring. */
async function sliceCentre(page: Page, chartId: string, box: Clip, index: number): Promise<{ x: number; y: number }> {
  const g = await hitGeometry(page, chartId);
  expect(g?.type, "this chart should be drawing slices").toBe("slices");
  const arc = (g?.arcs ?? []).find((a) => a.seriesIndex === index);
  expect(arc, `no slice is drawn at index ${index}`).toBeTruthy();
  const mid = (arc!.startAngle + arc!.endAngle) / 2;
  const r = (arc!.innerRadius + arc!.outerRadius) / 2;
  return {
    x: box.x + arc!.centerX + Math.cos(mid) * r,
    y: box.y + arc!.centerY + Math.sin(mid) * r,
  };
}

/** The page-space centre of one line marker. */
async function markerCentre(page: Page, chartId: string, box: Clip, categoryIndex: number): Promise<{ x: number; y: number }> {
  const g = await hitGeometry(page, chartId);
  expect(g?.type, "this chart should be drawing point markers").toBe("points");
  const m = (g?.markers ?? []).find((mk) => mk.categoryIndex === categoryIndex && mk.seriesIndex === 0);
  expect(m, `no marker is drawn at category ${categoryIndex}`).toBeTruthy();
  return { x: box.x + m!.cx, y: box.y + m!.cy };
}

/** A small square clip around a page point, for "did ONLY this datum change?". */
function sampleBox(at: { x: number; y: number }, half = 6): Clip {
  return { x: at.x - half, y: at.y - half, width: half * 2, height: half * 2 };
}

const CHART_MENU = "[data-chart-context-menu]";

/** Right-click a page point and wait for the chart menu. */
async function openChartMenu(page: Page, x: number, y: number): Promise<void> {
  await page.mouse.move(x, y);
  await page.waitForTimeout(150);
  await page.mouse.click(x, y, { button: "right" });
  await expect(page.locator(CHART_MENU), "the chart context menu must open").toBeVisible({ timeout: 5_000 });
}

/** The label of the menu's always-last "Format <element>..." row. */
async function formatRowLabel(page: Page): Promise<string> {
  return (await page.locator(`${CHART_MENU} [data-chart-menu-item="formatElement"]`).innerText()).trim();
}

/**
 * Take the menu's "Format ..." row, which for a data point lands in the Format
 * TASK PANE (the modal box was retired; `DataPointFormatDialog` is a redirector).
 */
async function openFormatPaneFromMenu(page: Page): Promise<void> {
  await page.locator(`${CHART_MENU} [data-chart-menu-item="formatElement"]`).click();
  await expect(page.locator('[data-testid="chart-format-pane"]'), "the Format pane must open").toBeVisible({
    timeout: 10_000,
  });
}

/**
 * Put the Format pane on a named tab.
 *
 * MEASURED, not defensive. `ChartFormatPane` keeps the reader's LAST DELIBERATE
 * tab choice in `preferredTab` and honours it on every retarget that offers the
 * same tab — which is the right product behaviour and makes the pane's opening
 * tab a function of what some EARLIER test clicked. One test here clicks
 * "Options" to focus a button; without this, the next test's "Fill colour"
 * swatches were simply not on screen, and the failure read as a missing
 * control rather than as a remembered preference.
 */
async function pickFormatTab(page: Page, label: "Fill & Line" | "Options" | "Text"): Promise<void> {
  const tab = page.locator('[data-testid="chart-format-pane"] [role="tab"]', {
    hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
  });
  await expect(tab, `the Format pane must offer a "${label}" tab for this subject`).toBeVisible({ timeout: 5_000 });
  await tab.click();
  await page.waitForTimeout(250);
  await expect(tab, `"${label}" must end up the selected tab`).toHaveAttribute("aria-selected", "true");
}

/** One swatch button in the pane, addressed by its field label and its hex. */
function swatch(page: Page, field: string, hex: string) {
  return page.locator(`[data-chart-swatches="${field}"] [data-chart-swatch="${hex}"]`);
}

/**
 * The same thing, SCOPED TO THE PANE.
 *
 * "Colour" is the label four different sections use (series fill, trendline
 * line, error-bar line, data-label text), so an unscoped selector for it is a
 * selector that will one day match something else on screen. The two labels
 * `swatch` is used for above — "Fill colour", "Marker fill" — are unique.
 */
function paneSwatch(page: Page, field: string, hex: string) {
  return page.locator(
    `[data-testid="chart-format-pane"] [data-chart-swatches="${field}"] [data-chart-swatch="${hex}"]`,
  );
}

/** The value a pane colour field is SHOWING — the read half of the control. */
async function paneColorValue(page: Page, label: string): Promise<string> {
  const input = page.locator(`[data-testid="chart-format-pane"] input[type="color"][aria-label="${label}"]`);
  await expect(input, `the pane must offer a "${label}" colour field for this subject`).toBeVisible({
    timeout: 5_000,
  });
  return (await input.inputValue()).toLowerCase();
}

/** Excel's Name Box wording for whatever the pane is targeting right now. */
async function paneSubject(page: Page): Promise<string> {
  return (await page.locator('[data-testid="chart-format-subject"]').innerText()).trim();
}

/**
 * Two slow clicks at one point, then the ladder the handler reports.
 *
 * The first click on an UNSELECTED chart takes the object (`advanceSelection`
 * only runs on a chart that is already selected); the second advances onto
 * whatever is under the cursor. For the in-plot furniture there is no third
 * rung — a trendline has no parts — so two clicks is the whole gesture.
 */
async function selectByTwoClicks(page: Page, at: { x: number; y: number }): Promise<Record<string, unknown>> {
  await slowClick(page, at.x, at.y);
  await slowClick(page, at.x, at.y);
  return ladder(page);
}

/**
 * Press Delete on a chart rung, having first clicked it back.
 *
 * The click is not a courtesy: `chartOwnsKeystroke` refuses unless the GRID
 * holds DOM focus, and everything that formats a selection first puts focus on
 * a pane control. The focus reading is asserted rather than assumed, because a
 * Delete that silently belonged to nobody would look exactly like a Delete the
 * chart refused on purpose.
 */
async function deleteSelectedRung(page: Page, at: { x: number; y: number }, label: string): Promise<void> {
  await slowClick(page, at.x, at.y);
  const focused = await gridFocused(page);
  console.log(`[chart-interaction] before Delete on ${label}: gridFocused=${focused}`);
  expect(focused, `the grid must hold focus or Delete never reaches the chart (${label})`).toBe(true);
  await page.keyboard.press("Delete");
  await page.waitForTimeout(900);
}

/**
 * The cell guard the furniture Deletes are measured against.
 *
 * A1 is the cell the `appPage` fixture leaves selected, and clicking a chart
 * does NOT move the grid's cell selection (it must not — a selection change
 * deselects the chart), so a Delete that escapes to the grid runs Excel's
 * `core.edit.clearContents` over exactly this cell. It is outside every chart
 * this file places.
 */
const SENTINEL = "SENTINEL";

async function seedSentinel(
  page: Page,
  grid: { setCellValueDirect: (ref: string, value: string) => Promise<void> },
): Promise<void> {
  await grid.setCellValueDirect("A1", SENTINEL);
  await page.waitForTimeout(300);
}

/**
 * Park the selection on the chart TITLE before a pixel measurement.
 *
 * `drawSelectionHighlights` paints a WHITE WASH over every datum that is not
 * selected whenever the rung is "series" or "dataPoint". So a bar's colour read
 * while a sibling is selected is that bar's colour under a veil, and two bars
 * compared across different rungs are not comparable at all. An "element" rung
 * paints a hairline box on the title and nothing whatever on the plot.
 *
 * Deselecting the chart would do as well for the pixels and would take the
 * Format pane's subject with it, which is why the selection is MOVED rather
 * than dropped.
 */
async function parkSelectionOnTitle(page: Page, chartId: string, box: Clip): Promise<void> {
  const r = await elementRect(page, chartId, "title");
  expect(r, "this journey's charts carry a title to park the selection on").not.toBeNull();
  await slowClick(page, box.x + r!.x + r!.width / 2, box.y + r!.y + r!.height / 2);
  expect(await ladder(page), "the parking click must land on the title").toMatchObject({
    level: "element",
    elementId: "title",
  });
  await page.mouse.move(4, 4);
  await page.waitForTimeout(350);
  await settleGrid(page);
}

/** The minimum distance from a page point to any of this chart's datum markers. */
function nearestMarkerDistance(
  markers: Array<{ cx: number; cy: number }>,
  local: { x: number; y: number },
): number {
  let best = Number.POSITIVE_INFINITY;
  for (const m of markers) {
    const d = Math.hypot(m.cx - local.x, m.cy - local.y);
    if (d < best) best = d;
  }
  return best;
}

// ===========================================================================
// The journey
// ===========================================================================

test.describe("Chart interaction, live", () => {
  // NOT `mode: "serial"`. Each test creates and deletes its own chart, so they
  // are independent — and serial mode SKIPS the rest of the file after the
  // first failure, which turns "one assertion was wrong" into "six journeys
  // were never run" and hides every other defect behind the first one.

  // ------------------------------------------------------------------------
  // 1 + 2 — the owner's first sentence
  // ------------------------------------------------------------------------

  test("double-click the chart title and both axis titles, type, click outside: painted, stored and round-tripped", async ({
    appPage,
    grid,
  }) => {
    test.setTimeout(240_000);
    await installAppImport(appPage);
    await seedData(grid);
    await appPage.waitForTimeout(400);

    const chartId = await makeChart(
      appPage,
      baseSpec("bar", {
        title: "Q1 Sales",
        xAxis: { title: "Month" },
        yAxis: { title: "Units" },
      }),
      "TitleEditJourney",
    );

    const cases: Array<{
      key: "title" | "xAxisTitle" | "yAxisTitle";
      was: string;
      becomes: string;
      /** Where in the raw spec the text lives. */
      read: (spec: ReadableSpec) => string | null | undefined;
    }> = [
      { key: "title", was: "Q1 Sales", becomes: "Quarterly Revenue By Month", read: (s) => s.title },
      { key: "xAxisTitle", was: "Month", becomes: "Calendar Month Of Sale", read: (s) => s.xAxis?.title },
      { key: "yAxisTitle", was: "Units", becomes: "Units Shipped Per Month", read: (s) => s.yAxis?.title },
    ];

    for (const c of cases) {
      const box = await chartClientBox(appPage, chartId);
      const before = await elementRect(appPage, chartId, c.key);
      expect(before, `"${c.key}" must be DRAWN before it can be double-clicked — there is no rect for it`).not.toBeNull();

      // The band the glyphs sit in, in page space. A full-width strip for the
      // two horizontal titles; a full-height left strip for the rotated y title,
      // whose rect is tall-and-thin. Fixed from the BEFORE rect, so the same
      // pixels are compared even though the text grows.
      const band: Clip =
        c.key === "yAxisTitle"
          ? { x: box.x, y: box.y, width: Math.max(before!.width + 30, 40), height: box.height }
          : { x: box.x, y: box.y + before!.y - 8, width: box.width, height: before!.height + 16 };
      const paintedBefore = await pixels(appPage, band);

      // THE GESTURE. A real double-click at the measured glyph box's centre.
      const at = { x: box.x + before!.x + before!.width / 2, y: box.y + before!.y + before!.height / 2 };
      await appPage.mouse.dblclick(at.x, at.y);
      await appPage.waitForTimeout(400);

      const editor = appPage.locator("[data-overlay-text-editor]");
      await expect(editor, `double-clicking "${c.key}" must open the in-place editor`).toBeVisible({ timeout: 5_000 });
      expect(await editor.inputValue(), `the editor must be seeded from the RAW spec for "${c.key}"`).toBe(c.was);
      // The editor owns the keyboard: a claimed element, focused.
      expect(
        await appPage.evaluate(() => document.activeElement?.hasAttribute("data-overlay-text-editor") ?? false),
        "the editor must hold focus, or the typing below goes to the grid",
      ).toBe(true);

      // `fill` rather than `type`: the box opens with everything selected, and
      // a deterministic replace is what this case is about. The commit reads
      // `el.value`, which `fill` sets through the real input path.
      await editor.fill(c.becomes);
      await appPage.waitForTimeout(150);

      // EXCEL'S COMMIT FOR A CHART TITLE: click outside. There is no cancelling
      // key here (`enterInserts`), so this is the gesture a reader makes.
      await clickAwayFrom(appPage, box);
      await expect(editor, "clicking outside must close the editor").toHaveCount(0, { timeout: 5_000 });

      // (a) THE STORE holds the typed text, raw.
      await expect
        .poll(async () => c.read(await rawSpec(appPage, chartId)), {
          timeout: 10_000,
          message: `the raw spec never took the new "${c.key}"`,
        })
        .toBe(c.becomes);

      // (b) THE BACKEND holds it too — one debounced save, one round trip.
      await expect
        .poll(async () => c.read((await backendSpec(appPage, chartId)) ?? {}), {
          timeout: 15_000,
          message: `the backend never received the new "${c.key}"`,
        })
        .toBe(c.becomes);

      // (c) IT IS PAINTED. The measured glyph rect grew (the new text is
      // longer), and the pixels in the band changed.
      await settleGrid(appPage);
      const after = await elementRect(appPage, chartId, c.key);
      expect(after, `"${c.key}" stopped being drawn after the edit`).not.toBeNull();
      const grew = c.key === "yAxisTitle" ? after!.height - before!.height : after!.width - before!.width;
      expect(grew, `the MEASURED glyph run for "${c.key}" must grow with the longer text`).toBeGreaterThan(10);

      await appPage.mouse.move(4, 4);
      await appPage.waitForTimeout(250);
      const paintedAfter = await pixels(appPage, band);
      expect(
        diffCount(paintedBefore, paintedAfter),
        `POSITIVE CONTROL: the "${c.key}" band must actually repaint`,
      ).toBeGreaterThan(20);
    }

    await removeChart(appPage, chartId);
  });

  // ------------------------------------------------------------------------
  // 3 — the data-destroying trap
  // ------------------------------------------------------------------------

  test("a CELL-LINKED title survives being opened for editing: the editor shows =AK1, Escape keeps the link, the cell still drives it", async ({
    appPage,
    grid,
  }) => {
    test.setTimeout(240_000);
    await installAppImport(appPage);
    await seedData(grid);
    await grid.setCellValueDirect(LINK_CELL, "Linked A");
    await appPage.waitForTimeout(400);

    const chartId = await makeChart(
      appPage,
      baseSpec("bar", { title: `=${LINK_CELL}`, xAxis: { title: "Month" }, yAxis: { title: "Units" } }),
      "CellLinkedTitleJourney",
    );

    const box = await chartClientBox(appPage, chartId);
    const before = await elementRect(appPage, chartId, "title");
    expect(before, "a cell-linked title must be drawn like any other").not.toBeNull();
    const band: Clip = { x: box.x, y: box.y + before!.y - 8, width: box.width, height: before!.height + 16 };
    const paintedLinkedA = await pixels(appPage, band);

    // THE WHOLE POINT OF THIS CASE. The editor's TEXT comes from the RAW spec
    // and its RECT from the RESOLVED layout. Seeded from the resolved spec it
    // would open showing "Linked A" and commit the literal string — silently
    // replacing the link with a frozen copy of what the cell said this morning,
    // with no error anywhere.
    const at = { x: box.x + before!.x + before!.width / 2, y: box.y + before!.y + before!.height / 2 };
    await appPage.mouse.dblclick(at.x, at.y);
    const editor = appPage.locator("[data-overlay-text-editor]");
    await expect(editor).toBeVisible({ timeout: 5_000 });
    expect(
      await editor.inputValue(),
      "THE TRAP: the editor must be seeded from the RAW spec (=AK1), never from the resolved title text",
    ).toBe(`=${LINK_CELL}`);

    // Escape on a chart title COMMITS what is in the box (Excel's rule — there
    // is no cancelling key for `enterInserts`). Committing the unchanged raw
    // text must write NOTHING: `commitChartText` compares against the stored
    // value first.
    await appPage.keyboard.press("Escape");
    await expect(editor, "Escape must close the editor").toHaveCount(0, { timeout: 5_000 });
    await appPage.waitForTimeout(600);
    expect((await rawSpec(appPage, chartId)).title, "the link must still be a link after the editor closed").toBe(
      `=${LINK_CELL}`,
    );

    // NOW CHANGE THE CELL. A cell-ref title always intersects a data change
    // (`chartIntersectsChanges`), so the chart re-resolves and repaints. The
    // user's own edit emits `app:cells-updated` WITH the changed cells;
    // `setCellValueDirect` writes through `update_cell` and does not, so the
    // event the product listens to is emitted here.
    await grid.setCellValueDirect(LINK_CELL, "Much Longer Linked Title B");
    await appPage.evaluate(
      ({ row, col }) => {
        window.dispatchEvent(new CustomEvent("app:cells-updated", { detail: { changes: [{ row, col }] } }));
      },
      { row: LINK_ROW, col: LINK_COL },
    );

    await expect
      .poll(
        async () => {
          const r = await elementRect(appPage, chartId, "title");
          return r === null ? 0 : Math.round(r.width);
        },
        {
          timeout: 20_000,
          message: "the painted title never followed the cell — the link was broken by opening the editor",
        },
      )
      .toBeGreaterThan(Math.round(before!.width) + 20);

    await settleGrid(appPage);
    await appPage.mouse.move(4, 4);
    await appPage.waitForTimeout(250);
    expect(
      diffCount(paintedLinkedA, await pixels(appPage, band)),
      "POSITIVE CONTROL: the title band must repaint with the cell's new text",
    ).toBeGreaterThan(20);
    expect((await rawSpec(appPage, chartId)).title, "and the spec still holds the REFERENCE, not a copy of the text").toBe(
      `=${LINK_CELL}`,
    );

    await removeChart(appPage, chartId);
  });

  // ------------------------------------------------------------------------
  // 4 + 6 — the owner's second sentence, on bars, and the jitter control
  // ------------------------------------------------------------------------

  test("one BAR: the ladder reaches it, the menu says Data Point in the singular, and only that bar changes colour", async ({
    appPage,
    grid,
  }) => {
    test.setTimeout(300_000);
    await installAppImport(appPage);
    await seedData(grid);
    await appPage.waitForTimeout(400);

    const chartId = await makeChart(appPage, baseSpec("bar", { title: "Bar Point Journey" }), "BarPointJourney");
    let box = await chartClientBox(appPage, chartId);

    const TARGET = 3; // Apr, the tallest bar — a big target and a big colour patch
    const NEIGHBOUR = 1;

    // --- THE LADDER, by real clicks ----------------------------------------
    await slowClick(appPage, (await barCentre(appPage, chartId, box, TARGET)).x, (await barCentre(appPage, chartId, box, TARGET)).y);
    expect(await ladder(appPage), "the first click on an unselected chart selects the OBJECT").toMatchObject({
      level: "chart",
    });

    let at = await barCentre(appPage, chartId, box, TARGET);
    await slowClick(appPage, at.x, at.y);
    expect(await ladder(appPage), "the second click selects the SERIES (Excel's first stop)").toMatchObject({
      level: "series",
      seriesIndex: 0,
    });

    // --- 6. NEGATIVE CONTROL: a 1px tremor is a click, a 40px drag is a drag -
    //
    // Charts never sets `movable: false`, so EVERY left press starts a move
    // drag and Core fires `floatingObject:movePreview` on every mousemove —
    // including the sub-pixel tremor between pressing and releasing. Charts
    // used to cancel the pending ladder click on all of them, so one pixel of
    // hand jitter silently swallowed the click and the bar never got selected.
    at = await barCentre(appPage, chartId, box, TARGET);
    await appPage.mouse.move(at.x, at.y);
    await appPage.mouse.down();
    await appPage.mouse.move(at.x + 1, at.y); // inside Core's own 3px dead zone
    await appPage.mouse.up();
    await appPage.waitForTimeout(400);
    expect(
      await ladder(appPage),
      "A 1px TREMOR IS A CLICK: the ladder must still advance to the individual bar",
    ).toMatchObject({ level: "dataPoint", seriesIndex: 0, categoryIndex: TARGET });

    // ...and a REAL drag must still be a drag: the ladder does not move and the
    // object does. Without this half, "never cancel the click" would pass too.
    const regionBefore = await chartClientBox(appPage, chartId);
    at = await barCentre(appPage, chartId, box, TARGET);
    await appPage.mouse.move(at.x, at.y);
    await appPage.mouse.down();
    await appPage.mouse.move(at.x + 20, at.y + 12, { steps: 4 });
    await appPage.mouse.move(at.x + 45, at.y + 26, { steps: 4 });
    await appPage.mouse.up();
    await appPage.waitForTimeout(600);
    const regionAfter = await chartClientBox(appPage, chartId);
    expect(
      Math.round(regionAfter.x - regionBefore.x),
      "POSITIVE CONTROL for the drag half: the chart must actually have moved",
    ).toBeGreaterThan(10);
    expect(
      await ladder(appPage),
      "A REAL DRAG IS NOT A CLICK: the ladder must not have advanced past the bar it was on",
    ).toMatchObject({ level: "dataPoint", seriesIndex: 0, categoryIndex: TARGET });

    box = await chartClientBox(appPage, chartId);

    // --- 4. THE MENU'S SUBJECT IS WHAT IS UNDER THE CURSOR, IN THE SINGULAR --
    at = await barCentre(appPage, chartId, box, TARGET);
    await openChartMenu(appPage, at.x, at.y);
    expect(
      await formatRowLabel(appPage),
      "an individual bar is a Data POINT — the singular is what the recorded right-click subject exists to get right",
    ).toBe("Format Data Point...");
    expect(
      (await appPage.locator(`${CHART_MENU} [data-chart-menu-subject]`).innerText()).trim(),
      "and the menu names the datum it will act on",
    ).toContain("Data Point");

    // --- THE COLOUR, through the pane the menu opens ------------------------
    await openFormatPaneFromMenu(appPage);
    await pickFormatTab(appPage, "Fill & Line");
    // The pane's header is Excel's NAME BOX wording, which is deliberately NOT
    // the context menu's: the menu says "Format Data Point..." (the VERB and the
    // element's class), the pane names the datum itself — Format Series 1
    // "Units" Point 4 "Apr". Measured here rather than guessed; the first draft
    // of this line asserted the menu's wording and was wrong about the product.
    expect(
      (await appPage.locator('[data-testid="chart-format-subject"]').innerText()).trim(),
      "the pane must have retargeted onto the DATUM the reader clicked, not the chart",
    ).toContain(`Point ${TARGET + 1} "${MONTHS[TARGET]}"`);

    // THE BASELINE IS TAKEN WITH THE PANE ALREADY OPEN and the pointer parked
    // off the chart. A task pane takes horizontal space, so the chart's page
    // position is NOT the same before and after it opens; and a capture with
    // the context menu still up would have the menu's own pixels in it.
    await appPage.mouse.move(4, 4);
    await appPage.waitForTimeout(400);
    await settleGrid(appPage);
    box = await chartClientBox(appPage, chartId);
    const targetPatch = sampleBox(await barCentre(appPage, chartId, box, TARGET));
    const neighbourPatch = sampleBox(await barCentre(appPage, chartId, box, NEIGHBOUR));
    const targetBefore = await pixels(appPage, targetPatch);
    const neighbourBefore = await pixels(appPage, neighbourPatch);

    const ORANGE = "#ed7d31";
    await swatch(appPage, "Fill colour", ORANGE).click();
    await appPage.waitForTimeout(1200);
    await settleGrid(appPage);
    await appPage.mouse.move(4, 4);
    await appPage.waitForTimeout(250);

    const overrides = (await rawSpec(appPage, chartId)).dataPointOverrides;
    expect(overrides, "one override, for the datum the reader clicked").toHaveLength(1);
    expect(overrides![0]).toMatchObject({ seriesIndex: 0, categoryIndex: TARGET });
    expect(String(overrides![0].color).toLowerCase()).toBe(ORANGE);
    // `DATA_POINT_KEY_SEPARATOR` is U+001F (unit separator), not a pipe — a
    // character that cannot occur in a series name or a category label. Spelled
    // as an escape here rather than pasted, so the assertion survives a file
    // that gets normalised on the way through a tool.
    expect(overrides![0].key, "and it carries its identity key, so a row insert cannot move it").toBe(
      `Units\u001FApr`,
    );

    expect(
      diffCount(targetBefore, await pixels(appPage, targetPatch)),
      "the clicked bar must change colour",
    ).toBeGreaterThan(20);
    expect(
      diffCount(neighbourBefore, await pixels(appPage, neighbourPatch)),
      "NEGATIVE CONTROL: no OTHER bar may change — 'only this bar' is the whole request",
    ).toBe(0);

    await removeChart(appPage, chartId);
  });

  // ------------------------------------------------------------------------
  // 5 — the same gesture on the marks that had no reachable data point at all
  // ------------------------------------------------------------------------

  test("a PIE SLICE is reachable and formattable on its own", async ({ appPage, grid }) => {
    test.setTimeout(240_000);
    await installAppImport(appPage);
    await seedData(grid);
    await appPage.waitForTimeout(400);

    // Before the unified hit geometry the click path hit-tested BAR RECTS
    // against a bars-only cache field, so a pie, donut, line, area, scatter,
    // radar or bubble chart had no selectable data point at all: the reader
    // could select the chart and nothing inside it.
    const chartId = await makeChart(appPage, baseSpec("pie", { title: "Pie Point Journey" }), "PiePointJourney");
    let box = await chartClientBox(appPage, chartId);

    const TARGET = 2;
    const NEIGHBOUR = 4;

    let at = await sliceCentre(appPage, chartId, box, TARGET);
    await slowClick(appPage, at.x, at.y);
    expect(await ladder(appPage), "the first click selects the chart").toMatchObject({ level: "chart" });

    at = await sliceCentre(appPage, chartId, box, TARGET);
    await slowClick(appPage, at.x, at.y);
    // A slice IS its category: the radial convention is that the series axis and
    // the category axis are the same axis, so the slice walks as its own
    // single-point series.
    expect(await ladder(appPage), "the second click enters the datum ladder on that slice").toMatchObject({
      level: "series",
      seriesIndex: TARGET,
    });

    at = await sliceCentre(appPage, chartId, box, TARGET);
    await slowClick(appPage, at.x, at.y);
    expect(await ladder(appPage), "the third click reaches the SLICE itself").toMatchObject({
      level: "dataPoint",
      seriesIndex: TARGET,
      categoryIndex: TARGET,
    });

    at = await sliceCentre(appPage, chartId, box, TARGET);
    await openChartMenu(appPage, at.x, at.y);
    expect(await formatRowLabel(appPage), "one slice is a Data Point").toBe("Format Data Point...");

    await openFormatPaneFromMenu(appPage);
    await pickFormatTab(appPage, "Fill & Line");
    // Baseline AFTER the pane is open and with the pointer parked — see the bar
    // case for why both halves of that matter.
    await appPage.mouse.move(4, 4);
    await appPage.waitForTimeout(400);
    await settleGrid(appPage);
    box = await chartClientBox(appPage, chartId);
    const targetPatch = sampleBox(await sliceCentre(appPage, chartId, box, TARGET));
    const neighbourPatch = sampleBox(await sliceCentre(appPage, chartId, box, NEIGHBOUR));
    const targetBefore = await pixels(appPage, targetPatch);
    const neighbourBefore = await pixels(appPage, neighbourPatch);

    const GREEN = "#70ad47";
    await swatch(appPage, "Fill colour", GREEN).click();
    await appPage.waitForTimeout(1200);
    await settleGrid(appPage);
    await appPage.mouse.move(4, 4);
    await appPage.waitForTimeout(250);
    const pieOverrides = (await rawSpec(appPage, chartId)).dataPointOverrides;
    console.log(`[chart-interaction] pie overrides after the commit: ${JSON.stringify(pieOverrides)}`);

    // MEASURED RED (2026-09-21), and the address is the reason — printed above
    // so the failure carries its own diagnosis:
    //
    //   `pieChartPainter` builds one arc per CATEGORY and stamps `seriesIndex: i`
    //   on it (there is only ever one parsed series), so `hitTestSliceArcs`
    //   answers `seriesIndex === pointIndex === the category`. The ladder keeps
    //   that pair, the Format pane hands it to `commitDataPointOverride`, and
    //   the override is written at (i, i) — with NO identity key, because
    //   `dataPointKeyForDatum(data, i, i)` looks up `data.series[i]`, which does
    //   not exist for i > 0. The painter then resolves the same slice at
    //   (0, i). The two addresses agree only for slice 0.
    //
    // The pane reads the override back at the same wrong address, so it SHOWS
    // the colour it just wrote: in the product this reads as "I set it and the
    // chart ignored me", with the control insisting it is set.
    expect(
      diffCount(targetBefore, await pixels(appPage, targetPatch)),
      "the clicked SLICE must change colour — a per-point override the painter never applies is a field with no writer",
    ).toBeGreaterThan(20);
    expect(
      diffCount(neighbourBefore, await pixels(appPage, neighbourPatch)),
      "NEGATIVE CONTROL: no other slice may change",
    ).toBe(0);

    await removeChart(appPage, chartId);
  });

  test("a LINE MARKER is reachable and formattable on its own", async ({ appPage, grid }) => {
    test.setTimeout(240_000);
    await installAppImport(appPage);
    await seedData(grid);
    await appPage.waitForTimeout(400);

    const chartId = await makeChart(appPage, baseSpec("line", { title: "Line Point Journey" }), "LinePointJourney");
    let box = await chartClientBox(appPage, chartId);

    const TARGET = 3;
    const NEIGHBOUR = 1;

    let at = await markerCentre(appPage, chartId, box, TARGET);
    await slowClick(appPage, at.x, at.y);
    expect(await ladder(appPage), "the first click selects the chart").toMatchObject({ level: "chart" });

    at = await markerCentre(appPage, chartId, box, TARGET);
    await slowClick(appPage, at.x, at.y);
    expect(await ladder(appPage), "the second click selects the series").toMatchObject({ level: "series", seriesIndex: 0 });

    at = await markerCentre(appPage, chartId, box, TARGET);
    await slowClick(appPage, at.x, at.y);
    expect(await ladder(appPage), "the third click reaches the MARKER").toMatchObject({
      level: "dataPoint",
      seriesIndex: 0,
      categoryIndex: TARGET,
    });

    at = await markerCentre(appPage, chartId, box, TARGET);
    await openChartMenu(appPage, at.x, at.y);
    expect(await formatRowLabel(appPage), "one marker is a Data Point").toBe("Format Data Point...");

    await openFormatPaneFromMenu(appPage);
    // A LINE'S POINT IS ITS MARKER, and the painter reads `markerFill` for it
    // (`style.markerFill ?? color` in lineChartPainter) — the "Fill colour"
    // field feeds `fill`, which a line uses for its STROKE. The Marker fields
    // live on the Options tab, which is the tab a reader formatting a marker
    // reaches for.
    await pickFormatTab(appPage, "Options");

    // Baseline AFTER the pane is open and with the pointer parked.
    await appPage.mouse.move(4, 4);
    await appPage.waitForTimeout(400);
    await settleGrid(appPage);
    box = await chartClientBox(appPage, chartId);
    const targetPatch = sampleBox(await markerCentre(appPage, chartId, box, TARGET), 5);
    const neighbourPatch = sampleBox(await markerCentre(appPage, chartId, box, NEIGHBOUR), 5);
    const targetBefore = await pixels(appPage, targetPatch);
    const neighbourBefore = await pixels(appPage, neighbourPatch);

    const RED = "#9e480e";
    await swatch(appPage, "Marker fill", RED).click();
    await appPage.waitForTimeout(1200);
    await settleGrid(appPage);
    await appPage.mouse.move(4, 4);
    await appPage.waitForTimeout(250);

    const overrides = (await rawSpec(appPage, chartId)).dataPointOverrides;
    expect(overrides, "one override, on the marker the reader clicked").toHaveLength(1);
    expect(overrides![0]).toMatchObject({ seriesIndex: 0, categoryIndex: TARGET });
    expect(String(overrides![0].markerFill).toLowerCase()).toBe(RED);

    expect(
      diffCount(targetBefore, await pixels(appPage, targetPatch)),
      "the clicked MARKER must change colour",
    ).toBeGreaterThan(5);
    expect(
      diffCount(neighbourBefore, await pixels(appPage, neighbourPatch)),
      "NEGATIVE CONTROL: no other marker may change",
    ).toBe(0);

    await removeChart(appPage, chartId);
  });

  // ------------------------------------------------------------------------
  // 7 — the two data-loss paths, both with their reproduction
  // ------------------------------------------------------------------------

  test("DATA LOSS: Delete on a selected chart element acts on the CHART and never on the cells underneath", async ({
    appPage,
    grid,
  }) => {
    test.setTimeout(300_000);
    await installAppImport(appPage);
    await seedData(grid);

    // THE SENTINEL. This is what makes the test say WHERE a Delete went rather
    // than only that the chart survived. The grid's cell selection does not
    // move when a chart is clicked (it must not — a selection change deselects
    // the chart), so the `appPage` fixture's A1 is still the selected cell when
    // these Deletes are pressed. If a Delete reaches the GRID, Excel's
    // `core.edit.clearContents` runs over that selection and A1 goes empty.
    // A1 is outside the chart's own rectangle (the chart is placed at 70,40).
    await grid.setCellValueDirect("A1", "SENTINEL");
    await appPage.waitForTimeout(400);
    expect(await grid.getCellDisplayValue("A1"), "the sentinel must be in A1 before anything is pressed").toBe(
      "SENTINEL",
    );

    const chartId = await makeChart(
      appPage,
      baseSpec("bar", { title: "Delete Safety Journey", xAxis: { title: "Month" }, yAxis: { title: "Units" } }),
      "DeleteSafetyJourney",
    );
    let box = await chartClientBox(appPage, chartId);

    /**
     * Everything worth knowing after a Delete, printed as well as asserted.
     *
     * ALIVE IS READ FIRST, and the title only while there is still a chart to
     * read one from. `rawSpec` THROWS on a chart that is gone, so a helper that
     * reads it unconditionally cannot describe the one outcome the positive
     * control at the end of this test exists to assert — a DESTROYED chart —
     * and turns that pass into an exception thrown from the measurement. It was
     * invisible for as long as the positive control was failing for another
     * reason (the ladder never reached chart level, so Delete was never at the
     * destructive rung and the chart always survived). A dead chart has no
     * title; `null` says so, which is what every other probe here means by it.
     */
    const measure = async (label: string): Promise<{ title: unknown; a1: string; alive: boolean }> => {
      const alive = await chartExists(appPage, chartId);
      const m = {
        title: alive ? ((await rawSpec(appPage, chartId)).title ?? null) : null,
        a1: await grid.getCellDisplayValue("A1"),
        alive,
      };
      console.log(
        `[chart-interaction] ${label}: title=${JSON.stringify(m.title)} A1=${JSON.stringify(m.a1)} chartAlive=${m.alive}`,
      );
      return m;
    };

    /**
     * Put the sentinel back, so each probe answers for ITSELF.
     *
     * Without this the first Delete that reaches the grid empties A1 and every
     * later probe inherits the empty cell — four failures that all say "A1 was
     * empty" and only one of which measured anything.
     */
    const reseed = async (): Promise<void> => {
      await grid.setCellValueDirect("A1", "SENTINEL");
      await appPage.waitForTimeout(300);
    };

    // --- Select the title with two SLOW single clicks -----------------------
    const titleRect = await elementRect(appPage, chartId, "title");
    expect(titleRect, "the title must be drawn").not.toBeNull();
    const titleAt = {
      x: box.x + titleRect!.x + titleRect!.width / 2,
      y: box.y + titleRect!.y + titleRect!.height / 2,
    };
    await slowClick(appPage, titleAt.x, titleAt.y);
    await slowClick(appPage, titleAt.x, titleAt.y);
    expect(await ladder(appPage), "two slow clicks put the selection on the TITLE").toMatchObject({
      level: "element",
      elementId: "title",
    });
    expect(await gridFocused(appPage), "the grid holds focus — the ordinary case").toBe(true);

    // --- Delete #1. Excel clears the TITLE. --------------------------------
    //
    // SOFT assertions from here to the end of the Delete sequence, on purpose:
    // these four probes are about ONE mechanism (who gets the Delete key), and
    // a hard failure on the first would hide the answer to the other three. A
    // soft failure still fails the test.
    await appPage.keyboard.press("Delete");
    await appPage.waitForTimeout(700);
    const afterFirst = await measure("after Delete #1 on the selected title");
    expect
      .soft(
        afterFirst.a1,
        "THE DATA-LOSS QUESTION: Delete with a chart ELEMENT selected must not reach the grid and clear the cells",
      )
      .toBe("SENTINEL");
    expect.soft(afterFirst.title, "Excel clears the TITLE here — the smallest thing selected").toBeNull();
    expect.soft(afterFirst.alive, "and never the chart").toBe(true);

    // --- Delete #2 — the "did that work?" reflex (BUG-0124) ----------------
    // Nothing moves the selection off a cleared title (`revalidateSubSelection`
    // only re-checks series and dataPoint rungs), and the listener used to
    // branch on whether a WRITE happened rather than on what was SELECTED —
    // `clearChartText` returns false for an already-null title, so the second
    // press fell through to the destroy arm.
    await reseed();
    await appPage.keyboard.press("Delete");
    await appPage.waitForTimeout(700);
    const afterSecond = await measure("after Delete #2 on the already-cleared title");
    expect
      .soft(afterSecond.alive, "BUG-0124: a second Delete on an already-cleared title must NOT destroy the chart")
      .toBe(true);
    expect.soft(afterSecond.a1, "and must not clear the cells either").toBe("SENTINEL");

    // --- Delete with focus on a Format-pane BUTTON (BUG-0125) --------------
    box = await chartClientBox(appPage, chartId);
    let at = await barCentre(appPage, chartId, box, 3);
    await slowClick(appPage, at.x, at.y); // series
    at = await barCentre(appPage, chartId, box, 3);
    await slowClick(appPage, at.x, at.y); // dataPoint
    expect(await ladder(appPage)).toMatchObject({ level: "dataPoint", seriesIndex: 0, categoryIndex: 3 });

    at = await barCentre(appPage, chartId, box, 3);
    await openChartMenu(appPage, at.x, at.y);
    await openFormatPaneFromMenu(appPage);

    // A `<button role="tab">` in a task pane carries no pointer claim and is
    // none of INPUT / TEXTAREA / contentEditable, so with only those two gates
    // the Charts Delete listener answered "yes, mine" — and DESTROYED THE
    // CHART, three clicks from a fresh selection.
    const optionsTab = appPage.locator('[data-testid="chart-format-pane"] [role="tab"]', { hasText: /^Options$/ });
    await expect(optionsTab, "the Format pane must offer a focusable button for this probe").toBeVisible();
    await optionsTab.click();
    await appPage.waitForTimeout(300);
    await reseed();
    await optionsTab.focus();
    await appPage.waitForTimeout(200);
    expect(
      await appPage.evaluate(() => (document.activeElement as HTMLElement | null)?.tagName ?? "none"),
      "POSITIVE CONTROL: a pane BUTTON must really hold focus, or this probe proves nothing",
    ).toBe("BUTTON");
    expect(
      await gridFocused(appPage),
      "POSITIVE CONTROL: the grid must NOT be focused — that is the condition the missing gate covers",
    ).toBe(false);

    await appPage.keyboard.press("Delete");
    await appPage.waitForTimeout(700);
    const afterPane = await measure("after Delete with a Format-pane button focused");
    expect
      .soft(afterPane.alive, "BUG-0125: Delete while a Format-pane button holds focus must NOT destroy the chart")
      .toBe(true);
    expect.soft(afterPane.a1, "nor reach the grid").toBe("SENTINEL");

    // --- THE POSITIVE CONTROL: Delete on the chart OBJECT still destroys it -
    // Without this the three probes above would read exactly the same against a
    // Delete listener that had simply stopped working. Back to the object by
    // Excel's own route out of a rung: Escape, one level at a time.
    box = await chartClientBox(appPage, chartId);
    // A DIFFERENT bar, so the ladder MOVING is proof the click landed on the
    // chart. Clicking the same bar again would leave the rung where it was and
    // the focus reading below would be about a click that might have missed.
    at = await barCentre(appPage, chartId, box, 1);
    await slowClick(appPage, at.x, at.y);
    expect(
      await ladder(appPage),
      "POSITIVE CONTROL: the click must have landed on the chart — the ladder moved to the bar under it",
    ).toMatchObject({ level: "dataPoint", seriesIndex: 0, categoryIndex: 1 });
    // MEASURED, and soft, because it is its own question: does a click on the
    // grid canvas take DOM focus back from a task-pane button? If it does not,
    // every chart keystroke (the element walk, Escape, Delete) stays dead until
    // the reader clicks a CELL, and the reader has no way to know that.
    const focusBack = await gridFocused(appPage);
    console.log(`[chart-interaction] after clicking a bar with the pane focused: gridFocused=${focusBack}`);
    expect
      .soft(focusBack, "clicking the chart must return keyboard focus to the grid, or its keystrokes stay dead")
      .toBe(true);
    await appPage.keyboard.press("Escape");
    await appPage.waitForTimeout(250);
    expect.soft(await ladder(appPage), "Escape steps up to the series").toMatchObject({ level: "series" });
    await appPage.keyboard.press("Escape");
    await appPage.waitForTimeout(250);
    const atObject = await ladder(appPage);
    console.log(`[chart-interaction] rung before the object Delete: ${JSON.stringify(atObject)}`);
    expect.soft(atObject, "and again to the chart OBJECT").toMatchObject({ level: "chart" });
    await reseed();
    await appPage.keyboard.press("Delete");
    await appPage.waitForTimeout(900);
    const afterObject = await measure("after Delete on the chart OBJECT");
    expect
      .soft(afterObject.alive, "POSITIVE CONTROL: Delete on the chart OBJECT is the one destructive route")
      .toBe(false);
    expect
      .soft(afterObject.a1, "and even THAT Delete is the chart's, not the grid's — the cells are untouched")
      .toBe("SENTINEL");

    // Clean up whatever survived, so the shared workbook is not left with it.
    if (await chartExists(appPage, chartId)) await removeChart(appPage, chartId);
    await grid.setCellValueDirect("A1", "");
  });

  // ------------------------------------------------------------------------
  // 8 — the preview is a TRANSIENT write
  // ------------------------------------------------------------------------

  test("hovering a colour swatch writes nothing at all; clicking it writes exactly one undo entry and one dirty flag", async ({
    appPage,
    grid,
  }) => {
    test.setTimeout(300_000);
    await installAppImport(appPage);
    await seedData(grid);
    await appPage.waitForTimeout(400);

    const chartId = await makeChart(appPage, baseSpec("bar", { title: "Preview Journey" }), "PreviewJourney");
    let box = await chartClientBox(appPage, chartId);
    const TARGET = 3;

    // A CLEAN BASELINE IS THE ONLY WAY TO SEE A DIRTY FLAG APPEAR, and it is
    // taken BEFORE any of the pointer work below. Creating the chart dirtied
    // the document; the ladder clicks and the menu do not write anything, so
    // saving here leaves the document clean for the whole measurement. It was
    // done AFTER the pane opened on the first attempt, and the save's own
    // reload dropped the pane's subject — the swatch strip was simply not
    // there any more. `dirty-flag.spec.ts` uses the same temp-file shape.
    await flushChartSaves(appPage);
    await appPage.waitForTimeout(400);
    await invoke(appPage, "save_file", { path: CLEAN_BASELINE_FILE });
    await appPage.waitForTimeout(700);
    expect(await invoke<boolean>(appPage, "is_file_modified"), "baseline must be CLEAN").toBe(false);
    await settleGrid(appPage);
    box = await chartClientBox(appPage, chartId);

    // Ladder to the datum and open the pane the swatches live in.
    let at = await barCentre(appPage, chartId, box, TARGET);
    await slowClick(appPage, at.x, at.y);
    at = await barCentre(appPage, chartId, box, TARGET);
    await slowClick(appPage, at.x, at.y);
    at = await barCentre(appPage, chartId, box, TARGET);
    await slowClick(appPage, at.x, at.y);
    expect(await ladder(appPage)).toMatchObject({ level: "dataPoint", seriesIndex: 0, categoryIndex: TARGET });
    at = await barCentre(appPage, chartId, box, TARGET);
    await openChartMenu(appPage, at.x, at.y);
    await openFormatPaneFromMenu(appPage);
    await pickFormatTab(appPage, "Fill & Line");
    expect(
      await invoke<boolean>(appPage, "is_file_modified"),
      "POSITIVE CONTROL: selecting a datum and opening a pane must not have dirtied anything",
    ).toBe(false);

    /**
     * The undo stack's HISTORY IDS, oldest first — not its depth.
     *
     * `undo_depth` is a SIZE, and the stack has a cap (`history_limit`): once it
     * is full every push evicts the oldest and the depth never moves again. The
     * journey project shares one app instance, so by the time this test runs the
     * stack is at the cap and a "depth + 1" assertion measures nothing. Measured
     * here on 2026-09-21: depth was 100 before AND after a commit that really
     * did push an entry. `undo_seqs` exists for exactly this — the comment on it
     * in `undo_commands.rs` records the same confusion in the oracle.
     */
    const undoIds = async (): Promise<string[]> =>
      (await invoke<{ undoSeqs: string[] }>(appPage, "get_undo_state")).undoSeqs.map(String);
    const undoTop = async (): Promise<string | null> =>
      (await invoke<{ undoDescription: string | null }>(appPage, "get_undo_state")).undoDescription;
    const refreshTitle = async (): Promise<void> => {
      await appPage.evaluate(() => window.dispatchEvent(new CustomEvent("app:dirty-state-changed")));
      await appPage.waitForTimeout(250);
    };
    const titleStar = async (): Promise<boolean> => appPage.evaluate(() => / \* - Calcula$/.test(document.title));

    const undoBefore = await undoIds();
    await refreshTitle();
    expect(await titleStar(), "no asterisk on a freshly saved document").toBe(false);

    // Re-derived with the pane OPEN: a task pane takes horizontal space, so the
    // chart's page position is not what it was before the menu.
    await appPage.mouse.move(4, 4);
    await appPage.waitForTimeout(300);
    await settleGrid(appPage);
    box = await chartClientBox(appPage, chartId);
    const patch = sampleBox(await barCentre(appPage, chartId, box, TARGET));
    const paintedClean = await pixels(appPage, patch);

    // --- HOVER. A repaint and nothing else. --------------------------------
    const GREY = "#636363";
    const sw = swatch(appPage, "Fill colour", GREY);
    await expect(sw).toBeVisible();
    /** The product's own account of the preview: the pane flag and the store. */
    const previewStateNow = async (): Promise<{ previewing: boolean; overrides: string }> =>
      appPage.evaluate(
        async ({ chartId, pane, store }) => {
          const w = window as unknown as AppWindow;
          const p = (await w.__appImport!(pane)) as { paneIsPreviewing: () => boolean };
          const s = (await w.__appImport!(store)) as {
            getChartById: (id: string) => { spec: { dataPointOverrides?: unknown } } | null;
          };
          return {
            previewing: p.paneIsPreviewing(),
            overrides: JSON.stringify(s.getChartById(chartId)?.spec.dataPointOverrides ?? null),
          };
        },
        { chartId, pane: FORMAT_PANE, store: CHART_STORE },
      );

    // ---- PROBE: THE RAW POINTER MOVE, MEASURED AND NOT ASSERTED -----------
    //
    // This WAS the gesture under test, on the stated ground that a raw
    // `mouse.move` is what a hand makes and `locator.hover()` is not. On
    // 2026-09-22 it stopped delivering, and the reason is worth keeping in the
    // file rather than quietly swapping the line:
    //
    //   * `document.elementFromPoint` at the very coordinate answered
    //     `<BUTTON data-chart-swatch="#636363">` — the pointer is over the
    //     right control and the geometry is not in question.
    //   * React's `onMouseEnter` never fired: `paneIsPreviewing=false`, nothing
    //     in the store, nothing on screen. Reproduced on three consecutive runs.
    //   * `steps: 8` — eight intermediate moves along the path — changed
    //     nothing, so it is not a single-event coalescing problem.
    //   * `locator.hover()` on the SAME element, from the same parked position,
    //     previewed correctly every time, with the right colour AND the right
    //     identity key.
    //
    // So the PRODUCT is fine and the harness gesture is what broke. The probe
    // stays because it is the thing that regressed, printed on every run; the
    // assertions below moved onto the gesture that actually reaches the
    // product, which is still a real CDP pointer move and still previews on
    // `onMouseEnter`.
    const swBox = await sw.boundingBox();
    expect(swBox, "the swatch must have a box to move the pointer onto").not.toBeNull();
    const hoverPoint = { x: swBox!.x + swBox!.width / 2, y: swBox!.y + swBox!.height / 2 };
    await appPage.mouse.move(hoverPoint.x, hoverPoint.y, { steps: 8 });
    await appPage.waitForTimeout(500);
    const rawProbe = await previewStateNow();
    const underPointer = await appPage.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y) as HTMLElement | null;
      return {
        tag: el?.tagName ?? "none",
        swatch: el?.getAttribute("data-chart-swatch") ?? null,
        label: el?.getAttribute("aria-label") ?? null,
      };
    }, hoverPoint);
    console.log(
      `[chart-interaction] RAW mouse.move probe at (${Math.round(hoverPoint.x)},${Math.round(hoverPoint.y)}): over <${underPointer.tag}> swatch=${underPointer.swatch} label=${JSON.stringify(underPointer.label)} -> paneIsPreviewing=${rawProbe.previewing} storeOverrides=${rawProbe.overrides}`,
    );

    // ---- THE GESTURE UNDER TEST -------------------------------------------
    // Back to a clean pointer position first, so the hover below is a genuine
    // ENTER and not a no-op on an element the pointer is already on.
    await appPage.mouse.move(4, 4);
    await appPage.waitForTimeout(300);
    await settleGrid(appPage);
    const hoverStartedAt = Date.now();
    await sw.hover();

    // THE STORE IS READ IMMEDIATELY, BEFORE THE PAINT POLL, and the order is
    // the finding rather than a detail. Read AFTER the three-second poll below
    // — which is where it used to be read — the answer was
    // `paneIsPreviewing=false` with nothing in the store, and that reads as
    // "the hover handler never ran". Read here it is TRUE with the right
    // colour and the right identity key. So the preview IS armed by the
    // gesture, is never painted, and has lapsed again within three seconds.
    // Two different facts, and the old ordering could only ever report one of
    // them.
    await appPage.waitForTimeout(400);
    const previewState = await previewStateNow();
    console.log(
      `[chart-interaction] on hover (read IMMEDIATELY): paneIsPreviewing=${previewState.previewing} storeOverrides=${previewState.overrides}`,
    );

    // HOW LONG THE PREVIEW TAKES TO APPEAR, sampled rather than assumed.
    //
    // MEASURED 2026-09-21 and the reason this is a poll: across four runs of
    // this journey the preview painted in two of them and, in the other two,
    // had painted NOTHING after more than two seconds while the store already
    // held the previewed override and the pane reported it was previewing. A
    // single sample would turn that race into a coin-flip test; a bounded poll
    // that prints the latency turns it into a measurement, and a preview that
    // has not arrived within this budget is broken by any definition.
    const HOVER_PAINT_BUDGET_MS = 3_000;
    let hoverDiffFirstSeen = 0;
    let hoverLatencyMs = -1;
    while (Date.now() - hoverStartedAt < HOVER_PAINT_BUDGET_MS) {
      hoverDiffFirstSeen = diffCount(paintedClean, await pixels(appPage, patch));
      if (hoverDiffFirstSeen > 20) {
        hoverLatencyMs = Date.now() - hoverStartedAt;
        break;
      }
      await appPage.waitForTimeout(150);
    }
    console.log(
      `[chart-interaction] preview paint latency: ${hoverLatencyMs < 0 ? `NEVER within ${HOVER_PAINT_BUDGET_MS}ms` : `${hoverLatencyMs}ms`} (diff ${hoverDiffFirstSeen})`,
    );

    // AND WHAT IS LEFT OF IT AFTERWARDS, for the same reading taken late. The
    // pointer has not moved and nothing has been clicked, so a preview that is
    // no longer armed here has ended on its own.
    const previewStateLate = await previewStateNow();
    console.log(
      `[chart-interaction] on hover (read AFTER the paint poll): paneIsPreviewing=${previewStateLate.previewing} storeOverrides=${previewStateLate.overrides}`,
    );

    // The STORE half is asserted too, so a zero pixel diff can never be read as
    // "the hover handler never ran". If this passes and the paint above did
    // not, the missing step is the repaint and nothing else.
    expect
      .soft(previewState.overrides, "the hover must have written the previewed override into the store")
      .toContain(GREY);
    expect
      .soft(
        hoverLatencyMs,
        `POSITIVE CONTROL: the preview must actually appear on the chart within ${HOVER_PAINT_BUDGET_MS}ms — a preview nobody can see is the whole feature missing`,
      )
      .toBeGreaterThanOrEqual(0);
    expect.soft(await invoke<boolean>(appPage, "is_file_modified"), "a HOVER must not dirty the document").toBe(false);
    expect.soft(await undoIds(), "a HOVER must not push an undo entry").toEqual(undoBefore);
    await refreshTitle();
    expect.soft(await titleStar(), "and the title bar must show no asterisk").toBe(false);

    // --- MOUSE OUT. Every exit path restores. ------------------------------
    await appPage.mouse.move(4, 4);
    await appPage.waitForTimeout(700);
    await settleGrid(appPage);
    expect
      .soft(
        diffCount(paintedClean, await pixels(appPage, patch)),
        "leaving the swatch must put the chart back exactly as it was",
      )
      .toBe(0);
    expect.soft(await invoke<boolean>(appPage, "is_file_modified"), "still clean after the preview ended").toBe(false);
    expect.soft(await undoIds(), "still no undo entry").toEqual(undoBefore);

    // --- CLICK. Exactly one of each. ---------------------------------------
    await sw.click();
    await appPage.waitForTimeout(1500); // 300ms store debounce + the backend round trip
    await settleGrid(appPage);
    await appPage.mouse.move(4, 4);
    await appPage.waitForTimeout(300);

    expect(
      diffCount(paintedClean, await pixels(appPage, patch)),
      "the committed colour must be on screen",
    ).toBeGreaterThan(20);
    expect(await invoke<boolean>(appPage, "is_file_modified"), "a CLICK must dirty the document").toBe(true);
    // EXACTLY ONE NEW HISTORY ID, and it is on top. One debounced save, one
    // `update_chart`, one `record_chart_undo`. Compared by id rather than by
    // depth because the stack is at its cap here (see `undoIds`).
    const undoAfter = await undoIds();
    const added = undoAfter.filter((id) => !undoBefore.includes(id));
    console.log(
      `[chart-interaction] undo ids: ${undoBefore.length} before, ${undoAfter.length} after, added ${JSON.stringify(added)}, top=${JSON.stringify(await undoTop())}`,
    );
    expect(
      added,
      "a CLICK must push EXACTLY ONE undo entry — one debounced save, one update_chart, one record_chart_undo",
    ).toHaveLength(1);
    expect(undoAfter[undoAfter.length - 1], "and it must be the one on top").toBe(added[0]);
    expect(await undoTop(), "described as a chart edit").toBe("Edit chart");
    await refreshTitle();
    expect(await titleStar(), "and the title bar must show the asterisk").toBe(true);

    const overrides = (await rawSpec(appPage, chartId)).dataPointOverrides;
    expect(overrides, "one override, from the one click").toHaveLength(1);
    expect(String(overrides![0].color).toLowerCase()).toBe(GREY);

    // One undo puts it back, which is what "exactly one entry" means.
    await appPage.evaluate(async () => {
      const w = window as unknown as AppWindow;
      await w.__TAURI__.core.invoke("undo");
      window.dispatchEvent(new Event("charts:refresh"));
      window.dispatchEvent(new Event("grid:refresh"));
    });
    await appPage.waitForTimeout(1200);
    const afterUndo = (await rawSpec(appPage, chartId)).dataPointOverrides;
    expect(afterUndo ?? [], "one undo removes the whole colour change").toEqual([]);

    await removeChart(appPage, chartId);
    // Leave the workbook clean, as `dirty-flag.spec.ts` does: the journey
    // project shares one document and a dirty one can raise a close prompt.
    await flushChartSaves(appPage);
    await appPage.waitForTimeout(400);
    await invoke(appPage, "save_file", { path: CLEAN_BASELINE_FILE });
  });

  // ========================================================================
  // 9 — THE OWNER'S FIRST BUG, LIVE
  //
  //   "when I select an individual data point and give it a color I cannot
  //    select a color for the entire series after that"
  //
  // "The colour of a series" had TWO spellings and the Format pane wrote the
  // losing one. `spec.seriesColors[name]` is applied onto the parsed series by
  // `applySeriesColorOverrides`, so it is what the PAINTERS read;
  // `spec.series[i].color` is the BASE that overwrites. The pane's swatch wrote
  // the base, reported success, and changed nothing for any reader who had ever
  // set a series colour from the ribbon Design panel.
  //
  // This journey seeds that exact state — a name-keyed colour already present —
  // and then asserts BOTH halves of Excel's precedence: the series colour
  // reaches every bar that has no colour of its own, and the one bar that does
  // keeps it. Reset to Match Style on that bar rejoins it to the series.
  // ========================================================================

  test("OB-1: one bar's colour does not lock the SERIES colour — the series recolours around it and Reset rejoins it", async ({
    appPage,
    grid,
  }) => {
    test.setTimeout(420_000);
    await installAppImport(appPage);
    await seedData(grid);
    await appPage.waitForTimeout(400);

    const SEEDED_SERIES = "#a5a5a5";
    // The one series `baseSpec` declares. Spelled once and used as a COMPUTED
    // key below, because `seriesColors` is keyed by a series NAME — a piece of
    // the user's data, not an identifier.
    const SERIES_NAME = "Units";
    const chartId = await makeChart(
      appPage,
      baseSpec("bar", {
        title: "Series Colour Journey",
        // THE OWNER'S STARTING STATE, seeded rather than assumed: a name-keyed
        // series colour already in the spec.
        seriesColors: { [SERIES_NAME]: SEEDED_SERIES },
      }),
      "SeriesColourJourney",
    );

    const TARGET = 3; // Apr, the tallest bar
    const NEIGHBOUR = 1; // Feb

    // --- reach the bar, and open the pane the swatches live in --------------
    let box = await chartClientBox(appPage, chartId);
    for (let i = 0; i < 3; i++) {
      const at = await barCentre(appPage, chartId, box, TARGET);
      await slowClick(appPage, at.x, at.y);
    }
    expect(await ladder(appPage), "three clicks reach the individual bar").toMatchObject({
      level: "dataPoint",
      seriesIndex: 0,
      categoryIndex: TARGET,
    });
    let at = await barCentre(appPage, chartId, box, TARGET);
    await openChartMenu(appPage, at.x, at.y);
    await openFormatPaneFromMenu(appPage);
    await pickFormatTab(appPage, "Fill & Line");

    // RE-DERIVED WITH THE PANE OPEN, BEFORE ANY OF THE COORDINATES BELOW. A
    // task pane takes horizontal space, so the chart's page position is not
    // what it was when the menu was opened, and every click from here on —
    // including the parking click on the title — is computed from this box.
    await appPage.mouse.move(4, 4);
    await appPage.waitForTimeout(300);
    await settleGrid(appPage);
    box = await chartClientBox(appPage, chartId);

    // THE BASELINE IS TAKEN WITH THE SELECTION PARKED ON THE TITLE, and that is
    // not fussiness: `drawSelectionHighlights` paints a WHITE WASH over every
    // datum that is not selected whenever the rung is "series" or "dataPoint".
    // A bar's colour read while a sibling is selected is that bar's colour under
    // a veil, and two bars compared across different rungs are not comparable at
    // all — which is precisely what this journey has to compare. An "element"
    // rung paints a hairline box on the title and nothing on the plot.
    await parkSelectionOnTitle(appPage, chartId, box);
    const targetPatch = sampleBox(await barCentre(appPage, chartId, box, TARGET), 5);
    const neighbourPatch = sampleBox(await barCentre(appPage, chartId, box, NEIGHBOUR), 5);
    const targetSeeded = await pixels(appPage, targetPatch);
    const neighbourSeeded = await pixels(appPage, neighbourPatch);
    console.log(
      `[chart-interaction] OB-1 seeded: target=${rgbText(averageRgb(targetSeeded))} neighbour=${rgbText(averageRgb(neighbourSeeded))}`,
    );
    expect(
      channelGap(averageRgb(targetSeeded), averageRgb(neighbourSeeded)),
      "POSITIVE CONTROL: with only a seeded SERIES colour, the two bars start identical",
    ).toBeLessThanOrEqual(12);

    // --- the point gets a colour of its own --------------------------------
    for (let i = 0; i < 2; i++) {
      const p = await barCentre(appPage, chartId, box, TARGET);
      await slowClick(appPage, p.x, p.y);
    }
    expect(await ladder(appPage), "two clicks from the title rung reach the bar again").toMatchObject({
      level: "dataPoint",
      seriesIndex: 0,
      categoryIndex: TARGET,
    });
    const ORANGE = "#ed7d31";
    await swatch(appPage, "Fill colour", ORANGE).click();
    await appPage.waitForTimeout(1200);
    await settleGrid(appPage);

    const withPoint = await rawSpec(appPage, chartId);
    expect(withPoint.dataPointOverrides, "the point carries exactly one override").toHaveLength(1);
    expect(String(withPoint.dataPointOverrides![0].color).toLowerCase()).toBe(ORANGE);

    await parkSelectionOnTitle(appPage, chartId, box);
    const targetOrange = await pixels(appPage, targetPatch);
    const neighbourStillSeeded = await pixels(appPage, neighbourPatch);
    console.log(
      `[chart-interaction] OB-1 after the POINT colour: target=${rgbText(averageRgb(targetOrange))} neighbour=${rgbText(averageRgb(neighbourStillSeeded))}`,
    );
    expect(diffCount(targetSeeded, targetOrange), "the clicked bar took the colour").toBeGreaterThan(20);
    expect(diffCount(neighbourSeeded, neighbourStillSeeded), "and no other bar moved").toBe(0);

    // --- NOW THE WHOLE SERIES. This is the sentence that was broken. --------
    at = await barCentre(appPage, chartId, box, NEIGHBOUR);
    await slowClick(appPage, at.x, at.y);
    expect(
      await ladder(appPage),
      "one click from the title rung enters the datum ladder at the SERIES",
    ).toMatchObject({ level: "series", seriesIndex: 0 });
    await expect(
      appPage.locator('[data-testid="chart-format-pane"]'),
      "the pane is still open and retargets on the selection change",
    ).toBeVisible();
    expect(await paneSubject(appPage), "and it now names the SERIES").toContain('Series 1 "Units"');

    // THE READ HALF OF THE DEFECT. Measured in jsdom against the old code: with
    // `seriesColors` seeded, this control showed the `#4472c4` fallback, because
    // it read the index-keyed base instead of the name-keyed colour the chart is
    // actually painted in.
    expect(
      await paneColorValue(appPage, "Colour"),
      "the pane must SHOW the colour the painters use, not the base they overwrite",
    ).toBe(SEEDED_SERIES);

    const GREEN = "#70ad47";
    await paneSwatch(appPage, "Colour", GREEN).click();
    await appPage.waitForTimeout(1400);
    await settleGrid(appPage);

    // THE WRITE HALF.
    const afterSeries = await rawSpec(appPage, chartId);
    expect(
      (afterSeries.seriesColors as Record<string, string> | undefined)?.[SERIES_NAME],
      "THE REGRESSION THAT MUST NEVER COME BACK: the pane writes the spelling the painters read",
    ).toBe(GREEN);
    expect(
      (afterSeries.series as Array<{ color?: string | null }> | undefined)?.[0]?.color,
      "and leaves the index-keyed base alone — writing it is what made the swatch a no-op",
    ).toBe("#4472C4");
    expect(
      afterSeries.dataPointOverrides,
      "the point's own colour is untouched by a SERIES colour",
    ).toHaveLength(1);

    await parkSelectionOnTitle(appPage, chartId, box);
    const targetAfterSeries = await pixels(appPage, targetPatch);
    const neighbourGreen = await pixels(appPage, neighbourPatch);
    console.log(
      `[chart-interaction] OB-1 after the SERIES colour: target=${rgbText(averageRgb(targetAfterSeries))} neighbour=${rgbText(averageRgb(neighbourGreen))}`,
    );
    expect(
      diffCount(neighbourStillSeeded, neighbourGreen),
      "THE OWNER'S SENTENCE: the series colour must actually reach the bars that have none of their own",
    ).toBeGreaterThan(20);
    expect(
      diffCount(targetOrange, targetAfterSeries),
      "EXCEL'S PRECEDENCE: the bar with its own colour keeps it when the series is recoloured",
    ).toBe(0);
    expect(
      channelGap(averageRgb(targetAfterSeries), averageRgb(neighbourGreen)),
      "so the two bars are now genuinely different colours",
    ).toBeGreaterThan(30);

    // --- RESET TO MATCH STYLE on the POINT ---------------------------------
    for (let i = 0; i < 2; i++) {
      const p = await barCentre(appPage, chartId, box, TARGET);
      await slowClick(appPage, p.x, p.y);
    }
    expect(await ladder(appPage), "back onto the coloured bar").toMatchObject({
      level: "dataPoint",
      seriesIndex: 0,
      categoryIndex: TARGET,
    });
    const reset = appPage.locator('[data-testid="chart-reset-to-match-style"]');
    await expect(reset, "the reset control is part of the pane header").toBeVisible();
    expect(
      await reset.getAttribute("data-reset-scope"),
      "and it is scoped to THIS point, not the series and not the chart",
    ).toBe("dataPoint");
    expect(await reset.isEnabled(), "live, because this point has something manual on it").toBe(true);
    await reset.click();
    await appPage.waitForTimeout(1200);
    await settleGrid(appPage);

    const afterReset = await rawSpec(appPage, chartId);
    expect(afterReset.dataPointOverrides ?? [], "the point's own colour is gone").toEqual([]);
    expect(
      (afterReset.seriesColors as Record<string, string> | undefined)?.[SERIES_NAME],
      "and a POINT reset is not a SERIES reset — the series colour stands",
    ).toBe(GREEN);

    await parkSelectionOnTitle(appPage, chartId, box);
    const targetRejoined = averageRgb(await pixels(appPage, targetPatch));
    const neighbourNow = averageRgb(await pixels(appPage, neighbourPatch));
    console.log(
      `[chart-interaction] OB-1 after RESET: target=${rgbText(targetRejoined)} neighbour=${rgbText(neighbourNow)}`,
    );
    expect(
      channelGap(targetRejoined, neighbourNow),
      "THE POINT REJOINS THE SERIES COLOUR — a diff against its own past would only say it stopped being orange",
    ).toBeLessThanOrEqual(12);

    await removeChart(appPage, chartId);
  });

  // ========================================================================
  // 10 + 11 — THE OWNER'S SECOND BUG, LIVE
  //
  //   "When I add a data table to be shown in the chart it overlaps the x axis
  //    labels."
  //
  // The bottom band was computed in TWO places: `computeCartesianLayout`
  // reserved a tick-label strip and an axis-title strip knowing nothing about
  // the table, and `dispatchComputeLayout` then folded the table's height into
  // `margin.bottom` afterwards. The band was big enough overall and nothing
  // re-apportioned it, so the tick labels and the title were still painted at
  // their original offsets — inside the table.
  //
  // THE DECISIVE PROOF IS A PIXEL IDENTITY, not a rect comparison. With a data
  // table shown on a category-X mark, `specForMarkPaint` takes the tick labels
  // away from the painters; so flipping `xAxis.showLabels` must change NOTHING
  // on screen. Under the defect it changed six large labels. The layout is
  // identical in both states (`xTickLabelBandHeight` is zero either way), so
  // there is no second explanation for a difference.
  // ========================================================================

  test("OB-2: with a data table the category labels are painted ONCE, and the x-axis title sits BELOW the table", async ({
    appPage,
    grid,
  }) => {
    test.setTimeout(420_000);
    await installAppImport(appPage);
    await seedData(grid);
    await appPage.waitForTimeout(400);

    const chartId = await makeChart(
      appPage,
      baseSpec("bar", {
        title: "Data Table Band Journey",
        xAxis: { title: "Month" },
        yAxis: { title: "Units" },
        dataTable: { enabled: true },
      }),
      "DataTableBandJourney",
    );

    // --- THE BAND, AS THE LAYOUT RECORDS IT --------------------------------
    const view = await layoutView(appPage, chartId);
    const els = view.elements;
    expect(els, "the chart must have painted element rects").not.toBeNull();
    console.log(
      `[chart-interaction] OB-2 band: plot=${JSON.stringify(view.plotArea)} table=${JSON.stringify(els!.dataTable)} xTitle=${JSON.stringify(els!.xAxisTitle)} xBand=${JSON.stringify(els!.xAxisBand)}`,
    );

    expect(els!.dataTable, "a data table that is enabled must record a rect to be hit-tested at").toBeTruthy();
    expect(
      els!.xAxisBand,
      "NO TICK-LABEL BAND: the table's header row IS the category labelling, so a hit-testable strip there would select an axis the reader cannot see",
    ).toBeUndefined();
    // [plot] [tick labels: zero] [table] — `DATA_TABLE_TOP_GAP` is 4.
    expect(
      els!.dataTable!.y,
      "the table hangs directly under the plot, with only the 4px gap",
    ).toBeCloseTo(view.plotArea.y + view.plotArea.height + 4, 3);
    expect(
      els!.xAxisTitle,
      "the x-axis title is still drawn — it is the thing that used to land IN the table",
    ).toBeTruthy();
    expect(
      els!.xAxisTitle!.y,
      "and it now starts BELOW the table's bottom edge",
    ).toBeGreaterThanOrEqual(els!.dataTable!.y + els!.dataTable!.height);

    // --- THE PIXEL IDENTITY ------------------------------------------------
    // Taken with the chart UNSELECTED, so no selection border or datum wash is
    // in either capture.
    await appPage.mouse.move(4, 4);
    await appPage.waitForTimeout(300);
    await settleGrid(appPage);
    const clip = await chartClientBox(appPage, chartId);
    const labelsOn = await pixels(appPage, clip);
    await patchSpecLive(appPage, chartId, { xAxis: { showLabels: false } });
    // A NO-OP PATCH WOULD PASS THE IDENTITY BELOW. The spec is read back so an
    // unchanged chart can never be mistaken for a chart that changed nothing;
    // that the same call also REPAINTS is what the positive control proves.
    expect(
      (await rawSpec(appPage, chartId)).xAxis as { showLabels?: boolean },
      "the toggle must have reached the spec, or the identity below measures nothing",
    ).toMatchObject({ showLabels: false });
    await appPage.mouse.move(4, 4);
    await appPage.waitForTimeout(300);
    const labelsOff = await pixels(appPage, clip);
    const tableDiff = diffCount(labelsOn, labelsOff);
    console.log(`[chart-interaction] OB-2 showLabels toggle WITH a table: ${tableDiff} px changed`);
    expect(
      tableDiff,
      "THE OWNER'S SCREENSHOT: with a table shown, the tick labels belong to the table alone — toggling the axis' own labels must change nothing at all",
    ).toBe(0);

    // --- THE POSITIVE CONTROL: the toggle has teeth ------------------------
    // Without a table, `showLabels` is the difference between six painted
    // labels and none. If this half did not move, the identity above would be
    // a test of a toggle that does nothing.
    await patchSpecLive(appPage, chartId, {
      dataTable: { enabled: false },
      xAxis: { showLabels: true },
    });
    await appPage.mouse.move(4, 4);
    await appPage.waitForTimeout(300);
    const noTableLabelsOn = await pixels(appPage, clip);
    await patchSpecLive(appPage, chartId, { xAxis: { showLabels: false } });
    await appPage.mouse.move(4, 4);
    await appPage.waitForTimeout(300);
    const noTableLabelsOff = await pixels(appPage, clip);
    const bareDiff = diffCount(noTableLabelsOn, noTableLabelsOff);
    console.log(`[chart-interaction] OB-2 showLabels toggle with NO table: ${bareDiff} px changed`);
    expect(
      bareDiff,
      "POSITIVE CONTROL: with no table, hiding the tick labels must visibly change the chart",
    ).toBeGreaterThan(200);

    // Back to the state the rest of this journey is about.
    await patchSpecLive(appPage, chartId, {
      dataTable: { enabled: true },
      xAxis: { showLabels: true },
    });

    // --- THE TITLE IS SELECTABLE WHERE IT IS PAINTED -----------------------
    const box = await chartClientBox(appPage, chartId);
    const after = await layoutView(appPage, chartId);
    const xTitle = after.elements?.xAxisTitle;
    expect(xTitle, "the x-axis title rect must have come back with the table").toBeTruthy();
    const titleAt = {
      x: box.x + xTitle!.x + xTitle!.width / 2,
      y: box.y + xTitle!.y + xTitle!.height / 2,
    };
    expect(
      await selectByTwoClicks(appPage, titleAt),
      "clicking the x-axis title where it is PAINTED must select it — a title you can see and cannot click is the drift this rect exists to prevent",
    ).toMatchObject({ level: "element", elementId: "xAxisTitle" });

    // --- AND THE TABLE ITSELF IS AN OBJECT ---------------------------------
    const table = after.elements!.dataTable!;
    const tableAt = { x: box.x + table.x + table.width / 2, y: box.y + table.y + table.height / 2 };
    await slowClick(appPage, tableAt.x, tableAt.y);
    expect(await ladder(appPage), "the data table is a rung of its own").toMatchObject({
      level: "element",
      elementId: "dataTable",
    });

    // --- GRIDLINES ARE STILL REFUSED, ON PURPOSE ---------------------------
    // `CHART_ELEMENT_IDS` has no `gridlines` member: nothing records where a
    // gridline is drawn, and a branch that answered "anywhere in the plot area"
    // would steal every plot-area click. The live consequence, asserted rather
    // than described: a click on the plot background — which is where the
    // gridlines are — selects the PLOT AREA.
    const bars = (await hitGeometry(appPage, chartId))?.rects ?? [];
    const plotPoint = { x: after.plotArea.x + 4, y: after.plotArea.y + 6 };
    const insideABar = bars.some(
      (b) =>
        plotPoint.x >= b.x && plotPoint.x <= b.x + b.width && plotPoint.y >= b.y && plotPoint.y <= b.y + b.height,
    );
    expect(insideABar, "the gridline probe must land on plot BACKGROUND, not on a bar").toBe(false);
    await slowClick(appPage, box.x + plotPoint.x, box.y + plotPoint.y);
    expect(
      await ladder(appPage),
      "a click where the gridlines are selects the PLOT AREA — gridlines have no id because they have no producer",
    ).toMatchObject({ level: "element", elementId: "plotArea" });

    await removeChart(appPage, chartId);
  });

  test("OB-2: a HORIZONTAL bar chart keeps its value tick labels and stacks the table below them", async ({
    appPage,
    grid,
  }) => {
    test.setTimeout(300_000);
    await installAppImport(appPage);
    await seedData(grid);
    await appPage.waitForTimeout(400);

    // A horizontal bar's x labels are VALUES, not the categories the table's
    // header row repeats, so the table does NOT take them over
    // (`VALUE_X_MARKS`). The band therefore has three occupants stacked in
    // order — [plot] [value labels] [table] [axis title] — and the pixel
    // identity used for the vertical case does not apply here BY DESIGN: the
    // labels really are painted.
    const chartId = await makeChart(
      appPage,
      baseSpec("horizontalBar", {
        title: "Horizontal Table Journey",
        xAxis: { title: "Units Sold" },
        dataTable: { enabled: true },
      }),
      "HorizontalTableJourney",
    );

    const view = await layoutView(appPage, chartId);
    const els = view.elements!;
    console.log(
      `[chart-interaction] OB-2 horizontal: plot=${JSON.stringify(view.plotArea)} xBand=${JSON.stringify(els.xAxisBand)} table=${JSON.stringify(els.dataTable)} xTitle=${JSON.stringify(els.xAxisTitle)}`,
    );

    expect(
      els.xAxisBand,
      "the VALUE tick labels keep their band — the table's header row does not repeat them",
    ).toBeTruthy();
    expect(els.dataTable, "and the table is still drawn").toBeTruthy();
    expect(
      els.dataTable!.y,
      "the table starts below the label band, plus the 4px gap — one band, apportioned once",
    ).toBeCloseTo(els.xAxisBand!.y + els.xAxisBand!.height + 4, 3);
    expect(els.xAxisBand!.y, "which itself starts at the plot's bottom edge").toBeCloseTo(
      view.plotArea.y + view.plotArea.height,
      3,
    );
    expect(els.xAxisTitle, "the axis title is drawn").toBeTruthy();
    expect(els.xAxisTitle!.y, "below the table, as in the vertical case").toBeGreaterThanOrEqual(
      els.dataTable!.y + els.dataTable!.height,
    );

    // The label band and the table are two DIFFERENT objects, and each answers
    // for its own pixels.
    const box = await chartClientBox(appPage, chartId);
    const bandAt = {
      x: box.x + els.xAxisBand!.x + els.xAxisBand!.width / 2,
      y: box.y + els.xAxisBand!.y + els.xAxisBand!.height / 2,
    };
    expect(
      await selectByTwoClicks(appPage, bandAt),
      "the value-label band still selects the X AXIS",
    ).toMatchObject({ level: "axis", axisType: "x" });

    const tableAt = {
      x: box.x + els.dataTable!.x + els.dataTable!.width / 2,
      y: box.y + els.dataTable!.y + els.dataTable!.height / 2,
    };
    await slowClick(appPage, tableAt.x, tableAt.y);
    expect(await ladder(appPage), "and the strip below it is the TABLE").toMatchObject({
      level: "element",
      elementId: "dataTable",
    });

    await removeChart(appPage, chartId);
  });

  // ========================================================================
  // 12-15 — the in-plot furniture became first-class (CI-12)
  //
  // All four were hit-testable, named by @api and recorded as rects by their
  // painters for a whole wave, and the ladder still collapsed every one of them
  // to `{ level: "chart" }`. Each of these four journeys does the same four
  // things with a real pointer: SELECT it, watch the pane RETARGET, FORMAT it,
  // and DELETE it — and each asserts that the chart survived the Delete and
  // that the Delete never reached the cells.
  // ========================================================================

  test("a TRENDLINE is a rung: click it, format it, delete it — and the chart lives", async ({
    appPage,
    grid,
  }) => {
    test.setTimeout(300_000);
    await installAppImport(appPage);
    await seedData(grid);
    await seedSentinel(appPage, grid);

    const chartId = await makeChart(
      appPage,
      baseSpec("line", {
        title: "Trendline Journey",
        trendlines: [{ type: "linear", seriesIndex: 0 }],
      }),
      "TrendlineJourney",
    );

    /**
     * A point ON the trendline that no datum marker can claim.
     *
     * A datum beats furniture — settled precedent — so a click on the stretch of
     * trendline that runs through a marker selects the MARKER, and a test that
     * clicked there would read as "the trendline is not selectable". The
     * recorded polyline has one vertex per category, at the same x as the
     * markers, so the midpoint of a segment is half a category step away from
     * both of its neighbours.
     */
    const trendlinePoint = async (): Promise<{ x: number; y: number }> => {
      const v = await layoutView(appPage, chartId);
      const trace = v.elements?.trendlines?.[0];
      expect(trace, "the trendline must have been PAINTED and recorded, or there is nothing to click").toBeTruthy();
      const markers = (await hitGeometry(appPage, chartId))?.markers ?? [];
      for (let i = 0; i + 1 < trace!.points.length; i++) {
        const mid = {
          x: (trace!.points[i].x + trace!.points[i + 1].x) / 2,
          y: (trace!.points[i].y + trace!.points[i + 1].y) / 2,
        };
        if (nearestMarkerDistance(markers, mid) >= 16) return mid;
      }
      throw new Error("no stretch of the trendline is clear of a datum marker");
    };

    let box = await chartClientBox(appPage, chartId);
    let local = await trendlinePoint();
    let at = { x: box.x + local.x, y: box.y + local.y };
    console.log(`[chart-interaction] trendline click at chart-local ${JSON.stringify(local)}`);

    expect(
      await selectByTwoClicks(appPage, at),
      "clicking a trendline used to give you the CHART — it is its own rung now, and it carries its ordinal",
    ).toMatchObject({ level: "element", elementId: "trendline", seriesIndex: 0, trendlineIndex: 0 });

    await openChartMenu(appPage, at.x, at.y);
    expect(await formatRowLabel(appPage), "and the menu names it").toBe("Format Trendline...");
    await openFormatPaneFromMenu(appPage);
    expect(await paneSubject(appPage), "the pane retargets onto the trendline, with its ordinal").toContain(
      "Trendline 1",
    );
    await pickFormatTab(appPage, "Options");

    await appPage.locator('[data-testid="chart-format-pane"] input[aria-label="Display R-squared value"]').click();
    await appPage.waitForTimeout(900);
    await settleGrid(appPage);
    const formatted = await rawSpec(appPage, chartId);
    expect(
      (formatted.trendlines as Array<{ showRSquared?: boolean }> | undefined)?.[0]?.showRSquared,
      "the pane formats the trendline it targeted",
    ).toBe(true);

    // The pane took horizontal space, so the chart moved: everything below is
    // re-derived rather than reused.
    box = await chartClientBox(appPage, chartId);
    local = await trendlinePoint();
    at = { x: box.x + local.x, y: box.y + local.y };
    await deleteSelectedRung(appPage, at, "trendline");

    const afterDelete = await rawSpec(appPage, chartId);
    expect(afterDelete.trendlines ?? null, "Delete removes the trendline").toBeNull();
    expect(await chartExists(appPage, chartId), "and NOT the chart").toBe(true);
    expect(
      (await layoutView(appPage, chartId)).elements?.trendlines ?? [],
      "and it stops being painted, so it stops being a rung",
    ).toEqual([]);
    expect(await grid.getCellDisplayValue("A1"), "and the cells underneath are untouched").toBe(SENTINEL);

    await removeChart(appPage, chartId);
    await grid.setCellValueDirect("A1", "");
  });

  test("a series' ERROR BARS are a rung: per SERIES and never per point, formattable and deletable", async ({
    appPage,
    grid,
  }) => {
    test.setTimeout(300_000);
    await installAppImport(appPage);
    await seedData(grid);
    await seedSentinel(appPage, grid);

    const chartId = await makeChart(
      appPage,
      baseSpec("bar", {
        title: "Error Bar Journey",
        // AN EXPLICIT SCALE CEILING, and it is load-bearing rather than tidy.
        // The tallest value is 60 and a +25% stem reaches 75; on an auto scale
        // whose maximum IS 60 that stem is drawn off the top of the plot and
        // the rect recorded for it has a NEGATIVE y. Measured 2026-09-22: the
        // click then landed above the chart's own rectangle, which is a click
        // on the GRID, which DESELECTS the chart — the ladder came back
        // `{ level: "none" }` and read like "error bars are not selectable".
        yAxis: { max: 100 },
        // "plus" keeps every stem ABOVE its bar, so the click target is not
        // inside a datum — a datum beats furniture.
        markOptions: { errorBars: { enabled: true, type: "percentage", value: 25, direction: "plus" } },
      }),
      "ErrorBarJourney",
    );

    /** The top cap of the TALLEST drawn error bar, in chart-local space. */
    const errorBarCap = async (): Promise<{ x: number; y: number }> => {
      const v = await layoutView(appPage, chartId);
      const bars = v.elements?.errorBars ?? [];
      expect(bars.length, "error bars must have been drawn and recorded").toBeGreaterThan(0);
      const tallest = bars.reduce((a, b) => (b.rect.height > a.rect.height ? b : a));
      // The recorded rect is the stem's TRUE extent and is not clipped to the
      // plot, so this guard is what keeps a scale change from silently turning
      // the probe into a click on the grid. See the `yAxis.max` note above.
      expect(
        tallest.rect.y,
        "the error bar must be drawn inside the plot, not off the top of the scale",
      ).toBeGreaterThanOrEqual(v.plotArea.y - 1);
      const point = { x: tallest.rect.x + tallest.rect.width / 2, y: Math.max(tallest.rect.y, v.plotArea.y) + 2 };
      const rects = (await hitGeometry(appPage, chartId))?.rects ?? [];
      const inABar = rects.some(
        (r) => point.x >= r.x && point.x <= r.x + r.width && point.y >= r.y && point.y <= r.y + r.height,
      );
      expect(inABar, "the error-bar probe must land above the bar, not inside it").toBe(false);
      return point;
    };

    let box = await chartClientBox(appPage, chartId);
    let local = await errorBarCap();
    let at = { x: box.x + local.x, y: box.y + local.y };
    console.log(`[chart-interaction] error-bar click at chart-local ${JSON.stringify(local)}`);

    const rung = await selectByTwoClicks(appPage, at);
    expect(rung, "an error bar answers its SERIES").toMatchObject({
      level: "element",
      elementId: "errorBars",
      seriesIndex: 0,
    });
    expect(
      rung.categoryIndex,
      "and carries NO point index — Excel has no per-point error bar, and a stray index would make two clicks on one object compare unequal",
    ).toBeUndefined();

    await openChartMenu(appPage, at.x, at.y);
    expect(await formatRowLabel(appPage), "plural, because the object IS the whole set").toBe(
      "Format Error Bars...",
    );
    await openFormatPaneFromMenu(appPage);
    expect(await paneSubject(appPage)).toContain("Error Bars");
    await pickFormatTab(appPage, "Options");

    await appPage.locator('[data-testid="chart-format-pane"] input[aria-label="Value"]').fill("40");
    await appPage.waitForTimeout(900);
    await settleGrid(appPage);
    const formatted = await rawSpec(appPage, chartId);
    expect(
      (formatted.markOptions as { errorBars?: { value?: number } } | undefined)?.errorBars?.value,
      "the pane writes through the one mark-aware accessor",
    ).toBe(40);

    box = await chartClientBox(appPage, chartId);
    local = await errorBarCap();
    at = { x: box.x + local.x, y: box.y + local.y };
    await deleteSelectedRung(appPage, at, "error bars");

    const afterDelete = await rawSpec(appPage, chartId);
    expect(
      (afterDelete.markOptions as { errorBars?: { enabled?: boolean } } | undefined)?.errorBars?.enabled,
      "the last series' bars going turns error bars off, rather than leaving an empty filter",
    ).toBe(false);
    expect(await chartExists(appPage, chartId), "and the chart lives").toBe(true);
    expect(
      (await layoutView(appPage, chartId)).elements?.errorBars ?? [],
      "nothing is drawn for them any more",
    ).toEqual([]);
    expect(await grid.getCellDisplayValue("A1"), "and the cells are untouched").toBe(SENTINEL);

    await removeChart(appPage, chartId);
    await grid.setCellValueDirect("A1", "");
  });

  test("ONE DATA LABEL is a rung: per point, formattable, and Delete peels off that label alone", async ({
    appPage,
    grid,
  }) => {
    test.setTimeout(300_000);
    await installAppImport(appPage);
    await seedData(grid);
    await seedSentinel(appPage, grid);

    const TARGET = 3; // Apr
    const chartId = await makeChart(
      appPage,
      baseSpec("bar", {
        title: "Data Label Journey",
        // THE SAME SCALE CEILING, for a different reason that has the same
        // shape. `drawBarLabels` places an "above" label at `rect.y - 4` and
        // then CLAMPS it to `plotArea.y + fontSize` — so the label of a bar
        // that reaches the top of the scale is pushed back INSIDE its own bar,
        // where a datum beats furniture and the label cannot be clicked at all.
        // Measured 2026-09-22 on an auto scale, where Apr's 60 IS the maximum.
        // A ceiling of 100 leaves every label above its bar, which is where a
        // reader sees them.
        yAxis: { max: 100 },
        dataLabels: { enabled: true, position: "above" },
      }),
      "DataLabelJourney",
    );

    /** The centre of ONE painted label, checked to be clear of every bar. */
    const labelCentre = async (): Promise<{ x: number; y: number }> => {
      const v = await layoutView(appPage, chartId);
      const found = (v.elements?.dataLabels ?? []).find(
        (l) => l.seriesIndex === 0 && l.pointIndex === TARGET,
      );
      expect(found, `no data label was recorded for point ${TARGET}`).toBeTruthy();
      const point = { x: found!.rect.x + found!.rect.width / 2, y: found!.rect.y + found!.rect.height / 2 };
      const rects = (await hitGeometry(appPage, chartId))?.rects ?? [];
      const inABar = rects.some(
        (r) => point.x >= r.x && point.x <= r.x + r.width && point.y >= r.y && point.y <= r.y + r.height,
      );
      expect(inABar, "the label probe must land above the bar, not inside it").toBe(false);
      return point;
    };

    let box = await chartClientBox(appPage, chartId);
    let local = await labelCentre();
    let at = { x: box.x + local.x, y: box.y + local.y };
    console.log(`[chart-interaction] data-label click at chart-local ${JSON.stringify(local)}`);

    expect(await selectByTwoClicks(appPage, at), "a data label carries BOTH indices — it is per point").toMatchObject({
      level: "element",
      elementId: "dataLabel",
      seriesIndex: 0,
      categoryIndex: TARGET,
    });

    await openChartMenu(appPage, at.x, at.y);
    expect(await formatRowLabel(appPage), "singular, because there is one per point").toBe(
      "Format Data Label...",
    );
    await openFormatPaneFromMenu(appPage);
    expect(await paneSubject(appPage), "and the pane names the point it belongs to").toContain(
      `Point ${TARGET + 1} "${MONTHS[TARGET]}" Data Label`,
    );
    await pickFormatTab(appPage, "Options");

    // The number format is CHART-WIDE and the section title says so — the split
    // of scope is stated on screen rather than implied. Removing THIS label is
    // the per-point act, and that is what the Delete below exercises.
    await appPage.locator('[data-testid="chart-format-pane"] input[aria-label="Number format"]').fill("0.0");
    await appPage.waitForTimeout(900);
    await settleGrid(appPage);
    expect(
      (await rawSpec(appPage, chartId)).dataLabels as { format?: string } | undefined,
    ).toMatchObject({ format: "0.0" });

    box = await chartClientBox(appPage, chartId);
    local = await labelCentre();
    at = { x: box.x + local.x, y: box.y + local.y };
    await deleteSelectedRung(appPage, at, "data label");

    const afterDelete = (await rawSpec(appPage, chartId)).dataLabels as
      | { enabled?: boolean; hiddenPoints?: Array<{ seriesIndex: number; pointIndex: number }> }
      | undefined;
    expect(
      afterDelete?.hiddenPoints,
      "THAT point's label is suppressed — the coarser act (all of the series') is not the only act",
    ).toEqual([{ seriesIndex: 0, pointIndex: TARGET }]);
    expect(afterDelete?.enabled, "and every other label stays ON").toBe(true);
    expect(await chartExists(appPage, chartId), "and the chart lives").toBe(true);
    const stillDrawn = (await layoutView(appPage, chartId)).elements?.dataLabels ?? [];
    expect(
      stillDrawn.some((l) => l.seriesIndex === 0 && l.pointIndex === TARGET),
      "the deleted label stops being painted",
    ).toBe(false);
    expect(stillDrawn.length, "and its siblings are still there").toBeGreaterThan(0);
    expect(await grid.getCellDisplayValue("A1"), "and the cells are untouched").toBe(SENTINEL);

    await removeChart(appPage, chartId);
    await grid.setCellValueDirect("A1", "");
  });

  test("the DATA TABLE is a rung: one object, one section, one Delete", async ({ appPage, grid }) => {
    test.setTimeout(300_000);
    await installAppImport(appPage);
    await seedData(grid);
    await seedSentinel(appPage, grid);

    // A SHALLOWER CHART, PLACED HIGH, and this is a WORKAROUND for a product
    // defect rather than a preference — see the handoff note. A data table is
    // the LOWEST thing on a chart, and the context menu opened over it is
    // clamped with `estimatedHeight = 40 + (rows + 1) * 26`
    // (components/ChartContextMenu.tsx). At the default placement (y 40, height
    // 340) in a 1280x800 window the estimate came up short and the menu's LAST
    // row — which is always "Format <element>..." — rendered BELOW the viewport:
    // visible, enabled and stable, and unclickable (measured 2026-09-22,
    // `locator.click` timed out for 30s on "element is outside of the
    // viewport"). Raising the chart puts the menu back on screen; the menu's own
    // geometry is printed below so a re-run says how much room there was.
    const chartId = await makeChart(
      appPage,
      baseSpec("bar", {
        title: "Data Table Object Journey",
        xAxis: { title: "Month" },
        dataTable: { enabled: true },
      }),
      "DataTableObjectJourney",
      { x: 70, y: 8, width: 540, height: 240 },
    );

    /**
     * A point in the table's TOP row rather than its centre: the same object,
     * ~20px higher up the window, which is 20px more room for the menu.
     */
    const tableProbe = async (): Promise<{ x: number; y: number }> => {
      const v = await layoutView(appPage, chartId);
      const t = v.elements?.dataTable;
      expect(t, "the data table must be drawn to be clicked").toBeTruthy();
      return { x: t!.x + t!.width / 2, y: t!.y + Math.min(8, t!.height / 2) };
    };

    let box = await chartClientBox(appPage, chartId);
    let local = await tableProbe();
    let at = { x: box.x + local.x, y: box.y + local.y };

    expect(await selectByTwoClicks(appPage, at), "the table carries no indices — there is one of it").toMatchObject({
      level: "element",
      elementId: "dataTable",
    });

    await openChartMenu(appPage, at.x, at.y);
    expect(await formatRowLabel(appPage)).toBe("Format Data Table...");
    const menuGeometry = await appPage.evaluate(() => {
      const el = document.querySelector("[data-chart-context-menu]");
      const r = el?.getBoundingClientRect();
      return { top: r?.top ?? -1, bottom: r?.bottom ?? -1, viewport: window.innerHeight };
    });
    console.log(
      `[chart-interaction] data-table menu: top=${Math.round(menuGeometry.top)} bottom=${Math.round(menuGeometry.bottom)} viewportHeight=${menuGeometry.viewport}`,
    );
    expect(
      menuGeometry.bottom,
      "THE MENU MUST FIT: its last row is the Format row, and a row below the viewport is a row nobody can click",
    ).toBeLessThanOrEqual(menuGeometry.viewport);
    await openFormatPaneFromMenu(appPage);
    expect(await paneSubject(appPage)).toContain("Data Table");
    // ONE TAB, so no tablist: `DataTableOptions` styles no text, and a tab with
    // no fields is the dead tab this pane's header forbids.
    expect(
      await appPage.locator('[data-testid="chart-format-pane"] [role="tablist"]').count(),
      "a single-tab subject shows no tab strip",
    ).toBe(0);

    await appPage.locator('[data-testid="chart-format-pane"] input[aria-label="Vertical borders"]').click();
    await appPage.waitForTimeout(900);
    await settleGrid(appPage);
    expect(
      (await rawSpec(appPage, chartId)).dataTable as { showVerticalBorder?: boolean } | undefined,
    ).toMatchObject({ showVerticalBorder: false });

    box = await chartClientBox(appPage, chartId);
    local = await tableProbe();
    at = { x: box.x + local.x, y: box.y + local.y };
    await deleteSelectedRung(appPage, at, "data table");

    const afterDelete = (await rawSpec(appPage, chartId)).dataTable as
      | { enabled?: boolean; showVerticalBorder?: boolean }
      | undefined;
    expect(afterDelete?.enabled, "Delete turns the table off").toBe(false);
    expect(
      afterDelete?.showVerticalBorder,
      "and keeps the rest of its options for when it comes back",
    ).toBe(false);
    expect(await chartExists(appPage, chartId), "and the chart lives").toBe(true);
    expect(
      (await layoutView(appPage, chartId)).elements?.dataTable,
      "nothing is drawn for it any more",
    ).toBeUndefined();
    expect(await grid.getCellDisplayValue("A1"), "and the cells are untouched").toBe(SENTINEL);

    await removeChart(appPage, chartId);
    await grid.setCellValueDirect("A1", "");
  });

  // ========================================================================
  // 16 — the reachability gap a DEFAULT AREA CHART had (chart-interaction §6.7)
  //
  // An area series is ONE polygon filled from the series colour and
  // `showMarkers` defaults to FALSE, so on a default area chart there was no
  // per-datum shape for "format this point" to reach: the pane accepted the
  // colour, wrote it into the spec, dirtied the document — and nothing on
  // screen changed. An overridden datum now gets a marker even though the
  // series shows none, because the override IS the request for a distinct
  // point. A datum with no override still gets nothing, which is the half that
  // keeps a default area chart looking like an area chart.
  // ========================================================================

  test("an AREA chart with markers OFF paints a marker for the ONE datum that was formatted, and for no other", async ({
    appPage,
    grid,
  }) => {
    test.setTimeout(300_000);
    await installAppImport(appPage);
    await seedData(grid);
    await appPage.waitForTimeout(400);

    const chartId = await makeChart(
      appPage,
      baseSpec("area", { title: "Area Point Journey" }),
      "AreaPointJourney",
    );

    const TARGET = 3;
    const NEIGHBOUR = 1;

    let box = await chartClientBox(appPage, chartId);
    for (let i = 0; i < 3; i++) {
      const p = await markerCentre(appPage, chartId, box, TARGET);
      await slowClick(appPage, p.x, p.y);
    }
    expect(
      await ladder(appPage),
      "the datum is REACHABLE even with no marker painted — the hit geometry records one regardless",
    ).toMatchObject({ level: "dataPoint", seriesIndex: 0, categoryIndex: TARGET });

    const at = await markerCentre(appPage, chartId, box, TARGET);
    await openChartMenu(appPage, at.x, at.y);
    expect(await formatRowLabel(appPage), "an area datum is a Data Point like any other").toBe(
      "Format Data Point...",
    );
    await openFormatPaneFromMenu(appPage);
    await pickFormatTab(appPage, "Fill & Line");

    // Re-derived with the pane OPEN, before the parking click uses it.
    await appPage.mouse.move(4, 4);
    await appPage.waitForTimeout(300);
    await settleGrid(appPage);
    box = await chartClientBox(appPage, chartId);
    await parkSelectionOnTitle(appPage, chartId, box);
    const targetPatch = sampleBox(await markerCentre(appPage, chartId, box, TARGET), 6);
    const neighbourPatch = sampleBox(await markerCentre(appPage, chartId, box, NEIGHBOUR), 6);
    const targetBefore = await pixels(appPage, targetPatch);
    const neighbourBefore = await pixels(appPage, neighbourPatch);

    for (let i = 0; i < 2; i++) {
      const p = await markerCentre(appPage, chartId, box, TARGET);
      await slowClick(appPage, p.x, p.y);
    }
    expect(await ladder(appPage)).toMatchObject({ level: "dataPoint", seriesIndex: 0, categoryIndex: TARGET });

    const ORANGE = "#ed7d31";
    await swatch(appPage, "Fill colour", ORANGE).click();
    await appPage.waitForTimeout(1200);
    await settleGrid(appPage);
    await parkSelectionOnTitle(appPage, chartId, box);

    const overrides = (await rawSpec(appPage, chartId)).dataPointOverrides;
    expect(overrides, "one override, for the datum the reader clicked").toHaveLength(1);
    expect(String(overrides![0].color).toLowerCase()).toBe(ORANGE);

    const targetAfter = await pixels(appPage, targetPatch);
    const neighbourAfter = await pixels(appPage, neighbourPatch);
    console.log(
      `[chart-interaction] area override: target diff=${diffCount(targetBefore, targetAfter)} neighbour diff=${diffCount(neighbourBefore, neighbourAfter)}`,
    );
    expect(
      diffCount(targetBefore, targetAfter),
      "THE GAP THIS CLOSED: the colour must APPEAR — a per-point override that paints nothing is a control that lies",
    ).toBeGreaterThan(5);
    expect(
      diffCount(neighbourBefore, neighbourAfter),
      "NEGATIVE CONTROL: a datum with no override still gets no marker, so a default area chart still looks like one",
    ).toBe(0);

    await removeChart(appPage, chartId);
  });
});
