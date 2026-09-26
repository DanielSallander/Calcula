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
 *   #5 Collaboration: publish a canvas with a chart and a floating grid, pull
 *      it into a fresh workbook (whose own "Sheet1" forces the pulled data
 *      sheet to be renamed): the canvas arrives a canvas, the chart is bound
 *      to the PULLED data sheet by id and plots its values, the floating grid
 *      sits on the pulled canvas, and the subscribed page refuses a drag.
 *   #6 a pivot on the canvas is a real pivot in the canvas's hidden grid,
 *      painted inside its box and nowhere else; the wheel scrolls the pivot
 *      and not the page; the box shrinks by its handle (persisted, snapped);
 *      a Sheet1 formula reads its output; a slicer on the canvas refilters it
 *      while the canvas is on screen and the formula follows; the box
 *      survives save and reopen.
 *   #7 arrange: a chart and a pivot box overlap; Bring to Front changes what
 *      PAINTS and what a CLICK selects at the overlap, and survives reopen;
 *      Send to Back reverses it; a marquee selects both and Align Left moves
 *      the box to the chart's left edge; an arrow-key nudge lands on the next
 *      snap multiple, persisted, and one Ctrl+Z undoes it.
 *
 * SHARED APP. Every test ends in File > New inside a `finally`, so the next
 * spec starts on a plain worksheet (the fixture's own Name Box reset would be
 * refused on a canvas). Sheet1's A1:B5 is this spec's data patch.
 */
import type { Page } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, expect } from "../fixtures";
import { readGridGeometry } from "../helpers/grid";
import { samplePixelGrids, diffCount, type PixelClip } from "../viewportSample";

const SAVED_DOC = path.join(os.tmpdir(), "calcula-canvas-journey.cala");
const SAVED_PIVOT_DOC = path.join(os.tmpdir(), "calcula-canvas-pivot-journey.cala");
const SAVED_ARRANGE_DOC = path.join(os.tmpdir(), "calcula-canvas-arrange-journey.cala");
const WORKSPACE = path.join(os.tmpdir(), "calcula-canvas-journey-workspace");
const APPLICATION = "canvas-journey";

const CHART_STORE = "/extensions/Charts/lib/chartStore.ts";
const CHART_RENDERER = "/extensions/Charts/rendering/chartRenderer.ts";
const API_LIB = "/src/api/lib.ts";
const API_RANGE = "/src/api/range.ts";
const FILE_API = "/src/core/lib/file-api.ts";
const COLLABORATION = "/src/api/collaboration.ts";
const EVENTS = "/src/api/events.ts";
const FLOATING_RANGES = "/src/api/floatingRanges.ts";
const PIVOT_API = "/extensions/Pivot/lib/pivot-api.ts";
const SLICER_STORE = "/extensions/Slicer/lib/slicerStore.ts";

/** The canvas pivot's box (multiples of the default 16px snap pitch). */
const PIVOT_BOX = { x: 64, y: 64, width: 400, height: 320 };
const PIVOT_ITEMS = 40;
const OBJECT_SELECTION = "/src/api/objectSelection.ts";

/** #7's pivot box, overlapping the chart's lower right (multiples of 16). */
const ARRANGE_BOX = { x: 240, y: 160, width: 320, height: 240 };

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

  test("#5 publish a canvas, pull it into a fresh workbook: page, chart (bound to the PULLED data) and floating grid arrive, read-only", async ({
    appPage: page,
  }) => {
    test.setTimeout(300_000);
    fs.rmSync(WORKSPACE, { recursive: true, force: true });
    fs.mkdirSync(WORKSPACE, { recursive: true });
    try {
      // ---- The publisher: data on Sheet1, a canvas with a chart and a grid.
      await seedSheet1(page);
      const sheet1 = (await sheetsResult(page)).sheets.find((s) => s.index === 0)!;
      const canvas = await addCanvasViaContextRoute(page);
      await callModule(page, API_LIB, "setCanvasLayout", [{ gridSizePx: 24 }, canvas.index]);
      await chartOnCanvas(page, canvas.index, sheet1.sheetId!);
      await callModule(page, FLOATING_RANGES, "createFloatingRange", [640, 80, "CanvasGrid"]);
      await page.waitForTimeout(900); // the chart save is debounced

      const published = await invoke<{ version: string }>(page, "calp_publish", {
        params: {
          registryPath: WORKSPACE,
          packageName: APPLICATION,
          version: "1.0.0",
          kind: "report",
          sheetIndices: [],
          publishedBy: "e2e",
          includeComments: false,
        },
      });
      expect(published.version, "precondition: the application was published").toBe("1.0.0");

      // ---- The subscriber: a fresh workbook whose own "Sheet1" collides.
      await fileApi(page, "newFile");
      const ownSheet1 = (await sheetsResult(page)).sheets.find((s) => s.index === 0)!;
      await callModule(page, COLLABORATION, "subscribeToApplication", [
        { registryPath: WORKSPACE, packageName: APPLICATION, versionPin: "1.0.0" },
      ]);
      // The Subscribe dialog's own announcements after a pull.
      await page.evaluate(
        async ({ mod, app }) => {
          const ev = (await (window as unknown as AppWindow).__appImport!(mod)) as {
            emitAppEvent: (n: string, d?: unknown) => void;
            AppEvents: Record<string, string>;
          };
          ev.emitAppEvent(ev.AppEvents.SHEET_CHANGED, {});
          ev.emitAppEvent(ev.AppEvents.PACKAGE_UPDATED, { packageName: app, version: "1.0.0", kind: "subscribe" });
        },
        { mod: EVENTS, app: APPLICATION },
      );

      const after = await eventually(
        () => sheetsResult(page),
        (r) => r.sheets.some((s) => s.kind === "canvas"),
        "the canvas did not arrive with the pull",
      );
      const pulledCanvas = after.sheets.find((s) => s.kind === "canvas")!;
      expect(pulledCanvas.canvasLayout?.gridSizePx, "the pulled canvas keeps its layout").toBe(24);
      const pulledData = after.sheets.find((s) => s.index !== ownSheet1.index && s.kind !== "canvas");
      expect(pulledData, "the pulled data sheet is present").toBeTruthy();
      expect(pulledData!.name, "a collision with the subscriber's own Sheet1 renames the pulled one").not.toBe("Sheet1");

      // The chart is on the pulled canvas and bound to the PULLED data sheet --
      // neither the publisher's id nor the subscriber's own Sheet1.
      const charts = await invoke<Array<{ id: string; sheetIndex: number; specJson: string }>>(page, "get_charts");
      const chart = charts.find((c) => c.sheetIndex === pulledCanvas.index);
      expect(chart, "the chart arrived on the pulled canvas").toBeTruthy();
      const def = JSON.parse(chart!.specJson) as { spec?: { data?: { sheetId?: string } }; x: number };
      const boundTo = def.spec?.data?.sheetId;
      expect(boundTo).toBe(pulledData!.sheetId);
      expect(boundTo).not.toBe(sheet1.sheetId);
      expect(boundTo).not.toBe(ownSheet1.sheetId);

      // The floating grid is on the pulled canvas.
      const frs = await invoke<Array<{ hostSheetIndex: number; name: string }>>(page, "list_floating_ranges");
      expect(frs.map((f) => f.hostSheetIndex), "the floating grid arrived on the pulled canvas").toContain(pulledCanvas.index);

      // On screen: the chart plots the PULLED values.
      await page.locator(`button[data-sheet-tab="${pulledCanvas.index}"]`).click();
      await eventually(
        () =>
          page.evaluate(
            async ({ id, mod }) => {
              const m = (await (window as unknown as AppWindow).__appImport!(mod)) as {
                getCachedChartData: (id: string) => { data?: { series?: Array<{ values: number[] }> } } | null;
              };
              return m.getCachedChartData(id)?.data?.series?.[0]?.values ?? null;
            },
            { id: chart!.id, mod: CHART_RENDERER },
          ),
        (v) => JSON.stringify(v) === JSON.stringify([10, 40, 20, 30]),
        "the pulled chart did not plot the pulled data",
        15000,
      );

      // A SUBSCRIBED canvas is the publisher's layout: a drag moves nothing.
      await dragChart(page, { x: def.x, y: CHART_Y }, 60, 40);
      await page.waitForTimeout(1200);
      const still = await persistedChart(page, chart!.id);
      expect(still?.x, "a subscribed canvas refuses to move its objects").toBe(def.x);
    } finally {
      await fileApi(page, "newFile");
    }
  });

  test("#6 a pivot on the canvas: it sits in its box, the wheel scrolls it (not the page), nothing paints outside, the box shrinks, a slicer refilters it, and a Sheet1 formula follows", async ({
    appPage: page,
  }) => {
    test.setTimeout(240_000);
    try {
      // ---- Sheet1: 40 items, enough rows to overflow any sensible box.
      await invoke(page, "update_cell", { row: 0, col: 0, value: "Item" });
      await invoke(page, "update_cell", { row: 0, col: 1, value: "Units" });
      for (let i = 1; i <= PIVOT_ITEMS; i++) {
        await invoke(page, "update_cell", { row: i, col: 0, value: `Item ${String(i).padStart(2, "0")}` });
        await invoke(page, "update_cell", { row: i, col: 1, value: String(i) });
      }
      const sheet1 = (await sheetsResult(page)).sheets.find((s) => s.index === 0)!;
      const canvas = await addCanvasViaContextRoute(page);

      // A strip just BELOW the box and one just to its RIGHT: nothing may ever paint there.
      const below = await sheetPointToPage(page, PIVOT_BOX.x, PIVOT_BOX.y + PIVOT_BOX.height + 6);
      const right = await sheetPointToPage(page, PIVOT_BOX.x + PIVOT_BOX.width + 6, PIVOT_BOX.y);
      const outside: PixelClip[] = [
        { x: Math.round(below.x), y: Math.round(below.y), width: PIVOT_BOX.width, height: 40 },
        { x: Math.round(right.x), y: Math.round(right.y), width: 60, height: PIVOT_BOX.height },
      ];
      const insideTl = await sheetPointToPage(page, PIVOT_BOX.x + 8, PIVOT_BOX.y + 30);
      const inside: PixelClip = {
        x: Math.round(insideTl.x),
        y: Math.round(insideTl.y),
        width: PIVOT_BOX.width - 30,
        height: PIVOT_BOX.height - 50,
      };
      const [out0, out1, in0] = await samplePixelGrids(page, [...outside, inside]);

      // ---- The pivot: the same request the canvas-mode Create dialog sends.
      const view = await callModule<{ pivotId: string }>(page, PIVOT_API, "createPivotTable", [
        {
          sourceRange: `${sheet1.name}!A1:B${PIVOT_ITEMS + 1}`,
          destinationCell: "A1",
          sourceSheet: sheet1.index,
          destinationSheet: canvas.index,
          hasHeaders: true,
          name: "CanvasPivot",
          canvasFrame: { ...PIVOT_BOX, frozenHeaders: true },
        },
      ]);
      const pivotId = String(view.pivotId);
      await callModule(page, PIVOT_API, "updatePivotFields", [
        {
          pivotId,
          rowFields: [{ sourceIndex: 0, name: "Item" }],
          valueFields: [{ sourceIndex: 1, name: "Sum of Units", aggregation: "sum" }],
        },
      ]);
      await page.evaluate(() => window.dispatchEvent(new Event("pivot:refresh")));

      // The pivot is a REAL pivot in the canvas's hidden grid ...
      type Region = { pivotId: string; startRow: number; startCol: number; canvasFrame?: typeof PIVOT_BOX };
      const regionsOf = () => invoke<Region[]>(page, "get_pivot_regions_for_sheet");
      const regions = await eventually(
        regionsOf,
        (r) => r.some((x) => String(x.pivotId) === pivotId && !!x.canvasFrame),
        "the canvas pivot's region carries no frame",
      );
      const region = regions.find((x) => String(x.pivotId) === pivotId)!;
      expect(region.canvasFrame).toMatchObject(PIVOT_BOX);
      expect(region.startCol % 1024, "the anchor is a canvas pivot block").toBe(0);
      const cells = await invoke<Array<{ display: string }>>(page, "get_range_cells_typed", {
        sheetIndex: canvas.index,
        startRow: region.startRow,
        startCol: region.startCol,
        endRow: region.startRow + PIVOT_ITEMS + 3,
        endCol: region.startCol + 1,
      });
      expect(cells.map((c) => c.display), "the pivot's output cells exist on the canvas").toContain("Item 40");

      // ... painted inside its box and NOWHERE else.
      await eventually(
        async () => diffCount((await samplePixelGrids(page, [inside]))[0], in0),
        (d) => d > 200,
        "the canvas pivot did not paint inside its box",
        15000,
      );
      const [o0, o1] = await samplePixelGrids(page, outside);
      expect(diffCount(o0, out0), "nothing paints below the box").toBe(0);
      expect(diffCount(o1, out1), "nothing paints right of the box").toBe(0);

      // ---- The wheel scrolls the PIVOT, not the page.
      type Visual = { scroll: { top: number; left: number }; box: typeof PIVOT_BOX; selected: boolean };
      const visual = () =>
        page.evaluate((id) => {
          const hook = (window as unknown as { __CALCULA_PIVOT__?: { getVisualState: (id: string) => Visual | null } })
            .__CALCULA_PIVOT__;
          return hook?.getVisualState(id) ?? null;
        }, pivotId);
      await eventually(visual, (v) => !!v, "the pivot box never painted a record");
      const geoBefore = await readGridGeometry(page);
      const [beforeWheel] = await samplePixelGrids(page, [inside]);
      const centre = await sheetPointToPage(page, PIVOT_BOX.x + PIVOT_BOX.width / 2, PIVOT_BOX.y + PIVOT_BOX.height / 2);
      await page.mouse.move(centre.x, centre.y);
      await page.mouse.wheel(0, 240);
      await eventually(visual, (v) => (v?.scroll.top ?? 0) > 0, "the wheel did not scroll the pivot");
      const geoAfter = await readGridGeometry(page);
      expect(geoAfter.scrollY, "the page did not scroll").toBe(geoBefore.scrollY);
      await eventually(
        async () => diffCount((await samplePixelGrids(page, [inside]))[0], beforeWheel),
        (d) => d > 100,
        "the scrolled pivot did not repaint its rows",
      );
      const [o0b, o1b] = await samplePixelGrids(page, outside);
      expect(diffCount(o0b, out0), "a scrolled pivot still paints nothing below its box").toBe(0);
      expect(diffCount(o1b, out1), "a scrolled pivot still paints nothing right of its box").toBe(0);

      // ---- Shrink the box by its bottom-right handle; the PERSISTED frame follows (snapped to 16).
      const body = await sheetPointToPage(page, PIVOT_BOX.x + 40, PIVOT_BOX.y + 8);
      await page.mouse.click(body.x, body.y);
      await eventually(visual, (v) => !!v?.selected, "a click did not select the pivot box");
      const geo = await readGridGeometry(page);
      const corner = await sheetPointToPage(page, PIVOT_BOX.x + PIVOT_BOX.width - 1, PIVOT_BOX.y + PIVOT_BOX.height - 1);
      await page.mouse.move(corner.x, corner.y);
      await page.mouse.down();
      await page.mouse.move(corner.x - 40 * geo.zoom, corner.y - 32 * geo.zoom, { steps: 4 });
      await page.mouse.move(corner.x - 80 * geo.zoom, corner.y - 64 * geo.zoom, { steps: 4 });
      await page.mouse.up();
      const shrunk = await eventually(
        regionsOf,
        (r) => (r.find((x) => String(x.pivotId) === pivotId)?.canvasFrame?.width ?? 0) < PIVOT_BOX.width,
        "the resized box was not persisted",
      );
      const frame = shrunk.find((x) => String(x.pivotId) === pivotId)!.canvasFrame!;
      expect(frame).toMatchObject({
        x: PIVOT_BOX.x,
        y: PIVOT_BOX.y,
        width: PIVOT_BOX.width - 80,
        height: PIVOT_BOX.height - 64,
      });

      // ---- A Sheet1 formula reads the canvas pivot's output ...
      await page.evaluate(
        async ({ mod, f }) => {
          const m = (await (window as unknown as AppWindow).__appImport!(mod)) as {
            CellRange: { fromCell: (r: number, c: number, s?: number) => { setValue: (v: string) => Promise<unknown> } };
          };
          await m.CellRange.fromCell(0, 3, 0).setValue(f);
        },
        { mod: API_RANGE, f: `=SUM('${canvas.name}'!B1:B200)` },
      );
      const total = (PIVOT_ITEMS * (PIVOT_ITEMS + 1)) / 2;
      const readD1 = async () =>
        (
          await invoke<Array<{ value: unknown }>>(page, "get_range_cells_typed", {
            sheetIndex: 0,
            startRow: 0,
            startCol: 3,
            endRow: 0,
            endCol: 3,
          })
        )[0]?.value;
      // The items plus the grand total: twice the sum.
      await eventually(readD1, (v) => Number(v) === 2 * total, "the Sheet1 formula does not read the canvas pivot");

      // ---- ... and a SLICER on the canvas refilters the pivot; the formula
      // follows while the CANVAS is on screen (the cross-sheet cascade).
      const slicer = await callModule<{ id: string } | null>(page, SLICER_STORE, "createSlicerAsync", [
        {
          name: "ItemSlicer",
          sheetIndex: canvas.index,
          x: 720,
          y: 64,
          width: 200,
          height: 260,
          sourceType: "pivot",
          cacheSourceId: pivotId,
          fieldName: "Item",
          connectedSources: [{ sourceType: "pivot", sourceId: pivotId }],
        },
      ]);
      expect(slicer, "the slicer was created on the canvas").toBeTruthy();
      const [beforeFilter] = await samplePixelGrids(page, [inside]);
      await callModule(page, SLICER_STORE, "updateSlicerSelectionAsync", [slicer!.id, ["Item 01", "Item 02", "Item 03"]]);
      await eventually(
        readD1,
        (v) => Number(v) === 2 * 6,
        "the slicer did not refilter the canvas pivot (or the Sheet1 formula did not follow)",
        15000,
      );
      await eventually(
        async () => diffCount((await samplePixelGrids(page, [inside]))[0], beforeFilter),
        (d) => d > 100,
        "the refiltered pivot did not repaint in its box",
      );
      expect((await sheetsResult(page)).activeIndex, "the canvas stayed on screen throughout").toBe(canvas.index);

      // ---- Save, File > New, reopen: the box (and the pivot on the canvas) come back.
      await invoke(page, "save_file", { path: SAVED_PIVOT_DOC });
      await fileApi(page, "newFile");
      await fileApi(page, "openFileAtPath", SAVED_PIVOT_DOC);
      const reopened = await eventually(
        () => sheetsResult(page),
        (r) => r.sheets.some((s) => s.kind === "canvas"),
        "the canvas did not survive save and reopen",
      );
      const back = reopened.sheets.find((s) => s.kind === "canvas")!;
      await page.locator(`button[data-sheet-tab="${back.index}"]`).click();
      const again = await eventually(
        regionsOf,
        (r) => r.some((x) => String(x.pivotId) === pivotId && !!x.canvasFrame),
        "the canvas pivot's box did not survive save and reopen",
      );
      expect(again.find((x) => String(x.pivotId) === pivotId)!.canvasFrame).toMatchObject(frame);
    } finally {
      await fileApi(page, "newFile");
    }
  });

  test("#7 arrange: Bring to Front changes what paints AND what a click selects at an overlap, survives reopen; marquee + Align Left; a snapped nudge is one undo step", async ({
    appPage: page,
  }) => {
    test.setTimeout(300_000);
    try {
      await seedSheet1(page);
      const sheet1 = (await sheetsResult(page)).sheets.find((s) => s.index === 0)!;
      const canvas = await addCanvasViaContextRoute(page);
      const chartId = await chartOnCanvas(page, canvas.index, sheet1.sheetId!);

      // A pivot box over the chart's lower right: two FAMILIES overlapping.
      const view = await callModule<{ pivotId: string }>(page, PIVOT_API, "createPivotTable", [
        {
          sourceRange: `${sheet1.name}!A1:B5`,
          destinationCell: "A1",
          sourceSheet: sheet1.index,
          destinationSheet: canvas.index,
          hasHeaders: true,
          name: "ArrangePivot",
          canvasFrame: { ...ARRANGE_BOX, frozenHeaders: true },
        },
      ]);
      const pivotId = String(view.pivotId);
      await callModule(page, PIVOT_API, "updatePivotFields", [
        {
          pivotId,
          rowFields: [{ sourceIndex: 0, name: "Month" }],
          valueFields: [{ sourceIndex: 1, name: "Sum of Units", aggregation: "sum" }],
        },
      ]);
      await page.evaluate(() => window.dispatchEvent(new Event("pivot:refresh")));
      await eventually(
        () => invoke<Array<{ pivotId: string; canvasFrame?: unknown }>>(page, "get_pivot_regions_for_sheet"),
        (r) => r.some((x) => String(x.pivotId) === pivotId && !!x.canvasFrame),
        "the pivot box never arrived",
      );
      await page.waitForTimeout(800);

      const primaryType = () =>
        callModule<{ type: string } | null>(page, OBJECT_SELECTION, "getPrimaryObjectRegion", []).then((r) => r?.type ?? null);
      const clickAt = async (sx: number, sy: number) => {
        const p = await sheetPointToPage(page, sx, sy);
        await page.mouse.click(p.x, p.y);
      };
      // The overlap: inside the chart (70..470 x 70..330) AND the box (240..560 x 160..400).
      const overlap = { x: 360, y: 250 };
      const patchAt = async () => {
        const p = await sheetPointToPage(page, overlap.x - 30, overlap.y - 20);
        return { x: Math.round(p.x), y: Math.round(p.y), width: 60, height: 40 } as PixelClip;
      };
      const clip = await patchAt();

      // Select the pivot box where it is alone, then Bring to Front.
      await clickAt(ARRANGE_BOX.x + ARRANGE_BOX.width - 30, ARRANGE_BOX.y + ARRANGE_BOX.height - 30);
      await eventually(primaryType, (t) => t === "pivot-visual", "a click on the box alone did not select it");
      const [beforeFront] = await samplePixelGrids(page, [clip]);
      await page.locator('[data-testid="canvas-arrange-forward"]').click();
      await page.locator('[data-testid="canvas-arrange-bring-to-front"]').click();
      await eventually(
        () => sheetsResult(page),
        (r) => ((r.sheets.find((s) => s.index === canvas.index)?.canvasLayout as { zOrder?: unknown[] } | undefined)?.zOrder?.length ?? 0) >= 2,
        "Bring to Front wrote no z-order",
      );
      await eventually(
        async () => diffCount((await samplePixelGrids(page, [clip]))[0], beforeFront),
        (d) => d > 100,
        "the box brought to front did not paint over the chart at the overlap",
      );

      // What a click selects follows what paints.
      await clickAt(20, 20); // empty page: deselect
      await clickAt(overlap.x, overlap.y);
      await eventually(primaryType, (t) => t === "pivot-visual", "a click at the overlap did not select the box on top");

      // The order survives save / reopen.
      await invoke(page, "save_file", { path: SAVED_ARRANGE_DOC });
      await fileApi(page, "newFile");
      await fileApi(page, "openFileAtPath", SAVED_ARRANGE_DOC);
      const reopened = await eventually(
        () => sheetsResult(page),
        (r) => r.sheets.some((s) => s.kind === "canvas"),
        "the canvas did not survive save and reopen",
      );
      const back = reopened.sheets.find((s) => s.kind === "canvas")!;
      await page.locator(`button[data-sheet-tab="${back.index}"]`).click();
      await page.waitForTimeout(1500);
      await clickAt(overlap.x, overlap.y);
      await eventually(primaryType, (t) => t === "pivot-visual", "after reopening, the box was no longer on top");

      // Send to Back: the chart is on top again, for paint and for clicks.
      await page.locator('[data-testid="canvas-arrange-backward"]').click();
      await page.locator('[data-testid="canvas-arrange-send-to-back"]').click();
      // ONE click, then poll: re-clicking inside the poll can land two clicks
      // inside the double-click interval, which is a different gesture on a chart.
      await clickAt(20, 20);
      await page.waitForTimeout(600);
      await clickAt(overlap.x, overlap.y);
      await eventually(primaryType, (t) => t === "chart", "after Send to Back a click at the overlap did not select the chart");

      // Marquee both (from the empty page), Align Left: both land on the leftmost x.
      await clickAt(20, 20);
      const from = await sheetPointToPage(page, 20, 20);
      const to = await sheetPointToPage(page, ARRANGE_BOX.x + ARRANGE_BOX.width + 20, ARRANGE_BOX.y + ARRANGE_BOX.height + 20);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 5 });
      await page.mouse.move(to.x, to.y, { steps: 5 });
      await page.mouse.up();
      await eventually(
        () => callModule<unknown[]>(page, OBJECT_SELECTION, "getSelectedObjectRegions", []).then((r) => r.length),
        (n) => n === 2,
        "the marquee did not select both objects",
      );
      await page.locator('[data-testid="canvas-arrange-align"]').click();
      await page.locator('[data-testid="canvas-arrange-align-left"]').click();
      const pivotFrame = async () =>
        (await invoke<Array<{ pivotId: string; canvasFrame?: { x: number; y: number } }>>(page, "get_pivot_regions_for_sheet")).find(
          (x) => String(x.pivotId) === pivotId,
        )?.canvasFrame;
      await eventually(pivotFrame, (f) => f?.x === CHART_X, "Align Left did not move the box to the chart's left edge");
      expect((await persistedChart(page, chartId))?.x, "the leftmost object stays put").toBe(CHART_X);

      // Nudge: select the chart where it is alone, ArrowRight -> next 16px multiple, persisted; one Ctrl+Z undoes it.
      await clickAt(20, 20);
      await page.waitForTimeout(600);
      await clickAt(CHART_X + 30, CHART_Y + 20);
      await eventually(primaryType, (t) => t === "chart", "a click on the chart alone did not select it").catch(async (e) => {
        const selected = await callModule<Array<{ type: string }>>(page, OBJECT_SELECTION, "getSelectedObjectRegions", []);
        const chartSel = await callModule<unknown>(page, "/src/api/chartSelection.ts", "getChartSelection", []);
        throw new Error(`${String(e)} | selected=${JSON.stringify(selected.map((r) => r.type))} chart=${JSON.stringify(chartSel)}`);
      });
      await page.keyboard.press("ArrowRight");
      const nudged = await eventually(
        () => persistedChart(page, chartId),
        (c) => (c?.x ?? CHART_X) !== CHART_X,
        "the nudge was not persisted",
      );
      expect(nudged!.x, "snap on: a nudge moves to the NEXT grid multiple").toBe(Math.ceil((CHART_X + 1) / 16) * 16);
      await page.keyboard.press("Control+z");
      await eventually(
        () => persistedChart(page, chartId),
        (c) => c?.x === CHART_X,
        "one Ctrl+Z did not undo the nudge",
      );
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
