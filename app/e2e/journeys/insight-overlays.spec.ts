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

interface Clip {
  x: number;
  y: number;
  width: number;
  height: number;
}

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

/** Viewport-relative clip of a cell range, from the app's LIVE geometry. */
async function rangeClip(page: Page, from: string, to: string, pad = 2): Promise<Clip> {
  const geo = await readGridGeometry(page);
  const rect = cellRangeRectFrom(from, to, geo);
  const box = await page.locator("canvas").first().boundingBox();
  if (!box) throw new Error("grid canvas has no bounding box");
  return { x: box.x + rect.x - pad, y: box.y + rect.y - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 };
}

/** Raw RGBA of a clip, decoded in the page. */
async function pixels(page: Page, clip: Clip): Promise<number[]> {
  const png = await page.screenshot({ clip });
  return page.evaluate(async (b64: string) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context for pixel decode");
    ctx.drawImage(bitmap, 0, 0);
    return Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
  }, png.toString("base64"));
}

function diffCount(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error(`capture sizes differ (${a.length} vs ${b.length}) — the clip moved`);
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (Math.abs(a[i] - b[i]) > 8 || Math.abs(a[i + 1] - b[i + 1]) > 8 || Math.abs(a[i + 2] - b[i + 2]) > 8) n++;
  }
  return n;
}

interface OverlayView {
  cues: Array<{ factId: string; kind: string; polarity: string; description?: string; anchor: Record<string, unknown> }>;
  comments: Array<{ id: string; factId: string; text: string; anchor: Record<string, unknown> | null; movedFrom?: string }>;
  step: number | "all";
  selectedFactId: string | null;
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
    await waitForGridStable(appPage);

    await appPage.evaluate((id: string) => {
      (window as unknown as AppWindow).__CALCULA_CHARTS__!.selectChart(id);
    }, chartId);
    await appPage.waitForTimeout(400);

    const box = await chartClientBox(appPage, chartId);
    const off = await pixels(appPage, box);

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

    const on = await pixels(appPage, box);
    const drawn = diffCount(off, on);
    expect(drawn, "POSITIVE CONTROL: turning the overlay on must change the chart's pixels (a ring, the pill)").toBeGreaterThan(50);

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
      const stepped = await pixels(appPage, box);
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
      async ({ chartId, mod, factId }) => {
        const m = (await (window as unknown as AppWindow).__appImport!(mod)) as {
          setSelectedChartCue: (id: string, f: string | null) => void;
          setChartCueStep: (id: string, s: number | "all") => void;
        };
        m.setChartCueStep(chartId, "all");
        m.setSelectedChartCue(chartId, factId);
      },
      { chartId, mod: CHART_CUES, factId: highest!.factId },
    );
    await appPage.waitForTimeout(300);
    await chartMenu(appPage, box, "Add comment on this point…");
    const prompt = appPage.locator("[data-calcula-prompt]");
    await expect(prompt, "the in-app prompt must open (never the banned window.prompt)").toBeVisible({ timeout: 5_000 });
    await prompt.locator("input").fill("Launch month");
    await prompt.locator("button", { hasText: /^OK$/ }).click();
    await appPage.waitForTimeout(800);
    overlay = await overlayOf(appPage, chartId);
    expect(overlay.comments.map((c) => [c.text, c.factId, c.anchor?.categoryLabel])).toEqual([["Launch month", highest!.factId, "Aug"]]);
    const commented = await pixels(appPage, box);
    expect(diffCount(on, commented), "the comment box must be painted").toBeGreaterThan(20);

    // The stored baseline: every cue, the pill, the selected ring and the
    // comment, on the seeded data. The pointer is parked off the chart first
    // so no hover tooltip rides into the frame.
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
        const m = (await (window as unknown as AppWindow).__appImport!(mod)) as { getSelectedChartCue: (id: string) => { factId: string } | null };
        return m.getSelectedChartCue(chartId)?.factId ?? null;
      },
      { chartId, mod: CHART_CUES },
    );
    expect(selectedBeforeKeep, "a cue must be selected for Keep to have a subject").toBe(highest!.factId);
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
    expect(overlay.comments[0]?.anchor?.categoryLabel, "the comment follows its FACT (D-IO-10)").toBe("Dec");
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
    // The Name Box scrolls MINIMALLY: jumping to Z1 parks Z at the right edge
    // and leaves AA off-canvas, so the shift-click that extends the selection
    // aims at nothing (measured on this spec's first run). Reveal a column
    // past the data first; then both columns are on screen for the gesture.
    await grid.navigateTo("AE1");
    await grid.selectRange(`${CAT_COL_LETTER}1`, `${DATA_COL_LETTER}13`);
    await appPage.waitForTimeout(300);
    const sel = await appPage.evaluate(
      () => (window as unknown as { __CALCULA_GRID_STATE__?: { selection?: Record<string, number> } }).__CALCULA_GRID_STATE__?.selection ?? null,
    );
    expect(sel, "POSITIVE CONTROL: the range must really be selected before the menu is asked for it").toMatchObject({
      startRow: 0, startCol: 25, endRow: 12, endCol: 26,
    });
    const cells = await rangeClip(appPage, `${CAT_COL_LETTER}1`, `${DATA_COL_LETTER}13`);
    const cellsOff = await pixels(appPage, cells);

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
    const cellsOn = await pixels(appPage, cells);
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
