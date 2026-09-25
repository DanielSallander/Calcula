/**
 * CANVAS SHEETS -- proved live.
 *
 * A canvas is a report page: no cells, floating objects on a fixed page with a
 * snap grid (the Power BI report canvas). This journey drives the PRODUCT --
 * the real "+" control, the real ribbon, the real chart store and the real
 * backend -- and asserts what a user would see or keep, never "the call
 * returned OK":
 *
 *   #1 the "+" caret adds a CANVAS (its kind read back from get_sheets, not
 *      from a label); the page has no header gutters; the contextual Canvas
 *      tab arrives SELECTED and leaves with the previous tab restored; typing
 *      on the page creates no cell; the primary "+" still adds a worksheet.
 *   #2 a chart ON the canvas reads its data from Sheet1, and REPAINTS when
 *      Sheet1 changes while the canvas is on screen -- in both directions.
 *   #3 snap: a drag with snap OFF lands exactly where dropped, and with snap
 *      ON at a non-default pitch lands on a multiple -- asserted on the
 *      PERSISTED chart position, not the preview.
 *   #4 save, File > New, reopen: the canvas comes back a canvas, with its
 *      layout and its chart where they were.
 *
 * SHARED APP. Every test ends in File > New inside a `finally`, so the next
 * spec starts on a plain worksheet (the fixture's own Name Box reset would be
 * refused on a canvas). Sheet1's A1:B5 is this spec's data patch.
 */
import type { Page } from "@playwright/test";
import * as os from "node:os";
import * as path from "node:path";
import { test, expect } from "../fixtures";
import { readGridGeometry } from "../helpers/grid";
import { samplePixelGrids, diffCount, type PixelClip } from "../viewportSample";

const SAVED_DOC = path.join(os.tmpdir(), "calcula-canvas-journey.cala");

const CHART_STORE = "/extensions/Charts/lib/chartStore.ts";
const CHART_RENDERER = "/extensions/Charts/rendering/chartRenderer.ts";
const API_LIB = "/src/api/lib.ts";
const API_RANGE = "/src/api/range.ts";
const FILE_API = "/src/core/lib/file-api.ts";

interface AppWindow {
  __calcImport: (u: string) => Promise<unknown>;
  __appImport?: (modulePath: string) => Promise<unknown>;
  __TAURI__: { core: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } };
}

interface SheetRow {
  index: number;
  name: string;
  sheetId?: string;
  kind?: string;
  canvasLayout?: {
    snapToGrid: boolean;
    gridSizePx: number;
    showGrid: boolean;
    pagePreset: string;
    pageWidth: number;
    pageHeight: number;
    background: string;
  };
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

/** Import an app module from the SAME instance the app loaded (stores!). */
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

async function invoke<T = unknown>(page: Page, cmd: string, args: unknown = {}): Promise<T> {
  return page.evaluate(
    async ({ c, a }) => (window as unknown as AppWindow).__TAURI__.core.invoke(c, a),
    { c: cmd, a: args },
  ) as Promise<T>;
}

/** Call an exported function of an app module (product route, same instance). */
async function callModule<T = unknown>(page: Page, mod: string, fn: string, args: unknown[] = []): Promise<T> {
  await installAppImport(page);
  return page.evaluate(
    async ({ mod, fn, args }) => {
      const m = (await (window as unknown as AppWindow).__appImport!(mod)) as Record<string, (...a: unknown[]) => unknown>;
      return (await m[fn](...args)) as unknown;
    },
    { mod, fn, args },
  ) as Promise<T>;
}

async function fileApi(page: Page, fn: string, arg?: string): Promise<void> {
  await page.evaluate(
    async ({ fn, arg, mod }) => {
      const m = (await (window as unknown as AppWindow).__calcImport(new URL(mod, document.baseURI).href)) as Record<
        string,
        (a?: unknown) => Promise<unknown>
      >;
      await m[fn](arg);
    },
    { fn, arg, mod: FILE_API },
  );
}

async function sheetsResult(page: Page): Promise<{ sheets: SheetRow[]; activeIndex: number }> {
  return invoke(page, "get_sheets");
}

async function eventually<T>(probe: () => Promise<T>, ok: (v: T) => boolean, label: string, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T = undefined as T;
  while (Date.now() < deadline) {
    last = await probe();
    if (ok(last)) return last;
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`${label}: still ${JSON.stringify(last)?.slice(0, 400)} after ${timeoutMs}ms`);
}

/** The ribbon's tab strip, exactly as e2e/invariants reads it. */
async function ribbonTabs(page: Page): Promise<Array<{ label: string; active: boolean }>> {
  return page.evaluate(() => {
    const band = document.querySelector("[data-ribbon-content]");
    const strip = band?.parentElement?.querySelector("div");
    return Array.from(strip?.querySelectorAll("button") ?? []).map((b) => ({
      label: (b.textContent ?? "").trim(),
      active: getComputedStyle(b).fontWeight === "600",
    }));
  });
}

/** The grid canvas's top-left in page (CSS) pixels. */
async function gridOrigin(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => {
    const c = document.querySelector("canvas") as HTMLCanvasElement | null;
    if (!c) throw new Error("grid canvas not found");
    const r = c.getBoundingClientRect();
    return { x: r.left, y: r.top };
  });
}

/** Page pixel of a sheet-pixel point on the ACTIVE sheet (canvas: no gutters). */
async function sheetPointToPage(page: Page, sx: number, sy: number): Promise<{ x: number; y: number }> {
  const geo = await readGridGeometry(page);
  const o = await gridOrigin(page);
  return {
    x: o.x + (geo.rowHeaderWidth + sx - geo.scrollX) * geo.zoom,
    y: o.y + (geo.colHeaderHeight + sy - geo.scrollY) * geo.zoom,
  };
}

async function addCanvasViaContextRoute(page: Page): Promise<SheetRow> {
  const before = await sheetsResult(page);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("sheet:requestAdd", { detail: { kind: "canvas" } })));
  const after = await eventually(
    () => sheetsResult(page),
    (r) => r.sheets.length === before.sheets.length + 1 && r.sheets.some((s) => s.kind === "canvas"),
    "no canvas was added",
  );
  return after.sheets.find((s) => s.kind === "canvas")!;
}

/** Seed Sheet1 A1:B5 (Month / Units). Sheet1 must be active. */
async function seedSheet1(page: Page): Promise<void> {
  const rows: Array<[string, string]> = [
    ["Month", "Units"],
    ["Jan", "10"],
    ["Feb", "40"],
    ["Mar", "20"],
    ["Apr", "30"],
  ];
  for (let r = 0; r < rows.length; r++) {
    await invoke(page, "update_cell", { row: r, col: 0, value: rows[r][0] });
    await invoke(page, "update_cell", { row: r, col: 1, value: rows[r][1] });
  }
}

const CHART_X = 70;
const CHART_Y = 70;
const CHART_W = 400;
const CHART_H = 260;

/** Create a bar chart ON the canvas, bound to Sheet1!A1:B5 by sheet id. */
async function chartOnCanvas(page: Page, canvasIndex: number, sheet1Id: string): Promise<string> {
  await installAppImport(page);
  const spec = {
    mark: "bar",
    data: { sheetIndex: 0, sheetId: sheet1Id, startRow: 0, startCol: 0, endRow: 4, endCol: 1 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [{ sourceIndex: 1, name: "Units", color: "#4472C4" }],
    title: "Canvas Journey",
  };
  const id = await page.evaluate(
    async ({ spec, mod, placement }) => {
      const store = (await (window as unknown as AppWindow).__appImport!(mod)) as {
        createChart: (s: unknown, p: Record<string, unknown>) => { chartId: string };
        syncChartRegions: () => void;
      };
      const created = store.createChart(spec, placement);
      store.syncChartRegions();
      return created.chartId;
    },
    {
      spec,
      mod: CHART_STORE,
      placement: { sheetIndex: canvasIndex, x: CHART_X, y: CHART_Y, width: CHART_W, height: CHART_H, name: "CanvasJourney" },
    },
  );
  await eventually(
    () =>
      page.evaluate(
        async ({ id, mod }) => {
          const m = (await (window as unknown as AppWindow).__appImport!(mod)) as {
            getCachedChartData: (id: string) => { hitGeometry: unknown } | null;
          };
          return !!m.getCachedChartData(id)?.hitGeometry;
        },
        { id, mod: CHART_RENDERER },
      ),
    (v) => v,
    "the chart on the canvas never painted",
    15000,
  );
  return id;
}

/** The PERSISTED chart placement, from the backend. */
async function persistedChart(page: Page, chartId: string): Promise<{ x: number; y: number; sheetIndex: number } | null> {
  const charts = await invoke<Array<{ id: string; sheetIndex: number; specJson: string }>>(page, "get_charts");
  const e = charts.find((c) => c.id === chartId);
  if (!e) return null;
  const def = JSON.parse(e.specJson) as { x: number; y: number };
  return { x: def.x, y: def.y, sheetIndex: e.sheetIndex };
}

/** Press inside the chart and drag it by (dx, dy) SHEET px. */
async function dragChart(page: Page, from: { x: number; y: number }, dx: number, dy: number): Promise<void> {
  const geo = await readGridGeometry(page);
  const start = await sheetPointToPage(page, from.x + 40, from.y + 40);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + (dx * geo.zoom) / 2, start.y + (dy * geo.zoom) / 2, { steps: 4 });
  await page.mouse.move(start.x + dx * geo.zoom, start.y + dy * geo.zoom, { steps: 4 });
  await page.mouse.up();
}

// ---------------------------------------------------------------------------
// The journeys
// ---------------------------------------------------------------------------

test.describe.serial("canvas sheets, live", () => {
  test("#1 the + caret adds a canvas: its tab arrives and leaves, it takes no cells, and + still adds a worksheet", async ({
    appPage: page,
  }) => {
    try {
      const prevActive = (await ribbonTabs(page)).find((t) => t.active)?.label;

      await page.locator("[data-add-sheet-menu-trigger]").click();
      await page.locator('[data-add-sheet-kind="canvas"]').click();
      const added = await eventually(
        () => sheetsResult(page),
        (r) => r.sheets.some((s) => s.kind === "canvas"),
        "the caret's Canvas item added no canvas",
      );
      const canvas = added.sheets.find((s) => s.kind === "canvas")!;
      expect(added.activeIndex, "the new canvas is the active sheet").toBe(canvas.index);
      expect(canvas.canvasLayout).toMatchObject({ snapToGrid: true, gridSizePx: 16, pageWidth: 1280, pageHeight: 720 });

      await eventually(
        () => ribbonTabs(page),
        (tabs) => tabs.some((t) => t.label === "Canvas" && t.active),
        "the Canvas tab did not arrive SELECTED",
      );

      const geo = await readGridGeometry(page);
      expect(geo.rowHeaderWidth, "a canvas paints no row headers").toBe(0);
      expect(geo.colHeaderHeight, "a canvas paints no column headers").toBe(0);

      // Click the page and type: nothing lands in the canvas's grid.
      const p = await sheetPointToPage(page, 200, 150);
      await page.mouse.click(p.x, p.y);
      await page.keyboard.type("123");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(400);
      const cells = await invoke<unknown[]>(page, "get_range_cells_typed", {
        startRow: 0,
        startCol: 0,
        endRow: 200,
        endCol: 50,
        sheetIndex: canvas.index,
      });
      expect(cells, "typing on a canvas must create no cell").toEqual([]);

      // Leave: the tab goes, and the tab the user had comes back (not Home).
      await page.locator('button[data-sheet-tab="0"]').click();
      await eventually(
        () => ribbonTabs(page),
        (tabs) => !tabs.some((t) => t.label === "Canvas"),
        "the Canvas tab stayed after leaving the canvas",
      );
      if (prevActive) {
        expect((await ribbonTabs(page)).find((t) => t.active)?.label).toBe(prevActive);
      }
      // ...and the worksheet has its headers back.
      const back = await readGridGeometry(page);
      expect(back.rowHeaderWidth).toBeGreaterThan(0);

      // The primary "+" is still a one-click WORKSHEET.
      const n = (await sheetsResult(page)).sheets.length;
      await page.locator('button[title="Add new sheet"]').click({ force: true });
      const after = await eventually(() => sheetsResult(page), (r) => r.sheets.length === n + 1, "+ added nothing");
      const newest = after.sheets[after.sheets.length - 1];
      expect(newest.kind ?? "worksheet", "the primary + adds a worksheet").toBe("worksheet");
    } finally {
      await fileApi(page, "newFile");
    }
  });

  test("#2 a chart on the canvas reads Sheet1 and repaints when Sheet1 changes (both directions)", async ({
    appPage: page,
  }) => {
    try {
      await seedSheet1(page);
      const sheet1 = (await sheetsResult(page)).sheets.find((s) => s.index === 0)!;
      const canvas = await addCanvasViaContextRoute(page);
      const chartId = await chartOnCanvas(page, canvas.index, sheet1.sheetId!);

      // The data the chart READ is Sheet1's, although the canvas is active.
      const read = await page.evaluate(
        async ({ id, mod }) => {
          const m = (await (window as unknown as AppWindow).__appImport!(mod)) as {
            getCachedChartData: (id: string) => { data?: { series?: Array<{ values: number[] }> } } | null;
          };
          return m.getCachedChartData(id)?.data?.series?.[0]?.values ?? null;
        },
        { id: chartId, mod: CHART_RENDERER },
      );
      expect(read, "the chart on the canvas must plot Sheet1's values").toEqual([10, 40, 20, 30]);

      const tl = await sheetPointToPage(page, CHART_X + 10, CHART_Y + 30);
      const clip: PixelClip = { x: Math.round(tl.x), y: Math.round(tl.y), width: CHART_W - 20, height: CHART_H - 40 };
      const [before] = await samplePixelGrids(page, [clip]);

      // Change Sheet1!B3 through the API's own background-sheet write.
      await page.evaluate(
        async ({ mod }) => {
          const m = (await (window as unknown as AppWindow).__appImport!(mod)) as {
            CellRange: { fromCell: (r: number, c: number, s?: number) => { setValue: (v: string) => Promise<unknown> } };
          };
          await m.CellRange.fromCell(2, 1, 0).setValue("90");
        },
        { mod: API_RANGE },
      );
      await eventually(
        async () => diffCount((await samplePixelGrids(page, [clip]))[0], before),
        (d) => d > 50,
        "the chart on the canvas did not repaint after its Sheet1 source changed",
      );

      // And back: the picture returns to what it was.
      await page.evaluate(
        async ({ mod }) => {
          const m = (await (window as unknown as AppWindow).__appImport!(mod)) as {
            CellRange: { fromCell: (r: number, c: number, s?: number) => { setValue: (v: string) => Promise<unknown> } };
          };
          await m.CellRange.fromCell(2, 1, 0).setValue("40");
        },
        { mod: API_RANGE },
      );
      await eventually(
        async () => diffCount((await samplePixelGrids(page, [clip]))[0], before),
        (d) => d <= 50,
        "restoring the Sheet1 value did not restore the chart",
      );
    } finally {
      await fileApi(page, "newFile");
    }
  });

  test("#3 snap: OFF lands where dropped, ON (pitch 25) lands on a multiple -- in the PERSISTED position", async ({
    appPage: page,
  }) => {
    try {
      await seedSheet1(page);
      const sheet1 = (await sheetsResult(page)).sheets.find((s) => s.index === 0)!;
      const canvas = await addCanvasViaContextRoute(page);
      await callModule(page, API_LIB, "setCanvasLayout", [{ snapToGrid: false, gridSizePx: 25 }, canvas.index]);
      await eventually(
        () => sheetsResult(page),
        (r) => r.sheets.find((s) => s.index === canvas.index)?.canvasLayout?.snapToGrid === false,
        "precondition: snap off",
      );
      await page.waitForTimeout(300);
      const chartId = await chartOnCanvas(page, canvas.index, sheet1.sheetId!);

      // CONTROL: snap OFF -> exactly 70 + 38 = 108.
      await dragChart(page, { x: CHART_X, y: CHART_Y }, 38, 38);
      const off = await eventually(
        () => persistedChart(page, chartId),
        (c) => !!c && c.x !== CHART_X,
        "the snap-off drag was not persisted",
      );
      expect(off).toMatchObject({ x: CHART_X + 38, y: CHART_Y + 38 });

      // Snap ON at a NON-DEFAULT pitch: 108 + 38 = 146 -> 150.
      await callModule(page, API_LIB, "setCanvasLayout", [{ snapToGrid: true }, canvas.index]);
      await page.waitForTimeout(400);
      await dragChart(page, { x: off!.x, y: off!.y }, 38, 38);
      const on = await eventually(
        () => persistedChart(page, chartId),
        (c) => !!c && c.x !== off!.x,
        "the snap-on drag was not persisted",
      );
      expect(on!.x % 25, `snapped x ${on!.x} is on the 25 grid`).toBe(0);
      expect(on!.y % 25, `snapped y ${on!.y} is on the 25 grid`).toBe(0);
      expect(on).toMatchObject({ x: 150, y: 150 });
      expect(on!.sheetIndex, "the chart stays on the canvas").toBe(canvas.index);
    } finally {
      await fileApi(page, "newFile");
    }
  });

  test("#4 save, File > New, reopen: the canvas, its layout and its chart come back", async ({ appPage: page }) => {
    try {
      await seedSheet1(page);
      const sheet1 = (await sheetsResult(page)).sheets.find((s) => s.index === 0)!;
      const canvas = await addCanvasViaContextRoute(page);
      await callModule(page, API_LIB, "setCanvasLayout", [
        { gridSizePx: 24, snapToGrid: false, pagePreset: "custom", pageWidth: 1000, pageHeight: 600, background: "#fafaf0" },
        canvas.index,
      ]);
      const chartId = await chartOnCanvas(page, canvas.index, sheet1.sheetId!);
      await page.waitForTimeout(800); // the chart save is debounced

      await invoke(page, "save_file", { path: SAVED_DOC });
      await fileApi(page, "newFile");
      expect((await sheetsResult(page)).sheets.some((s) => s.kind === "canvas")).toBe(false);

      await fileApi(page, "openFileAtPath", SAVED_DOC);
      const reopened = await eventually(
        () => sheetsResult(page),
        (r) => r.sheets.some((s) => s.kind === "canvas"),
        "the canvas did not survive save and reopen",
      );
      const back = reopened.sheets.find((s) => s.kind === "canvas")!;
      expect(back.name).toBe(canvas.name);
      expect(back.canvasLayout).toMatchObject({
        gridSizePx: 24,
        snapToGrid: false,
        pagePreset: "custom",
        pageWidth: 1000,
        pageHeight: 600,
        background: "#fafaf0",
      });
      const chart = await eventually(
        () => persistedChart(page, chartId),
        (c) => !!c,
        "the canvas's chart did not survive",
      );
      expect(chart).toMatchObject({ x: CHART_X, y: CHART_Y, sheetIndex: back.index });
    } finally {
      await fileApi(page, "newFile");
    }
  });
});
