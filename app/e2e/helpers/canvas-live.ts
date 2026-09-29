/**
 * Plumbing for the canvas live journeys (fixall-canvas.spec.ts).
 *
 * Everything here drives the PRODUCT the way the canvas journey does: app
 * modules are reached through the SAME instance the app loaded (`__appImport`,
 * so module state -- the object clipboard, the selection set, the chart store --
 * is the app's own), the backend is read through `invoke`, and the pointer is
 * real (page.mouse) at points computed from the objects' own published regions.
 *
 * Nothing in here asserts. It reads and it acts; the spec decides.
 */
import type { Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { readGridGeometry } from "./grid";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WINDOW_LISTER = path.join(HERE, "..", "list-app-windows.ps1");
const DIALOG_DRIVER = path.join(HERE, "..", "answer-native-dialog.ps1");

export const MOD = {
  FILE_API: "/src/core/lib/file-api.ts",
  TAURI_API: "/src/core/lib/tauri-api.ts",
  BACKEND: "/src/api/backend.ts",
  API_LIB: "/src/api/lib.ts",
  API_RANGE: "/src/api/range.ts",
  GRID_API: "/src/api/grid.ts",
  EVENTS: "/src/api/events.ts",
  GRID_OVERLAYS: "/src/api/gridOverlays.ts",
  OBJ_SEL: "/src/api/objectSelection.ts",
  OBJ_CLIP: "/src/api/objectClipboard.ts",
  CHART_SELECTION: "/src/api/chartSelection.ts",
  CONTROLS_SERVICE: "/src/api/controlsService.ts",
  FLOATING_RANGES: "/src/api/floatingRanges.ts",
  COLLABORATION: "/src/api/collaboration.ts",
  CHART_STORE: "/extensions/Charts/lib/chartStore.ts",
  CHART_RENDERER: "/extensions/Charts/rendering/chartRenderer.ts",
  CHART_MENU_STATE: "/extensions/Charts/lib/chartMenuState.ts",
  CANVAS_ACTIONS: "/extensions/CanvasSheet/lib/canvasActions.ts",
  PROTECTION_STORE: "/extensions/Protection/lib/protectionStore.ts",
  PIVOT_API: "/extensions/Pivot/lib/pivot-api.ts",
  SLICER_STORE: "/extensions/Slicer/lib/slicerStore.ts",
  TIMELINE_STORE: "/extensions/TimelineSlicer/lib/timelineSlicerStore.ts",
} as const;

export interface AppWindow {
  __calcImport: (u: string) => Promise<unknown>;
  __appImport?: (modulePath: string) => Promise<unknown>;
  __TAURI__: { core: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } };
  __e2eToasts?: Array<{ text: string; variant: string | null; at: number }>;
  __e2eToastObs?: MutationObserver;
  __e2eToastSeen?: WeakSet<Element>;
}

export interface SheetRow {
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
    zOrder?: Array<{ kind: string; id: string }>;
    locked?: Array<{ kind: string; id: string }>;
  };
}

// ---------------------------------------------------------------------------
// Module + backend access
// ---------------------------------------------------------------------------

/** Import an app module from the SAME instance the app loaded (stores!). */
export async function installAppImport(page: Page): Promise<void> {
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

/** A page call that cannot hang the test (`page.evaluate` has no timeout). */
export async function bounded<T>(label: string, p: Promise<T>, ms = 30_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}: no answer within ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function invoke<T = unknown>(page: Page, cmd: string, args: unknown = {}): Promise<T> {
  return bounded(
    `invoke ${cmd}`,
    page.evaluate(
      async ({ c, a }) => (window as unknown as AppWindow).__TAURI__.core.invoke(c, a),
      { c: cmd, a: args },
    ) as Promise<T>,
  );
}

/** Like `invoke`, but a rejection comes back as `{ error }` instead of throwing. */
export async function tryInvoke<T = unknown>(page: Page, cmd: string, args: unknown = {}): Promise<{ ok: T } | { error: string }> {
  return bounded(
    `invoke ${cmd}`,
    page.evaluate(
      async ({ c, a }) => {
        try {
          return { ok: await (window as unknown as AppWindow).__TAURI__.core.invoke(c, a) };
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) };
        }
      },
      { c: cmd, a: args },
    ) as Promise<{ ok: T } | { error: string }>,
  );
}

/** Call an exported function of an app module (product route, same instance). */
export async function callModule<T = unknown>(page: Page, mod: string, fn: string, args: unknown[] = []): Promise<T> {
  await installAppImport(page);
  return bounded(
    `${mod}#${fn}`,
    page.evaluate(
      async ({ mod, fn, args }) => {
        const m = (await (window as unknown as AppWindow).__appImport!(mod)) as Record<string, (...a: unknown[]) => unknown>;
        if (typeof m[fn] !== "function") throw new Error(`${mod} has no export ${fn}`);
        return (await m[fn](...args)) as unknown;
      },
      { mod, fn, args },
    ) as Promise<T>,
  );
}

/** The app's own File > New (never a raw new_file: BUG-0205). */
export async function newFile(page: Page): Promise<void> {
  await callModule(page, MOD.FILE_API, "newFile");
  await page.waitForTimeout(400);
}

export async function openFileAtPath(page: Page, file: string): Promise<void> {
  await callModule(page, MOD.FILE_API, "openFileAtPath", [file]);
  await page.waitForTimeout(600);
}

export async function eventually<T>(probe: () => Promise<T>, ok: (v: T) => boolean, label: string, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T = undefined as T;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      last = await probe();
      lastErr = null;
      if (ok(last)) return last;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(
    `${label}: still ${JSON.stringify(last)?.slice(0, 600)} after ${timeoutMs}ms` +
      (lastErr ? ` (last probe error: ${String(lastErr).slice(0, 300)})` : ""),
  );
}

export async function sheetsResult(page: Page): Promise<{ sheets: SheetRow[]; activeIndex: number }> {
  return invoke(page, "get_sheets");
}

export async function isDirty(page: Page): Promise<boolean> {
  return invoke<boolean>(page, "is_file_modified");
}

export async function undoState(page: Page): Promise<{ canUndo: boolean; canRedo: boolean; undoDescription: string | null; redoDescription?: string | null }> {
  return invoke(page, "get_undo_state");
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** The grid canvas's top-left in page (CSS) pixels, and its size. */
export async function gridBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  return page.evaluate(() => {
    const c = document.querySelector("canvas") as HTMLCanvasElement | null;
    if (!c) throw new Error("grid canvas not found");
    const r = c.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  });
}

/** Page pixel of a sheet-pixel point on the ACTIVE sheet. */
export async function sheetPointToPage(page: Page, sx: number, sy: number): Promise<{ x: number; y: number }> {
  const geo = await readGridGeometry(page);
  const o = await gridBox(page);
  return {
    x: o.x + (geo.rowHeaderWidth + sx - geo.scrollX) * geo.zoom,
    y: o.y + (geo.colHeaderHeight + sy - geo.scrollY) * geo.zoom,
  };
}

/** The ribbon's tab strip, exactly as e2e/invariants reads it. */
export async function ribbonTabs(page: Page): Promise<Array<{ label: string; active: boolean }>> {
  return page.evaluate(() => {
    const band = document.querySelector("[data-ribbon-content]");
    const strip = band?.parentElement?.querySelector("div");
    return Array.from(strip?.querySelectorAll("button") ?? []).map((b) => ({
      label: (b.textContent ?? "").trim(),
      active: getComputedStyle(b).fontWeight === "600",
    }));
  });
}

export async function hasRibbonTab(page: Page, label: string): Promise<boolean> {
  return (await ribbonTabs(page)).some((t) => t.label === label);
}

/** Hand the keyboard to the grid container (the canvas bindings require it). */
export async function focusGrid(page: Page): Promise<void> {
  await page.locator("[data-focus-container='spreadsheet']").focus();
  await page.waitForTimeout(60);
}

/** Press a key combination with the grid focused. */
export async function gridKey(page: Page, combo: string): Promise<void> {
  await focusGrid(page);
  await page.keyboard.press(combo);
}

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

/** Seed Sheet1 A1:C5 (Month / Units / Date). Sheet1 must be active. */
export async function seedSheet1(page: Page): Promise<void> {
  const rows: Array<[string, string, string]> = [
    ["Month", "Units", "Day"],
    ["Jan", "10", "2026-01-15"],
    ["Feb", "40", "2026-02-15"],
    ["Mar", "20", "2026-03-15"],
    ["Apr", "30", "2026-04-15"],
  ];
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < 3; c++) {
      await invoke(page, "update_cell", { row: r, col: c, value: rows[r][c] });
    }
  }
}

/** Add a canvas through the tab strip's own add route; it becomes active. */
export async function addCanvas(page: Page): Promise<SheetRow> {
  const before = await sheetsResult(page);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("sheet:requestAdd", { detail: { kind: "canvas" } })));
  const after = await eventually(
    () => sheetsResult(page),
    (r) => r.sheets.length === before.sheets.length + 1 && r.sheets[r.activeIndex]?.kind === "canvas",
    "no canvas was added",
  );
  await page.waitForTimeout(300);
  return after.sheets[after.activeIndex];
}

/** Add a worksheet through the tab strip's own add route; it becomes active. */
export async function addWorksheet(page: Page): Promise<SheetRow> {
  const before = await sheetsResult(page);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("sheet:requestAdd", { detail: null })));
  const after = await eventually(
    () => sheetsResult(page),
    (r) => r.sheets.length === before.sheets.length + 1,
    "no worksheet was added",
  );
  await page.waitForTimeout(300);
  return after.sheets[after.sheets.length - 1];
}

/** Patch the ACTIVE canvas's layout through the Canvas tab's own route. */
export async function patchActiveCanvas(page: Page, patch: Record<string, unknown>): Promise<void> {
  const ok = await callModule<boolean>(page, MOD.CANVAS_ACTIONS, "patchActiveCanvasLayout", [patch]);
  if (!ok) throw new Error(`patchActiveCanvasLayout(${JSON.stringify(patch)}) was refused`);
  await page.waitForTimeout(200);
}

export async function clickSheetTab(page: Page, index: number): Promise<void> {
  await page.locator(`button[data-sheet-tab="${index}"]`).click();
  await page.waitForTimeout(300);
}

// ---------------------------------------------------------------------------
// Objects
// ---------------------------------------------------------------------------

export interface Obj {
  id: string;
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
  selected: boolean;
  label: string | null;
  refKey: string | null;
  chartId: string | null;
}

/** Every floating object published for the ACTIVE sheet, in paint order, with its selection state. */
export async function objects(page: Page): Promise<Obj[]> {
  await installAppImport(page);
  return bounded(
    "objects",
    page.evaluate(
      async ({ ov, os }) => {
        const w = window as unknown as AppWindow;
        const g = (await w.__appImport!(ov)) as {
          getGridRegions: () => Array<{ id: string; type: string; floating?: { x: number; y: number; width: number; height: number }; data?: Record<string, unknown> }>;
        };
        const s = (await w.__appImport!(os)) as {
          selectableFloatingRegions: (r?: unknown) => Array<{ id: string; type: string; floating?: { x: number; y: number; width: number; height: number }; data?: Record<string, unknown> }>;
          isObjectInSelection: (r: unknown) => boolean;
          objectLabelOf: (r: unknown) => string | null;
          objectRefOf: (r: unknown) => { kind: string; id: string } | null;
        };
        return s.selectableFloatingRegions(g.getGridRegions()).map((r) => {
          const ref = s.objectRefOf(r);
          return {
            id: r.id,
            type: r.type,
            x: r.floating?.x ?? NaN,
            y: r.floating?.y ?? NaN,
            w: r.floating?.width ?? NaN,
            h: r.floating?.height ?? NaN,
            selected: s.isObjectInSelection(r),
            label: s.objectLabelOf(r),
            refKey: ref ? `${ref.kind}:${ref.id}` : null,
            chartId: typeof r.data?.chartId === "string" ? (r.data.chartId as string) : null,
          };
        });
      },
      { ov: MOD.GRID_OVERLAYS, os: MOD.OBJ_SEL },
    ),
  );
}

export async function selectedObjects(page: Page): Promise<Obj[]> {
  return (await objects(page)).filter((o) => o.selected);
}

/**
 * Click an object. `at` is the point inside it, in the object's own px
 * (default: 24,24 -- inside the body, clear of the 10 px corner handles that a
 * press on ANY resizable floating object grabs, selected or not).
 */
export async function clickObject(
  page: Page,
  o: { x: number; y: number; w: number; h: number },
  opts: { ctrl?: boolean; right?: boolean; at?: { dx: number; dy: number } } = {},
): Promise<void> {
  const at = opts.at ?? { dx: 24, dy: 24 };
  const p = await sheetPointToPage(page, o.x + at.dx, o.y + at.dy);
  if (opts.ctrl) await page.keyboard.down("Control");
  try {
    await humanClick(page, p.x, p.y, opts.right ? "right" : "left");
  } finally {
    if (opts.ctrl) await page.keyboard.up("Control");
  }
  await page.waitForTimeout(250);
}

/**
 * A click the way a hand makes one: move, press, hold ~60 ms, release. Playwright's
 * `mouse.click` releases in the same instant it presses (a touchpad tap does the
 * same); the helpers use this so an instant-release defect is proved by ONE
 * named test (see the spec) instead of breaking every set-up.
 */
export async function humanClick(page: Page, x: number, y: number, button: "left" | "right" = "left"): Promise<void> {
  await page.mouse.move(x, y);
  await page.mouse.down({ button });
  await page.waitForTimeout(60);
  await page.mouse.up({ button });
}

/** Drag from a point inside an object by (dx, dy) SHEET px, in several steps. */
export async function dragObject(
  page: Page,
  o: { x: number; y: number },
  path: Array<{ dx: number; dy: number }>,
  at: { dx: number; dy: number } = { dx: 20, dy: 20 },
): Promise<void> {
  const geo = await readGridGeometry(page);
  const start = await sheetPointToPage(page, o.x + at.dx, o.y + at.dy);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (const step of path) {
    await page.mouse.move(start.x + step.dx * geo.zoom, start.y + step.dy * geo.zoom, { steps: 6 });
  }
  await page.mouse.up();
  await page.waitForTimeout(300);
}

/** Click an empty point of the page (deselects everything). */
export async function clickEmpty(page: Page, sx: number, sy: number): Promise<void> {
  const p = await sheetPointToPage(page, sx, sy);
  await humanClick(page, p.x, p.y);
  await page.waitForTimeout(250);
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

export function barSpec(sheetId: string | undefined, title: string, sheetIndex = 0): Record<string, unknown> {
  return {
    mark: "bar",
    data: { sheetIndex, ...(sheetId ? { sheetId } : {}), startRow: 0, startCol: 0, endRow: 4, endCol: 1 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [{ sourceIndex: 1, name: "Units", color: "#4472C4" }],
    title,
  };
}

/** Create a chart through the store and WAIT until the backend holds it; returns its id. */
export async function createChart(
  page: Page,
  spec: Record<string, unknown>,
  placement: { sheetIndex: number; x: number; y: number; width: number; height: number; name?: string },
  opts: { waitPaint?: boolean } = {},
): Promise<string> {
  const res = await callModule<{ chart: { chartId: string } | null; refusal: string | null }>(page, MOD.CHART_STORE, "createChartLanded", [
    spec,
    placement,
  ]);
  if (!res.chart) throw new Error(`the chart was refused: ${res.refusal}`);
  await callModule(page, MOD.CHART_STORE, "syncChartRegions");
  const id = res.chart.chartId;
  if (opts.waitPaint !== false) {
    await eventually(() => chartData(page, id).then((d) => !!d), (v) => v, `chart ${id} never painted`, 15000);
  }
  return id;
}

export interface PersistedChart {
  id: string;
  sheetIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  name: string;
  spec: Record<string, unknown> & { title?: unknown; data?: Record<string, unknown> };
}

/** The PERSISTED charts, from the backend. */
export async function persistedCharts(page: Page): Promise<PersistedChart[]> {
  const charts = await invoke<Array<{ id: string; sheetIndex: number; specJson: string }>>(page, "get_charts");
  return charts.map((c) => {
    const def = JSON.parse(c.specJson) as { x: number; y: number; width: number; height: number; name: string; spec: PersistedChart["spec"] };
    return { id: c.id, sheetIndex: c.sheetIndex, x: def.x, y: def.y, width: def.width, height: def.height, name: def.name, spec: def.spec };
  });
}

/** What the chart renderer last computed for a chart (null when not painted). */
export async function chartData(
  page: Page,
  id: string,
): Promise<{ values: number[] | null; categories: string[] | null; bars: Array<{ x: number; y: number; width: number; height: number; categoryName: string }> | null; layout: { elements?: Record<string, { x: number; y: number; width: number; height: number }> } | null } | null> {
  await installAppImport(page);
  return page.evaluate(
    async ({ id, mod }) => {
      const m = (await (window as unknown as AppWindow).__appImport!(mod)) as {
        getCachedChartData: (id: string) => {
          data?: { series?: Array<{ values: number[] }>; categories?: string[] };
          hitGeometry?: { type: string; rects?: Array<{ x: number; y: number; width: number; height: number; categoryName: string }>; groups?: unknown[] };
          layout?: { elements?: Record<string, { x: number; y: number; width: number; height: number }> };
        } | null;
      };
      const d = m.getCachedChartData(id);
      if (!d || !d.hitGeometry) return null;
      const bars = d.hitGeometry.type === "bars" ? (d.hitGeometry.rects ?? []).map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height, categoryName: r.categoryName })) : null;
      const els: Record<string, { x: number; y: number; width: number; height: number }> = {};
      for (const [k, v] of Object.entries(d.layout?.elements ?? {})) {
        if (v && typeof v === "object" && "x" in (v as object) && "width" in (v as object)) {
          const r = v as { x: number; y: number; width: number; height: number };
          els[k] = { x: r.x, y: r.y, width: r.width, height: r.height };
        }
      }
      return {
        values: d.data?.series?.[0]?.values ?? null,
        categories: d.data?.categories ?? null,
        bars,
        layout: { elements: els },
      };
    },
    { id, mod: MOD.CHART_RENDERER },
  );
}

// ---------------------------------------------------------------------------
// Controls (shapes)
// ---------------------------------------------------------------------------

export interface ControlRow {
  row: number;
  col: number;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  pinToGrid: string | null;
  text: string | null;
}

export async function controlsOn(page: Page, sheetIndex: number): Promise<ControlRow[]> {
  const raw = await invoke<Array<{ row: number; col: number; metadata: { controlType: string; properties: Record<string, { value: string }> } }>>(
    page,
    "get_all_controls",
    { sheetIndex },
  );
  const num = (p: Record<string, { value: string }>, k: string) => (p[k] ? Number(p[k].value) : NaN);
  return raw
    .map((c) => ({
      row: c.row,
      col: c.col,
      type: c.metadata.controlType,
      x: num(c.metadata.properties, "x"),
      y: num(c.metadata.properties, "y"),
      width: num(c.metadata.properties, "width"),
      height: num(c.metadata.properties, "height"),
      pinToGrid: c.metadata.properties.pinToGrid?.value ?? null,
      text: c.metadata.properties.text?.value ?? null,
    }))
    .sort((a, b) => a.x - b.x || a.y - b.y || a.row - b.row || a.col - b.col);
}

/** Create a shape through the controls seam (the Canvas tab's Insert Shape route) at an exact position. */
export async function createShape(
  page: Page,
  req: { sheetIndex: number; x: number; y: number; width: number; height: number; text?: string },
): Promise<{ instanceId: string; row: number; col: number; x: number; y: number }> {
  await installAppImport(page);
  return bounded(
    "createShape",
    page.evaluate(
      async ({ mod, req }) => {
        const cs = (await (window as unknown as AppWindow).__appImport!(mod)) as {
          requireControlsProvider: () => { createShape: (r: unknown) => Promise<{ instanceId: string; row: number; col: number; x: number; y: number }> };
        };
        return cs.requireControlsProvider().createShape({ shapeType: "rectangle", text: "", ...req });
      },
      { mod: MOD.CONTROLS_SERVICE, req },
    ),
  );
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

/** Start recording every toast that appears from now on (and forget earlier ones). */
export async function startToasts(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as AppWindow;
    w.__e2eToasts = [];
    const seen = w.__e2eToastSeen ?? new WeakSet<Element>();
    w.__e2eToastSeen = seen;
    // Everything already on screen is "before".
    document.querySelectorAll("[data-toast]").forEach((el) => seen.add(el));
    if (w.__e2eToastObs) return;
    const scan = (): void => {
      document.querySelectorAll("[data-toast]").forEach((el) => {
        if (seen.has(el)) return;
        seen.add(el);
        w.__e2eToasts!.push({ text: (el.textContent ?? "").trim(), variant: el.getAttribute("data-toast-variant"), at: Date.now() });
      });
    };
    w.__e2eToastObs = new MutationObserver(scan);
    w.__e2eToastObs.observe(document.body, { childList: true, subtree: true });
  });
}

export async function toasts(page: Page): Promise<Array<{ text: string; variant: string | null }>> {
  return page.evaluate(() => ((window as unknown as AppWindow).__e2eToasts ?? []).map((t) => ({ text: t.text, variant: t.variant })));
}

export async function dismissToasts(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.querySelectorAll<HTMLElement>("[data-toast] button").forEach((b) => b.click());
  });
}

// ---------------------------------------------------------------------------
// Protection
// ---------------------------------------------------------------------------

const ALL_OPTIONS_OFF = {
  allowSelectLockedCells: true,
  allowSelectUnlockedCells: true,
  allowFormatCells: false,
  allowFormatColumns: false,
  allowFormatRows: false,
  allowInsertColumns: false,
  allowInsertRows: false,
  allowInsertHyperlinks: false,
  allowDeleteColumns: false,
  allowDeleteRows: false,
  allowSort: false,
  allowAutoFilter: false,
  allowPivotTables: false,
  allowEditObjects: false,
  allowEditScenarios: false,
};

/** Protect the ACTIVE sheet the way the Protect Sheet dialog does (then refresh its store). */
export async function protectActiveSheet(page: Page, opts: { allowEditObjects?: boolean } = {}): Promise<void> {
  const res = await callModule<{ success: boolean; error?: string }>(page, MOD.BACKEND, "protectSheet", [
    { options: { ...ALL_OPTIONS_OFF, allowEditObjects: opts.allowEditObjects === true } },
  ]);
  if (!res.success) throw new Error(`protect_sheet refused: ${res.error}`);
  await callModule(page, MOD.PROTECTION_STORE, "refreshProtectionState");
}

export async function unprotectActiveSheet(page: Page): Promise<void> {
  const res = await callModule<{ success: boolean; error?: string }>(page, MOD.BACKEND, "unprotectSheet", []);
  if (!res.success) throw new Error(`unprotect_sheet refused: ${res.error}`);
  await callModule(page, MOD.PROTECTION_STORE, "refreshProtectionState");
}

// ---------------------------------------------------------------------------
// Native dialogs (Win32, from outside the app)
// ---------------------------------------------------------------------------

interface NativeWindow {
  pid: number;
  hwnd: number;
  class: string;
  title: string;
  visible: boolean;
}

function appWindows(): NativeWindow[] {
  if (!fs.existsSync(WINDOW_LISTER)) throw new Error(`the native-window lister is missing at ${WINDOW_LISTER}`);
  const out = execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", WINDOW_LISTER], {
    encoding: "utf-8",
    timeout: 30_000,
  });
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as NativeWindow);
}

/** Visible native dialogs owned by the app (the #32770 class a message box uses). */
export function visibleNativeDialogs(): NativeWindow[] {
  return appWindows().filter((w) => w.visible && w.class === "#32770");
}

/** Close any native dialog through its title-bar X (never a guessed button). Returns what it closed. */
export function dismissNativeDialogs(): string[] {
  const closed: string[] = [];
  for (let i = 0; i < 3; i++) {
    const open = visibleNativeDialogs();
    if (open.length === 0) break;
    for (const d of open) {
      try {
        const out = execFileSync(
          "powershell",
          ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", DIALOG_DRIVER, "-TitleLike", d.title || "Calcula", "-Action", "close", "-TimeoutMs", "3000"],
          { encoding: "utf-8", timeout: 30_000 },
        );
        closed.push(`${d.title}: ${out.replace(/\s+/g, " ").trim()}`);
      } catch (e) {
        closed.push(`${d.title}: DRIVERERROR ${String(e).slice(0, 200)}`);
      }
    }
  }
  return closed;
}

// ---------------------------------------------------------------------------
// Pivots, slicers, timelines
// ---------------------------------------------------------------------------

/** A range pivot over Sheet1!A1:C5 (Month rows, Sum of Units). */
export async function createPivot(
  page: Page,
  opts: { destinationSheet: number; destinationCell?: string; canvasFrame?: { x: number; y: number; width: number; height: number }; name: string },
): Promise<string> {
  const view = await callModule<{ pivotId: string }>(page, MOD.PIVOT_API, "createPivotTable", [
    {
      sourceRange: "Sheet1!A1:C5",
      destinationCell: opts.destinationCell ?? "A1",
      sourceSheet: 0,
      destinationSheet: opts.destinationSheet,
      hasHeaders: true,
      name: opts.name,
      ...(opts.canvasFrame ? { canvasFrame: { ...opts.canvasFrame, frozenHeaders: true } } : {}),
    },
  ]);
  const pivotId = String(view.pivotId);
  await callModule(page, MOD.PIVOT_API, "updatePivotFields", [
    {
      pivotId,
      rowFields: [{ sourceIndex: 0, name: "Month" }],
      valueFields: [{ sourceIndex: 1, name: "Sum of Units", aggregation: "sum" }],
    },
  ]);
  await page.evaluate(() => window.dispatchEvent(new Event("pivot:refresh")));
  return pivotId;
}

export async function createSlicer(
  page: Page,
  opts: { sheetIndex: number; x: number; y: number; width?: number; height?: number; pivotId: string; name: string },
): Promise<{ id: string; name: string }> {
  const s = await callModule<{ id: string; name: string } | null>(page, MOD.SLICER_STORE, "createSlicerAsync", [
    {
      name: opts.name,
      sheetIndex: opts.sheetIndex,
      x: opts.x,
      y: opts.y,
      width: opts.width ?? 176,
      height: opts.height ?? 208,
      sourceType: "pivot",
      cacheSourceId: opts.pivotId,
      fieldName: "Month",
      connectedSources: [{ sourceType: "pivot", sourceId: opts.pivotId }],
    },
  ]);
  if (!s) throw new Error("the slicer was not created");
  return s;
}

export async function createTimeline(
  page: Page,
  opts: { sheetIndex: number; x: number; y: number; width?: number; height?: number; pivotId: string; name: string },
): Promise<{ id: string; name: string }> {
  const t = await callModule<{ id: string; name: string } | null>(page, MOD.TIMELINE_STORE, "createTimelineAsync", [
    {
      name: opts.name,
      sheetIndex: opts.sheetIndex,
      x: opts.x,
      y: opts.y,
      width: opts.width ?? 320,
      height: opts.height ?? 112,
      sourceId: opts.pivotId,
      fieldName: "Day",
    },
  ]);
  if (!t) throw new Error("the timeline was not created");
  return t;
}

export async function slicersAll(page: Page): Promise<Array<{ id: string; name: string; sheetIndex: number; x: number; y: number; width: number; height: number }>> {
  return invoke(page, "get_all_slicers");
}

export async function timelinesAll(page: Page): Promise<Array<{ id: string; name: string; sheetIndex: number; x: number; y: number; width: number; height: number }>> {
  return invoke(page, "get_all_timeline_slicers");
}

export async function pivotRegions(page: Page): Promise<Array<{ pivotId: string; startRow: number; startCol: number; endRow: number; endCol: number; canvasFrame?: { x: number; y: number; width: number; height: number } }>> {
  return invoke(page, "get_pivot_regions_for_sheet");
}
