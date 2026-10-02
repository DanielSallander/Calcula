/**
 * INSIGHT OVERLAYS — proved LIVE, on the real app, through the real surfaces.
 *
 * docs/design/insight-overlays.md §6: "then a LIVE proof on a real chart and
 * range — the router milestone's lesson holds: the defects that matter came
 * from the live proof". Every unit test in the milestone runs against fixtures
 * and stubs; this file drives the running app through the gestures a person
 * makes and checks the two things no stub can: that a ring is PAINTED where a
 * bar is, and that the whole chain — grid cells → chart → Rust facts → cues →
 * composite paint → context menu → prompt → persisted comment → data change →
 * re-anchor — holds together at once.
 *
 * EVERY "IT IS THERE" HAS A POSITIVE CONTROL AND A NEGATIVE ONE. The ring's
 * existence is asserted twice: the store says which datum it is on (the label
 * "Aug", which the seeded data makes the maximum), and the chart's pixels
 * changed between "off" and "on". A detector that cannot see pixels fails the
 * second; an overlay that draws nothing fails it too; and after "hide" the
 * pixels must return to the "off" capture, so a ring that never clears fails
 * the third.
 *
 * Grid area: Z1:AA13 (cols 25–26) — the walker's chart-data area, which
 * nothing else in the tree writes to.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import { readGridGeometry, cellRangeRectFrom } from "../helpers/grid";
// (readGridGeometry / cellRangeRectFrom feed rangeClip below.)
import { takeRegionScreenshot, waitForGridStable } from "../helpers/screenshots";
// THE PIXEL SAMPLER IS SHARED, AND IT NEVER CLIPS THE CAPTURE.
// `page.screenshot({ clip })` is not a passive read: Chromium is asked to put
// that rectangle on screen, and a control the pointer is PARKED on can receive
// a `mouseleave` it never earned. This file is the one most exposed to that —
// three of its samples are taken right after a chart context-menu click, so the
// pointer is sitting ON the chart, whose renderer tracks a hover datum of its
// own. `samplePixels` captures the whole viewport and crops afterwards in-page;
// `diffCount` is the one copy of the comparison that used to live in nine specs
// at the same threshold. See `e2e/viewportSample.ts` for the full measurement.
import { diffCount, samplePixels, type PixelClip } from "../viewportSample";

/* eslint-disable @typescript-eslint/naming-convention */
type AppWindow = Window & {
  __calcImport: (url: string) => Promise<unknown>;
  __appImport?: (modulePath: string) => Promise<unknown>;
  __TAURI__: { core: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } };
  __CALCULA_CHARTS__?: {
    getAllCharts: () => Array<{ id: string }>;
    selectChart: (id: string) => void;
    deselectChart?: () => void;
    deleteChart?: (id: string) => void;
  };
};
/* eslint-enable @typescript-eslint/naming-convention */

const CHART_CUES = "/src/api/chartCues.ts";
const CELL_CUES = "/src/api/cellCues.ts";
const GRID_OVERLAYS = "/src/api/gridOverlays.ts";
const GRID_MODULE = "/src/api/grid.ts";
const GRID_MENU = '[role="menu"][aria-label="Context menu"]';

/** The seeded series: Aug is the maximum (and the only outlier), Feb the minimum. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const SALES = [100, 61, 120, 130, 125, 140, 150, 400, 145, 135, 128, 122];
const DATA_COL_LETTER = "AA";
const CAT_COL_LETTER = "Z";

// ---------------------------------------------------------------------------
// Plumbing (the same traps and answers as on-grid-forms.spec.ts)
// ---------------------------------------------------------------------------

async function installAppImport(page: Page): Promise<void> {
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

/** The rectangle shape the samplers take, in CSS pixels. */
type Clip = PixelClip;

/** The chart's client box, computed the way the renderer places its region. */
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
      };
    },
    { chartId, overlays: GRID_OVERLAYS, grid: GRID_MODULE },
  );
  expect(box, `no chart region is published for "${chartId}"`).not.toBeNull();
  return box!;
}

/**
 * A point in the chart's OUTER MARGIN, chart-local: inside the canvas, outside
 * the plot area, and off every piece of furniture the layout measured. That is
 * the pixel `hitTestChartElements` answers `chartArea` for — and, since the top
 * and right margins stopped being dead pixels, it is the MOUSE's route from any
 * element rung back out to the chart object (the keyboard's is Escape).
 *
 * Computed from the LIVE layout rather than hard-coded. The margins are a
 * function of the legend, the axis titles and the tick-label bands, so a fixed
 * offset would start landing on furniture the first time one of those changed,
 * and the test would then be asserting something about the legend.
 *
 * The search stays clear of three things:
 *   - every measured element rect, plus 3px, so a click cannot graze one;
 *   - the top strip (y < COMMENT_TOP_RESERVED-ish, 40px here), which the
 *     overlay's stepper pill owns — a click there STEPS the cues;
 *   - 12px of the LEFT, RIGHT and BOTTOM canvas edges. Core's resize handles
 *     (core/lib/floatingHandles.ts, BUG-0258 design phase 3) are live only on
 *     a SELECTED object -- and the chart this journey clicks IS selected --
 *     centred on its four corners and on the midpoint of every edge of at
 *     least FLOATING_HANDLE_MIDPOINT_MIN_EDGE (48px), each hit at its centre
 *     +/- FLOATING_HANDLE_HIT_HALF (6px). Keeping 12px from the left, right
 *     and bottom edges clears the w, e and s midpoints and all four corners
 *     at any other coordinate; the top strip above clears n. A press on a
 *     handle starts a resize and the chart's own hit-test never runs.
 * Among the survivors it takes the one furthest from those bounds, so the
 * click has the most room around it.
 */
async function outerMarginPoint(page: Page, chartId: string): Promise<{ x: number; y: number }> {
  const probe = await page.evaluate(
    async ({ chartId, mod }) => {
      type Rect = { x: number; y: number; width: number; height: number };
      const m = (await (window as unknown as AppWindow).__appImport!(mod)) as {
        getCachedChartData: (id: string) => {
          layout?: {
            width: number;
            height: number;
            plotArea: Rect;
            elements?: Record<string, unknown>;
          };
        } | null;
      };
      const layout = m.getCachedChartData(chartId)?.layout;
      if (!layout) return null;
      const el = (layout.elements ?? {}) as Record<string, unknown>;
      // `chartArea` is the whole canvas and is the TARGET, so it is not an
      // obstacle. Everything else the hit-tester consults is.
      const blocked: Rect[] = [layout.plotArea];
      for (const key of ["title", "xAxisTitle", "yAxisTitle", "xAxisBand", "yAxisBand", "legend", "dataTable", "displayUnitLabel"]) {
        const r = el[key] as Rect | undefined;
        if (r) blocked.push(r);
      }
      for (const key of ["legendItems", "errorBars", "dataLabels"]) {
        const list = el[key] as Array<{ rect: Rect }> | undefined;
        if (list) for (const item of list) blocked.push(item.rect);
      }
      const PAD = 3;
      const EDGE = 12; // clears the w / e / s handles and the corners (hit +/- 6)
      const PILL_STRIP = 40; // the stepper pill's own strip at the top
      let best: { x: number; y: number; depth: number } | null = null;
      for (let y = 2; y <= layout.height - EDGE; y += 2) {
        if (y < PILL_STRIP) continue;
        for (let x = EDGE; x <= layout.width - EDGE; x += 2) {
          const hit = blocked.some(
            (r) => x >= r.x - PAD && x <= r.x + r.width + PAD && y >= r.y - PAD && y <= r.y + r.height + PAD,
          );
          if (hit) continue;
          const depth = Math.min(x - EDGE, layout.width - EDGE - x, y - PILL_STRIP, layout.height - EDGE - y);
          if (best === null || depth > best.depth) best = { x, y, depth };
        }
      }
      return { best, layout: { width: layout.width, height: layout.height }, blocked };
    },
    { chartId, mod: "/extensions/Charts/rendering/chartRenderer.ts" },
  );
  expect(probe, `no painted layout for "${chartId}" — nothing to find a margin in`).not.toBeNull();
  expect(
    probe!.best,
    `this chart has no free outer margin: canvas ${JSON.stringify(probe!.layout)}, furniture ${JSON.stringify(probe!.blocked)}`,
  ).not.toBeNull();
  return { x: probe!.best!.x, y: probe!.best!.y };
}

/** Viewport-relative clip of a cell range, from the app's LIVE geometry. */
async function rangeClip(page: Page, from: string, to: string, pad = 2): Promise<Clip> {
  const geo = await readGridGeometry(page);
  const rect = cellRangeRectFrom(from, to, geo);
  const box = await page.locator("canvas").first().boundingBox();
  if (!box) throw new Error("grid canvas has no bounding box");
  return { x: box.x + rect.x - pad, y: box.y + rect.y - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 };
}

/**
 * Refuse to gesture at a grid pixel that something is sitting on top of.
 *
 * The grid canvas keeps its full width when a task pane docks; the pane is
 * painted OVER it. So a cell centre derived from grid geometry is always a
 * valid grid coordinate and yet may be unclickable, and a click there lands on
 * the pane while the grid state stays exactly as it was. The only honest test
 * is the DOM's own: whatever is topmost at that page point must be inside the
 * spreadsheet's focus container. The grid's own overlay layers are, and any
 * docked pane, dialog or menu is not.
 *
 * @param pt canvas-relative point, as `cellCenterScrollAware` returns.
 */
async function expectGridPixelIsFree(page: Page, pt: { x: number; y: number }, what: string): Promise<void> {
  const verdict = await page.evaluate((p: { x: number; y: number }) => {
    const canvas = document.querySelector("canvas");
    if (!canvas) return { ok: false, why: "no grid canvas in the document", stack: [] as string[] };
    const r = canvas.getBoundingClientRect();
    const px = r.left + p.x;
    const py = r.top + p.y;
    if (p.x < 0 || p.y < 0 || p.x > r.width || p.y > r.height) {
      return { ok: false, why: `off-canvas: point (${Math.round(p.x)}, ${Math.round(p.y)}) vs canvas ${Math.round(r.width)}x${Math.round(r.height)}`, stack: [] };
    }
    const stack = (document.elementsFromPoint(px, py) as HTMLElement[]).slice(0, 5).map((e) => {
      const b = e.getBoundingClientRect();
      const id = e.getAttribute("data-testid") ?? e.id ?? "";
      return `${e.tagName}${id ? `[${id}]` : ""}.${String(e.className)} @${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)}`;
    });
    const top = document.elementFromPoint(px, py);
    const container = document.querySelector('[data-focus-container="spreadsheet"]');
    const ok = !!top && !!container && container.contains(top);
    return { ok, why: ok ? "" : `page point (${Math.round(px)}, ${Math.round(py)}) is covered by something outside the grid`, stack };
  }, pt);
  expect(
    verdict.ok,
    `${what} is not clickable: ${verdict.why}\n  topmost first: ${verdict.stack.join("\n                 ")}`,
  ).toBe(true);
}

interface OverlayView {
  cues: Array<{ cueId: string; factId: string; kind: string; polarity: string; description?: string; anchor: Record<string, unknown> }>;
  comments: Array<{ id: string; cueId: string; factId: string; text: string; anchor: Record<string, unknown> | null; movedFrom?: string }>;
  step: number | "all";
  selectedCueId: string | null;
  visible: number;
}

async function overlayOf(page: Page, chartId: string): Promise<OverlayView> {
  return page.evaluate(
    async ({ chartId, mod }) => {
      const w = window as unknown as AppWindow;
      const m = (await w.__appImport!(mod)) as {
        getChartOverlay: (id: string) => Omit<OverlayView, "visible">;
        visibleChartCues: (id: string) => unknown[];
      };
      const o = m.getChartOverlay(chartId);
      return { ...JSON.parse(JSON.stringify(o)), visible: m.visibleChartCues(chartId).length } as OverlayView;
    },
    { chartId, mod: CHART_CUES },
  );
}

/**
 * Right-click the chart's plot centre and click a chart-menu item by its exact
 * text. The hover state the product will consult is read and printed first,
 * so a wrong menu (the axis menu opened once here) is diagnosable from the log
 * rather than from a screenshot.
 */
async function chartMenu(page: Page, box: Clip, label: string): Promise<void> {
  const x = box.x + box.width * 0.5;
  const y = box.y + box.height * 0.55;
  await page.mouse.move(x, y);
  await page.waitForTimeout(200);
  const hover = await page.evaluate(async () => {
    const m = (await (window as unknown as AppWindow).__appImport!("/extensions/Charts/rendering/chartRenderer.ts")) as {
      getHoverState: () => unknown;
    };
    return JSON.stringify(m.getHoverState());
  });
  console.log(`[overlay-journey] right-click at (${x.toFixed(0)}, ${y.toFixed(0)}) hover=${hover}`);
  await page.mouse.click(x, y, { button: "right" });
  const item = page.getByText(label, { exact: true });
  await expect(item, `"${label}" must be offered on the chart menu (hover was ${hover})`).toBeVisible({ timeout: 5_000 });
  await item.click();
}

// ---------------------------------------------------------------------------
// The journey
// ---------------------------------------------------------------------------

test.describe("Insight overlays, live", () => {
  test.setTimeout(240_000);

  test("a chart's points of interest: shown, stepped, commented, followed through a data change, hidden; then a range's", async ({
    appPage,
    grid,
  }) => {
    await installAppImport(appPage);

    // --- Seed the data the facts will be computed from ----------------------
    await grid.setCellValueDirect(`${CAT_COL_LETTER}1`, "Month");
    await grid.setCellValueDirect(`${DATA_COL_LETTER}1`, "Sales");
    for (let i = 0; i < MONTHS.length; i++) {
      await grid.setCellValueDirect(`${CAT_COL_LETTER}${i + 2}`, MONTHS[i]);
      await grid.setCellValueDirect(`${DATA_COL_LETTER}${i + 2}`, String(SALES[i]));
    }
    await appPage.waitForTimeout(400);

    // --- The chart, through the store's own create ---------------------------
    const chartId = await appPage.evaluate(async () => {
      const spec = {
        mark: "bar",
        data: { sheetIndex: 0, startRow: 0, startCol: 25, endRow: 12, endCol: 26 },
        hasHeaders: true,
        seriesOrientation: "columns",
        categoryIndex: 0,
        series: [{ sourceIndex: 1, name: "Sales", color: "#4472C4" }],
        title: "OverlayJourneyChart",
      };
      const store = (await (window as unknown as AppWindow).__calcImport(
        new URL("/extensions/Charts/lib/chartStore.ts", document.baseURI).href,
      )) as {
        createChart: (spec: unknown, placement: Record<string, unknown>) => { chartId: string };
        syncChartRegions: () => void;
      };
      const created = store.createChart(spec, { sheetIndex: 0, x: 60, y: 30, width: 520, height: 320, name: "OverlayJourneyChart" });
      store.syncChartRegions();
      return created.chartId;
    });
    await appPage.waitForTimeout(1200);
    // THE CHART IS PLACED IN SHEET COORDINATES (x=60, y=30) BUT SAMPLED IN
    // VIEWPORT ONES. The journey project shares one running app across specs,
    // so the viewport arrives wherever the previous spec left it — this run
    // opened at BF65, which put the whole chart 2663px off the left edge and
    // every pixel sample below would have been taken of transparent black.
    // `samplePixels` refuses that outright (viewportSample.ts), which is the
    // right answer and not something to work around by clipping: scroll the
    // origin back into view instead, explicitly, so the placement and the
    // sampling agree about where the chart is.
    await grid.navigateTo("A1");
    await appPage.waitForTimeout(300);
    await waitForGridStable(appPage);

    await appPage.evaluate((id: string) => {
      (window as unknown as AppWindow).__CALCULA_CHARTS__!.selectChart(id);
    }, chartId);
    await appPage.waitForTimeout(400);

    const box = await chartClientBox(appPage, chartId);
    const off = await samplePixels(appPage, box);

    // --- ON, through the chart's context menu -------------------------------
    await chartMenu(appPage, box, "Show points of interest");
    await appPage.waitForTimeout(2500); // resolve + Rust facts + repaint
    await waitForGridStable(appPage);

    let overlay = await overlayOf(appPage, chartId);
    expect(overlay.cues.length, "the seeded series must yield at least one point of interest").toBeGreaterThan(0);
    const highest = overlay.cues.find((c) => c.description === "Highest Sales");
    expect(highest, `the extremes fact must ring the highest month; got ${JSON.stringify(overlay.cues.map((c) => c.description))}`).toBeTruthy();
    expect(highest!.anchor).toMatchObject({ type: "datum", series: "Sales", categoryIndex: 7, categoryLabel: "Aug" });
    expect(highest!.polarity, "a range chart has no strategy: neutral, never a guessed colour").toBe("neutral");
    expect(overlay.step, "stepping is the default").toBe(0);
    expect(overlay.visible, "one point of interest is shown at a time").toBeLessThanOrEqual(overlay.cues.length);

    const on = await samplePixels(appPage, box);
    const drawn = diffCount(off, on);
    expect(drawn, "POSITIVE CONTROL: turning the overlay on must change the chart's pixels (a ring, the pill)").toBeGreaterThan(50);


    // --- THE LADDER OWNS THE CLICK (the owner's live finding) --------------
    // Two defects lived here, and BOTH shipped green because this journey
    // selected cues programmatically and its only chart mouse events were
    // right-clicks. These are real LEFT clicks on real bars.
    //
    //  (a) The overlay's click branch returned as soon as a ring was hit, so a
    //      ringed bar could never be selected individually — the reader could
    //      not reach the bar the overlay was pointing at.
    //  (b) It assigned the selection only when a ring WAS hit, so clicking a
    //      bar with no ring left the previous ring selected, and "Add comment
    //      on this point…" then wrote the reader's words onto a bar they had
    //      already clicked away from.
    const ladderLevel = async (): Promise<string> =>
      appPage.evaluate(async () => {
        const m = (await (window as unknown as AppWindow).__appImport!(
          "/extensions/Charts/handlers/selectionHandler.ts",
        )) as { getSubSelection: () => { level: string; seriesIndex?: number; categoryIndex?: number } };
        return JSON.stringify(m.getSubSelection());
      });

    /** One bar's rectangle, chart-local, from the renderer's own hit geometry. */
    const barRect = async (categoryIndex: number): Promise<{ x: number; y: number; width: number; height: number }> => {
      const rect = await appPage.evaluate(
        async ({ chartId, categoryIndex }) => {
          const m = (await (window as unknown as AppWindow).__appImport!(
            "/extensions/Charts/rendering/chartRenderer.ts",
          )) as { getCachedChartData: (id: string) => { hitGeometry: { type: string; rects?: Array<{ x: number; y: number; width: number; height: number; categoryIndex: number }> } } | undefined };
          const g = m.getCachedChartData(chartId)?.hitGeometry;
          const r = g?.rects?.find((b) => b.categoryIndex === categoryIndex);
          return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
        },
        { chartId, categoryIndex },
      );
      expect(rect, `no bar is drawn at category ${categoryIndex}`).not.toBeNull();
      return rect!;
    };

    /** The page-space centre of one bar. */
    const barCentre = async (categoryIndex: number): Promise<{ x: number; y: number }> => {
      const r = await barRect(categoryIndex);
      return { x: box.x + r.x + r.width / 2, y: box.y + r.y + r.height / 2 };
    };

    const clickBar = async (categoryIndex: number): Promise<void> => {
      const at = await barCentre(categoryIndex);
      await appPage.mouse.click(at.x, at.y);
      await appPage.waitForTimeout(250);
    };

    // The ringed bar (Aug, category 7) climbs the ladder like any other bar.
    await appPage.evaluate(
      async ({ chartId, mod }) => ((await (window as unknown as AppWindow).__appImport!(mod)) as { setChartCueStep: (id: string, s: number | "all") => void }).setChartCueStep(chartId, "all"),
      { chartId, mod: CHART_CUES },
    );
    await appPage.waitForTimeout(300);

    await clickBar(7);
    expect(JSON.parse(await ladderLevel()), "one click on a RINGED bar selects its series, exactly as on any other bar")
      .toMatchObject({ level: "series", seriesIndex: 0 });
    let selected = await appPage.evaluate(
      async ({ chartId, mod }) => ((await (window as unknown as AppWindow).__appImport!(mod)) as { getSelectedChartCue: (id: string) => { cueId: string; anchor: Record<string, unknown> } | null }).getSelectedChartCue(chartId),
      { chartId, mod: CHART_CUES },
    );
    expect(selected?.anchor, "and the ring on it is the selected one").toMatchObject({ categoryLabel: "Aug" });

    await clickBar(7);
    expect(JSON.parse(await ladderLevel()), "a second click reaches the BAR — the defect was that it never could")
      .toMatchObject({ level: "dataPoint", seriesIndex: 0, categoryIndex: 7 });

    // A bar with no ring clears the selection rather than leaving the old one.
    const unringed = await appPage.evaluate(
      async ({ chartId, mod }) => {
        const m = (await (window as unknown as AppWindow).__appImport!(mod)) as {
          visibleChartCues: (id: string) => Array<{ anchor: { type: string; categoryIndex?: number } }>;
        };
        const ringed = new Set(m.visibleChartCues(chartId).filter((c) => c.anchor.type === "datum").map((c) => c.anchor.categoryIndex));
        return [0, 1, 2, 3, 4, 5, 6, 8, 9, 10].find((i) => !ringed.has(i)) ?? null;
      },
      { chartId, mod: CHART_CUES },
    );
    expect(unringed, "the seeded chart must have at least one bar with no ring on it").not.toBeNull();

    await clickBar(unringed!);
    selected = await appPage.evaluate(
      async ({ chartId, mod }) => ((await (window as unknown as AppWindow).__appImport!(mod)) as { getSelectedChartCue: (id: string) => { cueId: string; anchor: Record<string, unknown> } | null }).getSelectedChartCue(chartId),
      { chartId, mod: CHART_CUES },
    );
    expect(selected, `clicking bar ${unringed} must CLEAR the ring selected on Aug, not keep it`).toBeNull();
    // Same series, so the ladder stays at datum level and moves to the new bar.
    expect(JSON.parse(await ladderLevel()), "and the ladder has moved to that bar")
      .toMatchObject({ level: "dataPoint", seriesIndex: 0, categoryIndex: unringed });

    // Leave the chart exactly as the overlay found it: CHART level, no ring
    // selected, step 0 — so every pixel comparison below still compares like
    // with like. That takes TWO gestures, and which one does what is Excel's
    // model rather than a detail of this test.
    //
    //  (1) THE PLOT BACKGROUND SELECTS THE PLOT AREA. It is a rung of the
    //      ladder in its own right — nameable ("Plot Area"), paintable,
    //      formattable, and reachable by the Up/Down element walk — and until
    //      the furniture wave it was keyboard-reachable and MOUSE-unreachable,
    //      because every non-datum hit funnelled into `{ level: "chart" }`.
    //      This assertion is a survivor of that era: it read `{ level: "chart" }`
    //      and was simply describing the defect. Standing on that rung costs
    //      the reader nothing, because Delete there is a deliberate no-op —
    //      Excel's Delete on a selected plot area destroys nothing either.
    //      DO NOT "fix" this back to chart level. `chart-interaction.spec.ts`
    //      ("a click where the gridlines are selects the PLOT AREA") asserts
    //      the same pixel from the other side, and the two must agree.
    //
    //  (2) THE ROUTE BACK OUT IS THE OUTER MARGIN — outside the plot and off
    //      every piece of furniture, which `hitTestChartElements` answers
    //      `chartArea` for. That answer is exactly why the top and right
    //      margins stopped being dead pixels; Escape is the keyboard's route.
    //      Taking it here is not tidiness: `arrowsBelongToOverlayStep` requires
    //      `level === "chart"`, so a ladder left parked on the plot area would
    //      hand the next section's Right arrow to the element walk and the
    //      overlay would never step.
    //
    // The plot-background click lands above the Jan bar: the TOP of the chart
    // belongs to the stepper pill, which would step instead of clearing.
    const shortest = await barRect(0);
    await appPage.mouse.click(box.x + shortest.x + shortest.width / 2, box.y + shortest.y - 20);
    await appPage.waitForTimeout(250);
    expect(
      JSON.parse(await ladderLevel()),
      "a click on the plot BACKGROUND selects the plot area, as in Excel — not a way out of the chart",
    ).toMatchObject({ level: "element", elementId: "plotArea" });
    // And it clears the ring selection, because the assignment is
    // UNCONDITIONAL (insight-overlays.md §5h): a click that lands on no cue
    // clears it wherever it lands, background or unringed bar alike. Asserted
    // here as well as on the bar above, since this is the gesture the rest of
    // the journey relies on for its clean slate.
    selected = await appPage.evaluate(
      async ({ chartId, mod }) => ((await (window as unknown as AppWindow).__appImport!(mod)) as { getSelectedChartCue: (id: string) => { cueId: string; anchor: Record<string, unknown> } | null }).getSelectedChartCue(chartId),
      { chartId, mod: CHART_CUES },
    );
    expect(selected, "a click on no cue clears the selected ring, plot background included").toBeNull();

    const margin = await outerMarginPoint(appPage, chartId);
    console.log(`[overlay-journey] outer-margin probe at chart-local (${margin.x}, ${margin.y})`);
    await appPage.mouse.click(box.x + margin.x, box.y + margin.y);
    await appPage.waitForTimeout(250);
    expect(
      JSON.parse(await ladderLevel()),
      "the chart's outer margin is the mouse's way back out to chart level",
    ).toMatchObject({ level: "chart" });
    await appPage.evaluate(
      async ({ chartId, mod }) => ((await (window as unknown as AppWindow).__appImport!(mod)) as { setChartCueStep: (id: string, s: number | "all") => void }).setChartCueStep(chartId, 0),
      { chartId, mod: CHART_CUES },
    );
    await appPage.waitForTimeout(400);
    await waitForGridStable(appPage);

    // --- STEP, from the keyboard --------------------------------------------
    // The chart is selected and shows cues, so the plain Right arrow is the
    // overlay's (lib/overlayKeys.ts); the grid's active cell must NOT move.
    const steps = await appPage.evaluate(
      async ({ chartId, mod }) => ((await (window as unknown as AppWindow).__appImport!(mod)) as { chartCueSteps: (id: string) => string[] }).chartCueSteps(chartId),
      { chartId, mod: CHART_CUES },
    );
    const activeCellBefore = await appPage.evaluate(
      () => JSON.stringify((window as unknown as { __CALCULA_GRID_STATE__?: { selection?: unknown } }).__CALCULA_GRID_STATE__?.selection ?? null),
    );
    await appPage.keyboard.press("ArrowRight");
    await appPage.waitForTimeout(500);
    overlay = await overlayOf(appPage, chartId);
    if (steps.length > 1) {
      expect(overlay.step, "the Right arrow steps to the next point of interest").toBe(1);
      const stepped = await samplePixels(appPage, box);
      expect(diffCount(on, stepped), "stepping must move the ring (the pixels must change)").toBeGreaterThan(20);
      await appPage.keyboard.press("ArrowLeft");
      await appPage.waitForTimeout(300);
      expect((await overlayOf(appPage, chartId)).step, "and Left steps back").toBe(0);
      await appPage.keyboard.press("ArrowRight");
      await appPage.waitForTimeout(300);
    }
    const activeCellAfter = await appPage.evaluate(
      () => JSON.stringify((window as unknown as { __CALCULA_GRID_STATE__?: { selection?: unknown } }).__CALCULA_GRID_STATE__?.selection ?? null),
    );
    console.log(`[overlay-journey] grid selection before/after the arrows: ${activeCellBefore} / ${activeCellAfter}`);
    expect(activeCellAfter, "the arrows were the overlay's, not the grid's: the selection stayed").toBe(activeCellBefore);

    // --- A COMMENT on the highest month, through the menu and the in-app prompt
    await appPage.evaluate(
      async ({ chartId, mod, cueId }) => {
        const m = (await (window as unknown as AppWindow).__appImport!(mod)) as {
          setSelectedChartCue: (id: string, c: string | null) => void;
          setChartCueStep: (id: string, s: number | "all") => void;
        };
        m.setChartCueStep(chartId, "all");
        // By CUE id: `extremes` rings the highest month AND the lowest under one
        // fact id, and a fact id now selects nothing rather than guessing.
        m.setSelectedChartCue(chartId, cueId);
      },
      { chartId, mod: CHART_CUES, cueId: highest!.cueId },
    );
    await appPage.waitForTimeout(300);
    await chartMenu(appPage, box, "Add comment on this point…");
    const prompt = appPage.locator("[data-calcula-prompt]");
    await expect(prompt, "the in-app prompt must open (never the banned window.prompt)").toBeVisible({ timeout: 5_000 });
    await prompt.locator("input").fill("Launch month");
    await prompt.locator("button", { hasText: /^OK$/ }).click();
    await appPage.waitForTimeout(800);
    overlay = await overlayOf(appPage, chartId);
    expect(overlay.comments.map((c) => [c.text, c.cueId, c.anchor?.categoryLabel])).toEqual([["Launch month", highest!.cueId, "Aug"]]);
    const commented = await samplePixels(appPage, box);
    expect(diffCount(on, commented), "the comment box must be painted").toBeGreaterThan(20);

    // THE MENU GESTURE LEFT THE PLOT AREA SELECTED, and that is correct.
    // `chartMenu` right-clicks the plot background, and the context-menu
    // handler STATES the rung outright (`setSubSelection(..., "plotArea")`)
    // rather than nudging the ladder — deliberately, so that a right-click and
    // a left-click on one pixel can never name two different rungs. Excel does
    // the same: right-clicking the plot area selects it and shows its handles.
    expect(
      JSON.parse(await ladderLevel()),
      "the right-click that opened the comment menu selects the same rung its left-click would",
    ).toMatchObject({ level: "element", elementId: "plotArea" });

    // The stored baseline: every cue, the pill, the selected ring and the
    // comment, on the seeded data. The pointer is parked off the chart first
    // so no hover tooltip rides into the frame — and the ladder is parked back
    // at chart level first too, for the same reason. This golden is a picture
    // of the OVERLAY; the plot area's selection frame and its eight handles
    // are chrome from the gesture that opened the menu, and leaving them in
    // the image would mean re-blessing it every time the selection painter
    // moves a handle by a pixel.
    //
    // NOT Escape, although Escape is the keyboard's way up the ladder: it is
    // REFUSED here, and correctly. `chartOwnsKeystroke` requires GRID FOCUS,
    // and the comment prompt's OK button still holds it — that is the gate
    // whose own header records Delete destroying a chart while a button in the
    // chart's Format pane had focus. Measured, not assumed: this assertion was
    // written as an Escape first and the ladder did not move.
    //
    // So the mouse route again, and the cue re-selected afterwards, because a
    // click that lands on no cue clears the selection wherever it lands — and
    // the ring on Aug has to be the SELECTED one in the golden. It is set the
    // same way it was set above, through the store.
    const marginAgain = await outerMarginPoint(appPage, chartId);
    await appPage.mouse.click(box.x + marginAgain.x, box.y + marginAgain.y);
    await appPage.waitForTimeout(250);
    expect(
      JSON.parse(await ladderLevel()),
      "the outer margin walks the ladder back out of the plot area to the chart",
    ).toMatchObject({ level: "chart" });
    await appPage.evaluate(
      async ({ chartId, mod, cueId }) => {
        const m = (await (window as unknown as AppWindow).__appImport!(mod)) as {
          setSelectedChartCue: (id: string, c: string | null) => void;
        };
        m.setSelectedChartCue(chartId, cueId);
      },
      { chartId, mod: CHART_CUES, cueId: highest!.cueId },
    );
    await appPage.waitForTimeout(300);
    expect(
      (await overlayOf(appPage, chartId)).selectedCueId,
      "the golden shows the SELECTED ring on Aug, so it has to be selected again after the click cleared it",
    ).toBe(highest!.cueId);
    await appPage.mouse.move(4, 4);
    await appPage.waitForTimeout(300);
    await takeRegionScreenshot(appPage, "insight-overlay-chart-all", box);

    // --- KEEP IN CHART, then UNDO through the backend -----------------------
    // The selected cue (the highest month) becomes a `marker` layer in the
    // spec; the store's debounced save records an "Edit chart" undo entry in
    // Rust, so undo removes it again. Both halves read the BACKEND's spec.
    const backendLayers = async (): Promise<string[]> =>
      appPage.evaluate(async (id: string) => {
        const charts = (await (window as unknown as AppWindow).__TAURI__.core.invoke("get_charts")) as Array<{ id: string; specJson: string }>;
        const found = charts.find((c) => c.id === id);
        if (!found) throw new Error("chart missing from the backend");
        // `specJson` is the WHOLE ChartDefinition (chartStore.toEntry), so the
        // spec — and its layers — sit one level down.
        const def = JSON.parse(found.specJson) as { spec?: { layers?: Array<{ mark: string }> } };
        return (def.spec?.layers ?? []).map((l) => l.mark);
      }, chartId);
    expect(await backendLayers(), "no layer before keeping").toEqual([]);
    const selectedBeforeKeep = await appPage.evaluate(
      async ({ chartId, mod }) => {
        const m = (await (window as unknown as AppWindow).__appImport!(mod)) as { getSelectedChartCue: (id: string) => { cueId: string } | null };
        return m.getSelectedChartCue(chartId)?.cueId ?? null;
      },
      { chartId, mod: CHART_CUES },
    );
    expect(selectedBeforeKeep, "a cue must be selected for Keep to have a subject").toBe(highest!.cueId);
    await chartMenu(appPage, box, "Keep this mark in the chart");
    // The store's 300 ms save debounce, then the backend round trip; poll
    // rather than sleep, and say what each side holds if it never lands.
    // The STORE's own definition (the `__CALCULA_CHARTS__` bridge carries ids
    // only, so reading layers through it answers 0 whatever the truth).
    const storeLayers = async (): Promise<string[]> =>
      appPage.evaluate(async (id: string) => {
        const store = (await (window as unknown as AppWindow).__appImport!("/extensions/Charts/lib/chartStore.ts")) as {
          getChartById: (id: string) => { spec?: { layers?: Array<{ mark: string }> } } | null;
        };
        return (store.getChartById(id)?.spec?.layers ?? []).map((l) => l.mark);
      }, chartId);
    let kept: string[] = [];
    let storeLayersAfterKeep: string[] = [];
    for (let i = 0; i < 10; i++) {
      await appPage.waitForTimeout(500);
      kept = await backendLayers();
      storeLayersAfterKeep = await storeLayers();
      if (kept.length > 0) break;
    }
    expect(storeLayersAfterKeep, "POSITIVE CONTROL: the store holds the kept layer").toEqual(["marker"]);
    const toasts = await appPage.evaluate(() => [...document.querySelectorAll("[data-toast]")].map((t) => t.textContent ?? ""));
    console.log(`[overlay-journey] after keep: backend layers=${JSON.stringify(kept)} store layers=${storeLayersAfterKeep} toasts=${JSON.stringify(toasts)}`);
    expect(kept, `keeping writes a marker layer into the backend's spec (store had ${storeLayersAfterKeep}, toasts ${JSON.stringify(toasts)})`).toEqual(["marker"]);
    await appPage.evaluate(async () => {
      const w = window as unknown as AppWindow;
      await w.__TAURI__.core.invoke("undo");
      // The shell's own undo path translates the result's domains into these
      // two events; a direct invoke has to dispatch them itself.
      window.dispatchEvent(new Event("charts:refresh"));
      window.dispatchEvent(new Event("grid:refresh"));
    });
    await appPage.waitForTimeout(900);
    expect(await backendLayers(), "undo removes the kept layer from the backend").toEqual([]);
    expect(await storeLayers(), "and the store reloaded it").toEqual([]);

    // --- SNAPSHOT: the clipboard write, on this platform ----------------------
    // First the platform probe on its own, so a refusal is named as the
    // platform's and not mistaken for the snapshot's; then the real command.
    const clipboardProbe = await appPage.evaluate(async () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 2;
        canvas.height = 2;
        const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
        if (!blob) return "no blob";
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        return "ok";
      } catch (e) {
        return `refused: ${String(e)}`;
      }
    });
    console.log(`[overlay-journey] clipboard image probe: ${clipboardProbe}`);
    expect(clipboardProbe, "WebView2 must accept an image ClipboardItem, or the snapshot cannot copy").toBe("ok");
    await chartMenu(appPage, box, "Snapshot with points of interest");
    const toast = appPage.locator("[data-toast]").filter({ hasText: /Snapshot copied/ });
    await expect(toast, "the snapshot must report that it reached the clipboard").toBeVisible({ timeout: 10_000 });
    const readBack = await appPage.evaluate(async () => {
      try {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          if (item.types.includes("image/png")) {
            const blob = await item.getType("image/png");
            return `png ${blob.size} bytes`;
          }
        }
        return "no png";
      } catch (e) {
        return `read refused: ${String(e)}`;
      }
    });
    console.log(`[overlay-journey] clipboard read-back: ${readBack}`);
    if (readBack.startsWith("png")) {
      expect(Number(readBack.split(" ")[1]), "the clipboard PNG must be a real image, not the 2x2 probe").toBeGreaterThan(5_000);
    }

    // --- FOLLOW THE DATA: Dec becomes the maximum ----------------------------
    // `setCellValueDirect` writes through `update_cell` and dispatches only the
    // legacy `cell:updated` + a repaint; a user's edit goes through the grid,
    // which also emits `app:cells-updated` WITH the changed cells — the event
    // the Charts extension invalidates on (`chartIntersectsChanges`). Emit
    // what the app emits, so the chain under test is the product's own:
    // invalidate → re-render → announce → recompute → re-anchor.
    await grid.setCellValueDirect(`${DATA_COL_LETTER}13`, "900");
    await appPage.evaluate(() => {
      window.dispatchEvent(new CustomEvent("app:cells-updated", { detail: { changes: [{ row: 12, col: 26 }] } }));
    });
    let movedHighest: OverlayView["cues"][number] | undefined;
    for (let i = 0; i < 20; i++) {
      await appPage.waitForTimeout(500);
      overlay = await overlayOf(appPage, chartId);
      movedHighest = overlay.cues.find((c) => c.description === "Highest Sales");
      if ((movedHighest?.anchor as { categoryLabel?: string } | undefined)?.categoryLabel === "Dec") break;
    }
    await waitForGridStable(appPage);
    console.log(`[overlay-journey] after the data change: ${JSON.stringify(overlay.cues.map((c) => [c.description, (c.anchor as { categoryLabel?: string }).categoryLabel]))}`);
    expect(movedHighest?.anchor, "the ring must follow the data to December").toMatchObject({ categoryIndex: 11, categoryLabel: "Dec" });
    expect(overlay.comments[0]?.anchor?.categoryLabel, "the comment follows its CUE (D-IO-10)").toBe("Dec");
    expect(overlay.comments[0]?.movedFrom, "and says where it was").toBe("Aug");

    // --- HIDE: the cues go, the comment stays, the pixels return -----------
    await chartMenu(appPage, box, "Hide points of interest");
    await appPage.waitForTimeout(600);
    overlay = await overlayOf(appPage, chartId);
    expect(overlay.cues).toEqual([]);
    expect(overlay.comments, "a comment is the reader's; hiding the lens keeps it").toHaveLength(1);

    // --- THE RANGE, through the grid context menu ---------------------------
    await appPage.evaluate(() => (window as unknown as AppWindow).__CALCULA_CHARTS__!.deselectChart?.());
    await appPage.keyboard.press("Escape");
    // CLEAR THE GRID OF FURNITURE FIRST. The grid canvas keeps its FULL WIDTH
    // when a task pane docks — the pane is painted ON TOP of it, it does not
    // shrink the canvas element. So a cell centre computed from grid geometry
    // is always a valid grid coordinate and can still be unclickable, and a
    // click there lands on the pane while the grid state stays exactly as it
    // was: the range simply never forms, with nothing anywhere saying why.
    //
    // Measured live, not guessed: the journey project shares ONE app across
    // spec files, chart-interaction.spec.ts sorts before this one, and it
    // leaves the chart Format pane open — 319x520 at page x>=961. With the
    // viewport parked at AE1 (below), AA13 computes to page x=974, under it.
    // `deselectChart()` + Escape above does NOT close it: that pane belongs to
    // the previous spec's chart, not to ours. Close it the way a user would.
    const paneCloser = appPage.locator('button[title="Close Task Pane"]');
    if (await paneCloser.count()) {
      const leftOver = await appPage.evaluate(() =>
        Array.from(document.querySelectorAll("[data-testid]"))
          .filter((e) => /pane/i.test(e.getAttribute("data-testid") ?? ""))
          .map((e) => e.getAttribute("data-testid")),
      );
      console.log(`[overlay-journey] closing a task pane left open by an earlier spec: ${JSON.stringify(leftOver)}`);
      // `.click()` ON THE ELEMENT, not a synthesised mouse press at its centre.
      // Playwright's click hit-tests the page first, and in a full journey run
      // this timed out for 30s against "<div>…</div> intercepts pointer
      // events" — some other spec's overlay was painted across the button.
      // This is CLEANUP of another spec's residue, not the behaviour under
      // test, so the honest thing is to invoke the product's own close handler
      // on the product's own button and not to assert anything about whether
      // that button was reachable by mouse at this instant.
      await paneCloser.first().evaluate((el: HTMLElement) => el.click());
      await appPage.waitForTimeout(400);
    }
    // The Name Box scrolls MINIMALLY: jumping to Z1 parks Z at the right edge
    // and leaves AA off-canvas, so the shift-click that extends the selection
    // aims at nothing (measured on this spec's first run). Reveal a column
    // past the data first; then both columns are on screen for the gesture.
    await grid.navigateTo("AE1");
    // Then prove the three pixels this section clicks are actually reachable,
    // so the NEXT thing that paints over the grid fails by naming itself
    // rather than as a baffling selection mismatch 40 lines further down.
    await expectGridPixelIsFree(appPage, await grid.cellCenterScrollAware(`${CAT_COL_LETTER}1`), "Z1");
    await expectGridPixelIsFree(appPage, await grid.cellCenterScrollAware(`${DATA_COL_LETTER}13`), "AA13");
    await expectGridPixelIsFree(appPage, await grid.cellCenterScrollAware(`${DATA_COL_LETTER}5`), "AA5");
    await grid.selectRange(`${CAT_COL_LETTER}1`, `${DATA_COL_LETTER}13`);
    await appPage.waitForTimeout(300);
    const sel = await appPage.evaluate(
      () => (window as unknown as { __CALCULA_GRID_STATE__?: { selection?: Record<string, number> } }).__CALCULA_GRID_STATE__?.selection ?? null,
    );
    expect(sel, "POSITIVE CONTROL: the range must really be selected before the menu is asked for it").toMatchObject({
      startRow: 0, startCol: 25, endRow: 12, endCol: 26,
    });
    const cells = await rangeClip(appPage, `${CAT_COL_LETTER}1`, `${DATA_COL_LETTER}13`);
    const cellsOff = await samplePixels(appPage, cells);

    // Right-click INSIDE the selection, in absolute page coordinates.
    const insideClip = await rangeClip(appPage, `${DATA_COL_LETTER}5`, `${DATA_COL_LETTER}5`, 0);
    const insidePoint = { x: insideClip.x + insideClip.width / 2, y: insideClip.y + insideClip.height / 2 };
    await appPage.mouse.click(insidePoint.x, insidePoint.y, { button: "right" });
    const menu = appPage.locator(GRID_MENU);
    await expect(menu, "the grid context menu must open").toBeVisible({ timeout: 5_000 });
    const item = menu.locator('[role="menuitem"]').filter({ hasText: /^Show points of interest$/ });
    await expect(item, "a real rectangle must be offered points of interest").toHaveCount(1);
    await item.click();
    await appPage.waitForTimeout(2500);
    await waitForGridStable(appPage);

    const cellCues = await appPage.evaluate(
      async ({ mod }) => {
        const m = (await (window as unknown as AppWindow).__appImport!(mod)) as {
          listCellCueOwners: () => string[];
          getCellCues: (o: string) => Array<{ description: string; row: number; col: number; sheetIndex: number }>;
        };
        const owners = m.listCellCueOwners();
        return { owners, cues: owners.flatMap((o) => m.getCellCues(o)) };
      },
      { mod: CELL_CUES },
    );
    expect(cellCues.owners, "one owner: the selected rectangle").toHaveLength(1);
    const highestCell = cellCues.cues.find((c) => c.description === "Highest Sales");
    expect(highestCell, `the sheet must mark the highest month's cell; got ${JSON.stringify(cellCues.cues.map((c) => c.description))}`).toBeTruthy();
    // Dec is now 900: row 13 in user terms is row index 12; Sales is column AA = 26.
    expect(highestCell).toMatchObject({ row: 12, col: 26, sheetIndex: 0 });
    const cellsOn = await samplePixels(appPage, cells);
    expect(diffCount(cellsOff, cellsOn), "POSITIVE CONTROL: the cell decoration must be painted").toBeGreaterThan(20);
    await appPage.mouse.move(4, 4);
    await appPage.waitForTimeout(300);
    await takeRegionScreenshot(appPage, "insight-overlay-cells", cells);

    // Hide it through the same menu, whose label has flipped.
    await appPage.mouse.click(insidePoint.x, insidePoint.y, { button: "right" });
    await expect(menu).toBeVisible({ timeout: 5_000 });
    await menu.locator('[role="menuitem"]').filter({ hasText: /^Hide points of interest$/ }).click();
    await appPage.waitForTimeout(600);
    const owners = await appPage.evaluate(
      async ({ mod }) => ((await (window as unknown as AppWindow).__appImport!(mod)) as { listCellCueOwners: () => string[] }).listCellCueOwners(),
      { mod: CELL_CUES },
    );
    expect(owners).toEqual([]);

    // --- Cleanup: the chart, so the shared instance is not left with it -----
    await appPage.evaluate((id: string) => {
      const api = (window as unknown as AppWindow).__CALCULA_CHARTS__;
      api?.deleteChart?.(id);
    }, chartId);
  });
});
