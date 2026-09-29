/**
 * Helpers for the pivot LIVE journey (`e2e/journeys/fixall-pivot.spec.ts`).
 *
 * Everything here drives the RUNNING app through its own routes: the modules
 * the app itself loaded (same instance, so the stores are the live ones), the
 * backend's own commands for READING, and the native dialog driver
 * (`e2e/answer-native-dialog.ps1`) for the confirmAsync questions -- which no
 * page code can answer.
 *
 * THE NATIVE-DIALOG RULE (memory: e2e_unawaited_call_before_execfilesync). A
 * request that raises a native dialog is STARTED in the page and the evaluate
 * that started it is AWAITED before the synchronous PowerShell driver runs:
 * `startInPage` returns once the page has launched the work (the CDP message
 * has gone out), and `settleInPage` later collects its result.
 */
import type { Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIALOG_DRIVER = path.resolve(HERE, "..", "answer-native-dialog.ps1");

export const MOD = {
  FILE_API: "/src/core/lib/file-api.ts",
  PIVOT_API: "/extensions/Pivot/lib/pivot-api.ts",
  API_PIVOT: "/src/api/pivot.ts",
  API_RANGE: "/src/api/range.ts",
  API_LIB: "/src/api/lib.ts",
  API_INDEX: "/src/api/index.ts",
  OBJECT_SCRIPT_RUNNER: "/src/api/objectScriptRunner.ts",
  OBJECT_GEOMETRY: "/src/api/objectGeometry.ts",
  OBJECT_SELECTION: "/src/api/objectSelection.ts",
  SLICER_STORE: "/extensions/Slicer/lib/slicerStore.ts",
  SLICER_RENDERER: "/extensions/Slicer/rendering/slicerRenderer.ts",
  SLICER_CANVAS_GEO: "/extensions/Slicer/lib/slicerCanvasGeometry.ts",
  TIMELINE_STORE: "/extensions/TimelineSlicer/lib/timelineSlicerStore.ts",
  TIMELINE_RENDERER: "/extensions/TimelineSlicer/rendering/timelineSlicerRenderer.ts",
  TIMELINE_CANVAS_GEO: "/extensions/TimelineSlicer/lib/timelineCanvasGeometry.ts",
  CHART_STORE: "/extensions/Charts/lib/chartStore.ts",
  CHART_RENDERER: "/extensions/Charts/rendering/chartRenderer.ts",
  CELL_EDIT_FLAG: "/src/core/lib/cellEditFlag.ts",
  EVENTS: "/src/api/events.ts",
} as const;

export interface AppWindow {
  __calcImport: (u: string) => Promise<unknown>;
  __appImport?: (modulePath: string) => Promise<unknown>;
  __TAURI__: { core: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } };
  __pvResult?: Record<string, { ok: boolean; value?: unknown; error?: string } | undefined>;
  __pvToasts?: Array<{ at: number; variant: string; text: string }>;
  __pvToastObserver?: MutationObserver;
  __CALCULA_GRID_STATE__?: {
    selection: { startRow: number; startCol: number; endRow: number; endCol: number } | null;
  };
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

/** Import an app module from the SAME instance the app loaded (live stores). */
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

/** A page call that cannot hang the test: `page.evaluate` has no timeout of its own. */
export async function bounded<T>(label: string, p: Promise<T>, ms = 30_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label}: no answer within ${ms} ms -- is the app blocked by a native dialog?`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function invoke<T = unknown>(page: Page, cmd: string, args: unknown = {}): Promise<T> {
  return bounded(
    `invoke ${cmd}`,
    page.evaluate(async ({ c, a }) => (window as unknown as AppWindow).__TAURI__.core.invoke(c, a), {
      c: cmd,
      a: args,
    }) as Promise<T>,
  );
}

/** Call an exported function of an app module (product route, same instance). */
export async function callModule<T = unknown>(page: Page, mod: string, fn: string, args: unknown[] = [], ms = 60_000): Promise<T> {
  await installAppImport(page);
  return bounded(
    `${mod}#${fn}`,
    page.evaluate(
      async ({ mod, fn, args }) => {
        const m = (await (window as unknown as AppWindow).__appImport!(mod)) as Record<string, unknown>;
        const f = m[fn];
        if (typeof f !== "function") throw new Error(`${mod} exports no function "${fn}"`);
        return (await (f as (...a: unknown[]) => unknown)(...args)) as unknown;
      },
      { mod, fn, args },
    ) as Promise<T>,
    ms,
  );
}

/** Call a method of the `pivot` facade object (`@api/pivot`). */
export async function pivotApi<T = unknown>(page: Page, fn: string, arg: unknown, ms = 60_000): Promise<T> {
  await installAppImport(page);
  return bounded(
    `pivot.${fn}`,
    page.evaluate(
      async ({ fn, arg, mod }) => {
        const m = (await (window as unknown as AppWindow).__appImport!(mod)) as {
          pivot: Record<string, (a: unknown) => Promise<unknown>>;
        };
        return (await m.pivot[fn](arg)) as unknown;
      },
      { fn, arg, mod: MOD.API_PIVOT },
    ) as Promise<T>,
    ms,
  );
}

/**
 * Start `mod#fn(...args)` in the page WITHOUT waiting for it, under `key`. The
 * evaluate that launches it IS awaited, so the request is in flight before the
 * caller runs anything synchronous (a native-dialog driver).
 */
export async function startInPage(page: Page, key: string, mod: string, fn: string, args: unknown[] = []): Promise<void> {
  await installAppImport(page);
  await bounded(
    `start ${fn}`,
    page.evaluate(
      async ({ key, mod, fn, args }) => {
        const w = window as unknown as AppWindow;
        w.__pvResult = w.__pvResult ?? {};
        w.__pvResult[key] = undefined;
        const m = (await w.__appImport!(mod)) as Record<string, unknown>;
        const f = m[fn];
        if (typeof f !== "function") throw new Error(`${mod} exports no function "${fn}"`);
        void Promise.resolve()
          .then(() => (f as (...a: unknown[]) => unknown)(...args))
          .then(
            (value) => {
              w.__pvResult![key] = { ok: true, value };
            },
            (e) => {
              w.__pvResult![key] = { ok: false, error: e instanceof Error ? e.message : String(e) };
            },
          );
      },
      { key, mod, fn, args },
    ),
  );
}

/** Start arbitrary page code (a function body receiving `api(modPath)`), not awaited. */
export async function startScriptInPage(page: Page, key: string, body: string, arg: unknown = null): Promise<void> {
  await installAppImport(page);
  await bounded(
    `start ${key}`,
    page.evaluate(
      async ({ key, body, arg }) => {
        const w = window as unknown as AppWindow;
        w.__pvResult = w.__pvResult ?? {};
        w.__pvResult[key] = undefined;
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        const run = new Function("api", "arg", `return (async () => { ${body} })();`) as (
          api: (m: string) => Promise<unknown>,
          arg: unknown,
        ) => Promise<unknown>;
        void Promise.resolve()
          .then(() => run((m: string) => w.__appImport!(m), arg))
          .then(
            (value) => {
              w.__pvResult![key] = { ok: true, value };
            },
            (e) => {
              w.__pvResult![key] = { ok: false, error: e instanceof Error ? e.message : String(e) };
            },
          );
      },
      { key, body, arg },
    ),
  );
}

/** Whether the work started under `key` has settled (and how). */
export async function peekInPage(page: Page, key: string): Promise<{ ok: boolean; value?: unknown; error?: string } | null> {
  return bounded(
    `peek ${key}`,
    page.evaluate((key) => (window as unknown as AppWindow).__pvResult?.[key] ?? null, key),
  );
}

/** Wait for the work started under `key`; throws with its error when it failed and `mustSucceed`. */
export async function settleInPage<T = unknown>(page: Page, key: string, timeoutMs = 30_000, mustSucceed = true): Promise<{ ok: boolean; value?: T; error?: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await peekInPage(page, key);
    if (r) {
      if (mustSucceed && !r.ok) throw new Error(`${key} failed in the page: ${r.error}`);
      return r as { ok: boolean; value?: T; error?: string };
    }
    if (Date.now() > deadline) throw new Error(`${key}: still running after ${timeoutMs} ms`);
    await new Promise((res) => setTimeout(res, 100));
  }
}

export async function eventually<T>(probe: () => Promise<T>, ok: (v: T) => boolean, label: string, timeoutMs = 10_000): Promise<T> {
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
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(
    `${label}: still ${JSON.stringify(last)?.slice(0, 600)} after ${timeoutMs}ms` +
      (lastErr ? ` (last probe error: ${String(lastErr).slice(0, 300)})` : ""),
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

/** The app's OWN File > New (the file-api route; never a raw `new_file`, BUG-0205). */
export async function newFile(page: Page): Promise<void> {
  await page.keyboard.press("Escape").catch(() => undefined);
  await installAppImport(page);
  await bounded(
    "newFile",
    page.evaluate(async (mod) => {
      const m = (await (window as unknown as AppWindow).__appImport!(mod)) as { newFile: () => Promise<void> };
      await m.newFile();
    }, MOD.FILE_API),
    60_000,
  );
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("dimensions:refresh"));
    window.dispatchEvent(new Event("grid:refresh"));
  });
  await page.waitForTimeout(700);
}

export async function openFileAtPath(page: Page, file: string): Promise<void> {
  await installAppImport(page);
  await bounded(
    "openFileAtPath",
    page.evaluate(
      async ({ mod, file }) => {
        const m = (await (window as unknown as AppWindow).__appImport!(mod)) as { openFileAtPath: (p: string) => Promise<void> };
        await m.openFileAtPath(file);
      },
      { mod: MOD.FILE_API, file },
    ),
    60_000,
  );
  await page.waitForTimeout(800);
}

export interface SheetRow {
  index: number;
  name: string;
  sheetId?: string;
  kind?: string;
}

export async function sheets(page: Page): Promise<{ sheets: SheetRow[]; activeIndex: number }> {
  return invoke(page, "get_sheets");
}

export async function isDirty(page: Page): Promise<boolean> {
  return invoke<boolean>(page, "is_file_modified");
}

/** Add a worksheet through the tab strip's own add route; it becomes active. */
export async function addWorksheet(page: Page): Promise<SheetRow> {
  const before = await sheets(page);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("sheet:requestAdd", { detail: null })));
  const after = await eventually(
    () => sheets(page),
    (r) => r.sheets.length === before.sheets.length + 1,
    "no worksheet was added",
  );
  await page.waitForTimeout(300);
  return after.sheets[after.sheets.length - 1];
}

/** Add a canvas through the tab strip's own add route; it becomes active. */
export async function addCanvas(page: Page): Promise<SheetRow> {
  const before = await sheets(page);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("sheet:requestAdd", { detail: { kind: "canvas" } })));
  const after = await eventually(
    () => sheets(page),
    (r) => r.sheets.length === before.sheets.length + 1 && r.sheets.some((s) => s.kind === "canvas"),
    "no canvas was added",
  );
  await page.waitForTimeout(400);
  return after.sheets.find((s) => s.kind === "canvas" && !before.sheets.some((b) => b.index === s.index))!;
}

/** Click a sheet tab and wait until the backend reports it active. */
export async function activateSheet(page: Page, index: number): Promise<void> {
  await page.locator(`button[data-sheet-tab="${index}"]`).click();
  await eventually(() => sheets(page), (r) => r.activeIndex === index, `sheet ${index} did not become active`);
  await page.waitForTimeout(400);
}

/** Write cells on the ACTIVE sheet (the user's own edit command) and repaint. */
export async function writeCells(page: Page, cells: Array<[number, number, string]>): Promise<void> {
  for (const [row, col, value] of cells) {
    await invoke(page, "update_cell", { row, col, value });
  }
  await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
  await page.waitForTimeout(200);
}

/** Write a table of rows starting at (row0, col0) on the ACTIVE sheet; `null` leaves a cell empty. */
export async function writeTable(page: Page, rows: Array<Array<string | number | null>>, row0 = 0, col0 = 0): Promise<void> {
  const cells: Array<[number, number, string]> = [];
  rows.forEach((r, i) =>
    r.forEach((v, j) => {
      if (v !== null) cells.push([row0 + i, col0 + j, String(v)]);
    }),
  );
  await writeCells(page, cells);
}

export interface TypedCell {
  row: number;
  col: number;
  value: unknown;
  display: string;
  formula: string | null;
  type: string;
}

export async function cellsIn(page: Page, sheetIndex: number, r0: number, c0: number, r1: number, c1: number): Promise<TypedCell[]> {
  return invoke<TypedCell[]>(page, "get_range_cells_typed", {
    sheetIndex,
    startRow: r0,
    startCol: c0,
    endRow: r1,
    endCol: c1,
  });
}

/** The DISPLAY text of a rectangle as a matrix ("" for empty cells). */
export async function displayGrid(page: Page, sheetIndex: number, r0: number, c0: number, r1: number, c1: number): Promise<string[][]> {
  const cells = await cellsIn(page, sheetIndex, r0, c0, r1, c1);
  const out: string[][] = [];
  for (let r = r0; r <= r1; r++) out.push(new Array(c1 - c0 + 1).fill(""));
  for (const c of cells) out[c.row - r0][c.col - c0] = c.display;
  return out;
}

export async function cellAt(page: Page, sheetIndex: number, row: number, col: number): Promise<TypedCell | null> {
  const cells = await cellsIn(page, sheetIndex, row, col, row, col);
  return cells[0] ?? null;
}

/** "E12" -> {row: 11, col: 4} */
export function refToRC(ref: string): { row: number; col: number } {
  const m = /^([A-Z]+)(\d+)$/.exec(ref.toUpperCase());
  if (!m) throw new Error(`bad ref ${ref}`);
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { row: Number(m[2]) - 1, col: col - 1 };
}

export function rcToRef(row: number, col: number): string {
  let s = "";
  let c = col + 1;
  while (c > 0) {
    const m = (c - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    c = Math.floor((c - 1) / 26);
  }
  return `${s}${row + 1}`;
}

// ---------------------------------------------------------------------------
// Pivots
// ---------------------------------------------------------------------------

export interface PivotCell {
  cellType: string;
  value: unknown;
  formattedValue?: string;
  groupPath?: Array<[number, number]>;
}
export interface PivotRow {
  viewRow: number;
  rowType: string;
  depth?: number;
  cells: PivotCell[];
}
export interface PivotView {
  pivotId: string;
  rows: PivotRow[];
  rowFieldSummaries?: Array<{ fieldIndex: number; fieldName: string; hasActiveFilter: boolean }>;
  columnFieldSummaries?: Array<{ fieldIndex: number; fieldName: string; hasActiveFilter: boolean }>;
  overwrittenCellCount?: number;
  overwriteToken?: number;
}

/** A pivot view as text: formatted value, else the raw value ("" for null). */
export function viewText(view: PivotView): string[][] {
  return view.rows.map((r) =>
    r.cells.map((c) => (c.formattedValue !== undefined && c.formattedValue !== null ? String(c.formattedValue) : c.value === null || c.value === undefined ? "" : String(c.value))),
  );
}

export async function pivotView(page: Page, pivotId: string): Promise<PivotView> {
  return callModule<PivotView>(page, MOD.PIVOT_API, "getPivotView", [pivotId]);
}

/**
 * The rows of a one-level row axis as [label, ...values] -- data rows and the
 * grand total, header rows left out.
 */
export async function pivotRowsByLabel(page: Page, pivotId: string): Promise<Array<[string, ...string[]]>> {
  const v = await pivotView(page, pivotId);
  const text = viewText(v);
  const out: Array<[string, ...string[]]> = [];
  v.rows.forEach((r, i) => {
    if (r.rowType === "Data" || r.rowType === "GrandTotal" || r.rowType === "Subtotal") {
      out.push(text[i] as [string, ...string[]]);
    }
  });
  return out;
}

/** A range pivot, created the way the Create PivotTable dialog creates it (then configured). */
export async function createRangePivot(
  page: Page,
  opts: {
    sourceRange: string;
    destinationCell: string;
    sourceSheet: number;
    destinationSheet: number;
    name?: string;
    sourceTableName?: string;
  },
): Promise<string> {
  const view = await callModule<{ pivotId: string }>(page, MOD.PIVOT_API, "createPivotTable", [
    { hasHeaders: true, ...opts },
  ]);
  return String(view.pivotId);
}

/** Configure a range pivot through the pivot API the editor uses (no overwrite expected). */
export async function configurePivot(page: Page, request: Record<string, unknown>): Promise<PivotView> {
  const v = await callModule<PivotView>(page, MOD.PIVOT_API, "updatePivotFields", [request]);
  await page.evaluate(() => window.dispatchEvent(new Event("pivot:refresh")));
  await page.waitForTimeout(300);
  return v;
}

export interface PivotRegion {
  pivotId: string;
  name: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/** Pivot regions on the ACTIVE sheet. */
export async function pivotRegions(page: Page): Promise<PivotRegion[]> {
  return invoke<PivotRegion[]>(page, "get_pivot_regions_for_sheet");
}

// ---------------------------------------------------------------------------
// Undo / toasts / focus
// ---------------------------------------------------------------------------

export interface UndoState {
  canUndo: boolean;
  canRedo: boolean;
  undoDescription: string | null;
  redoDescription: string | null;
  undoDepth: number;
  redoDepth: number;
  transactionOpen: boolean;
}

export async function undoState(page: Page): Promise<UndoState> {
  return invoke<UndoState>(page, "get_undo_state");
}

/** Put the keyboard on the grid container (no click: nothing is selected by this). */
export async function focusGrid(page: Page): Promise<void> {
  await page.locator("[data-focus-container='spreadsheet']").focus();
  await page.waitForTimeout(80);
}

/** The user's Ctrl+Z / Ctrl+Y on the focused grid. */
export async function pressUndo(page: Page): Promise<void> {
  await focusGrid(page);
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(250);
}
export async function pressRedo(page: Page): Promise<void> {
  await focusGrid(page);
  await page.keyboard.press("Control+y");
  await page.waitForTimeout(250);
}

/** Start recording every toast that appears (text + variant), from now on. */
export async function startToastLog(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as AppWindow;
    w.__pvToasts = [];
    w.__pvToastObserver?.disconnect();
    const seen = new WeakSet<Element>();
    const scan = () => {
      document.querySelectorAll("[data-toast]").forEach((el) => {
        if (seen.has(el)) return;
        seen.add(el);
        w.__pvToasts!.push({
          at: Date.now(),
          variant: el.getAttribute("data-toast-variant") ?? "",
          text: (el.textContent ?? "").trim(),
        });
      });
    };
    // Toasts already on screen are NOT this test's.
    document.querySelectorAll("[data-toast]").forEach((el) => seen.add(el));
    const obs = new MutationObserver(scan);
    obs.observe(document.body, { childList: true, subtree: true });
    w.__pvToastObserver = obs;
  });
}

export async function toastLog(page: Page): Promise<Array<{ variant: string; text: string }>> {
  return page.evaluate(() => ((window as unknown as AppWindow).__pvToasts ?? []).map((t) => ({ variant: t.variant, text: t.text })));
}

export async function dismissToasts(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.querySelectorAll<HTMLElement>("[data-toast] button").forEach((b) => b.click());
  });
}

// ---------------------------------------------------------------------------
// Native dialogs (confirmAsync -> tauri-plugin-dialog -> Win32 TaskDialog)
// ---------------------------------------------------------------------------

export interface DialogVerdict {
  raw: string;
  text: string;
  buttons: string[];
  sent: string | null;
  outcome: "GONE" | "STILLOPEN" | null;
  notFound: boolean;
}

function runDriver(args: string[], waitMs: number): string {
  if (!fs.existsSync(DIALOG_DRIVER)) throw new Error(`the native-dialog driver is missing at ${DIALOG_DRIVER}`);
  try {
    return execFileSync(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", DIALOG_DRIVER, "-TitleLike", "Calcula", "-TimeoutMs", String(waitMs), ...args],
      { encoding: "utf-8", timeout: waitMs + 30_000, windowsHide: true },
    );
  } catch (e) {
    const out = (e as { stdout?: string }).stdout;
    return typeof out === "string" && out.length > 0 ? out : `DRIVERERROR:${String(e)}`;
  }
}

function parseVerdict(raw: string): DialogVerdict {
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const buttonsLine = lines.find((l) => l.startsWith("BUTTONS:"));
  const outcome = lines.find((l) => l === "GONE" || l === "STILLOPEN") as DialogVerdict["outcome"] | undefined;
  return {
    raw: lines.join(" | "),
    text: lines.filter((l) => l.startsWith("TEXT:")).map((l) => l.slice(5)).join(" "),
    buttons: buttonsLine ? buttonsLine.slice("BUTTONS:".length).split("|").filter(Boolean) : [],
    sent: lines.find((l) => l.startsWith("CLICKED:") || l.startsWith("CLOSED:") || l === "ESCAPED") ?? null,
    outcome: outcome ?? null,
    notFound: lines.includes("NOTFOUND"),
  };
}

/** Press the button labelled exactly `label` on the "Calcula" native dialog. */
export function answerDialog(label: string, waitMs = 20_000): DialogVerdict {
  return parseVerdict(runDriver(["-Action", "button", "-Button", label], waitMs));
}

/** Read the native dialog's text without answering it; `notFound` when none appeared within `waitMs`. */
export function readDialog(waitMs = 3000): DialogVerdict {
  return parseVerdict(runDriver(["-Action", "read"], waitMs));
}

// ---------------------------------------------------------------------------
// Menus and ribbon
// ---------------------------------------------------------------------------

/** Open a top-level menu and click the item path (exact labels, submenus hovered). */
export async function menuPath(page: Page, top: string, items: string[]): Promise<void> {
  const topBtn = page.locator("button").filter({ hasText: new RegExp(`^${top}$`) }).first();
  await topBtn.click({ timeout: 10_000 });
  await page.waitForTimeout(250);
  for (let i = 0; i < items.length; i++) {
    const label = items[i];
    // The MenuBar renders items as plain buttons holding a <span> label.
    const row = page
      .locator("button")
      .filter({ has: page.locator("span", { hasText: new RegExp(`^${escapeRe(label)}$`) }) })
      .first();
    await row.waitFor({ state: "visible", timeout: 10_000 });
    if (i < items.length - 1) {
      await row.hover();
      await page.waitForTimeout(350);
    } else {
      await row.click();
    }
  }
  await page.waitForTimeout(300);
}

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The ribbon's tab strip labels (as e2e/invariants reads it). */
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

/** Click a ribbon tab by its label (waits for it to exist). */
export async function openRibbonTab(page: Page, label: string | RegExp): Promise<void> {
  const want = typeof label === "string" ? new RegExp(`^${escapeRe(label)}$`) : label;
  await eventually(() => ribbonTabs(page), (t) => t.some((x) => want.test(x.label)), `ribbon tab ${String(label)} never appeared`, 10_000);
  const band = page.locator("[data-ribbon-content]");
  const strip = band.locator("xpath=..").locator("div").first();
  await strip.locator("button").filter({ hasText: want }).first().click();
  await page.waitForTimeout(300);
}

/** Click a ribbon control by data-testid, opening folded launchers when needed. */
export async function clickRibbonTestId(page: Page, testId: string): Promise<void> {
  const el = page.locator(`[data-testid="${testId}"]`).first();
  if (!(await el.isVisible().catch(() => false))) {
    // A band short of room folds sections into launchers: open each until it shows.
    const launchers = page.locator("[data-ribbon-content] button[aria-haspopup]");
    const n = await launchers.count();
    for (let i = 0; i < n && !(await el.isVisible().catch(() => false)); i++) {
      await launchers.nth(i).click().catch(() => undefined);
      await page.waitForTimeout(250);
      if (!(await el.isVisible().catch(() => false))) await page.keyboard.press("Escape");
    }
  }
  await el.click({ timeout: 10_000 });
  await page.waitForTimeout(300);
}

// ---------------------------------------------------------------------------
// Scripts (a REAL object-script realm: runObjectScriptOnce, unlocked tier)
// ---------------------------------------------------------------------------

export async function allowScripts(page: Page): Promise<void> {
  await invoke(page, "set_script_security_level", { level: "enabled" });
}

/**
 * Run object-script source once in a real worker realm (`setup(context)`),
 * NOT awaited: collect it with `settleInPage(page, key)`.
 */
export async function startObjectScript(page: Page, key: string, name: string, body: string): Promise<void> {
  const source = `export async function setup(context) {\n  const api = context.api;\n${body}\n}\n`;
  await startInPage(page, key, MOD.OBJECT_SCRIPT_RUNNER, "runObjectScriptOnce", [{ name, source }]);
}

// ---------------------------------------------------------------------------
// Geometry (floating objects are placed in SHEET pixels)
// ---------------------------------------------------------------------------

/** The grid canvas's top-left in page (CSS) pixels. */
export async function gridOrigin(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => {
    const c = document.querySelector("canvas") as HTMLCanvasElement | null;
    if (!c) throw new Error("grid canvas not found");
    const r = c.getBoundingClientRect();
    return { x: r.left, y: r.top };
  });
}

/** Page pixel of a sheet-pixel point on the ACTIVE sheet (painted gutters, scroll and zoom). */
export async function sheetPointToPage(page: Page, sx: number, sy: number): Promise<{ x: number; y: number }> {
  const { readGridGeometry } = await import("./grid");
  const geo = await readGridGeometry(page);
  const o = await gridOrigin(page);
  return {
    x: o.x + (geo.rowHeaderWidth + sx - geo.scrollX) * geo.zoom,
    y: o.y + (geo.colHeaderHeight + sy - geo.scrollY) * geo.zoom,
  };
}

/** Page pixel of a LOGICAL canvas point (what the extensions' hit tests take). */
export async function canvasPointToPage(page: Page, cx: number, cy: number): Promise<{ x: number; y: number }> {
  const { readGridGeometry } = await import("./grid");
  const geo = await readGridGeometry(page);
  const o = await gridOrigin(page);
  return { x: o.x + cx * geo.zoom, y: o.y + cy * geo.zoom };
}
