/**
 * Plumbing for fixall-calp.spec.ts: the app's own modules (same instance the
 * app loaded), the backend, sheets, cells, and the few reads every test needs.
 *
 * Every write goes through a PRODUCT route (the tab strip's own events, the
 * @api range facade, the app's file-api), and every read comes from the
 * backend or the DOM -- never from a pixel alone.
 */
import type { Page } from "@playwright/test";
import { parseCellRef } from "./grid";

export interface AppWindow {
  __calcImport: (u: string) => Promise<unknown>;
  __appImport?: (modulePath: string) => Promise<unknown>;
  __TAURI__: {
    core: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
    window?: { getCurrentWindow: () => { close: () => Promise<void>; label: string } };
  };
}

export interface SheetRow {
  index: number;
  name: string;
  sheetId?: string;
  kind?: string;
  visibility?: string;
}

export const FILE_API = "/src/core/lib/file-api.ts";
export const API = "/src/api/index.ts";
export const COLLAB = "/src/api/collaboration.ts";
export const RANGE = "/src/api/range.ts";
export const EVENTS = "/src/api/events.ts";

/** Import an app module from the SAME instance the app loaded (module state!). */
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

/** `page.evaluate` has no timeout of its own: never let one hang a test. */
export async function bounded<T>(label: string, p: Promise<T>, ms = 60_000): Promise<T> {
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
    page.evaluate(async ({ c, a }) => (window as unknown as AppWindow).__TAURI__.core.invoke(c, a), {
      c: cmd,
      a: args,
    }) as Promise<T>,
  );
}

/** Invoke and hand back the refusal text; `ok` says whether it succeeded instead. */
export async function tryInvoke(page: Page, cmd: string, args: unknown = {}): Promise<{ ok: boolean; value: unknown; error: string }> {
  return bounded(
    `tryInvoke ${cmd}`,
    page.evaluate(
      async ({ c, a }) => {
        try {
          const value = await (window as unknown as AppWindow).__TAURI__.core.invoke(c, a);
          return { ok: true, value, error: "" };
        } catch (e) {
          return { ok: false, value: null, error: String(e) };
        }
      },
      { c: cmd, a: args },
    ),
  );
}

/** Call an exported function of an app module (product route, same instance). */
export async function callModule<T = unknown>(page: Page, mod: string, fn: string, args: unknown[] = [], ms = 90_000): Promise<T> {
  await installAppImport(page);
  return bounded(
    `${mod}#${fn}`,
    page.evaluate(
      async ({ mod, fn, args }) => {
        const m = (await (window as unknown as AppWindow).__appImport!(mod)) as Record<string, (...a: unknown[]) => unknown>;
        if (typeof m[fn] !== "function") throw new Error(`${mod} exports no function "${fn}"`);
        return (await m[fn](...args)) as unknown;
      },
      { mod, fn, args },
    ) as Promise<T>,
    ms,
  );
}

/** Same, but a throw comes back as text instead of failing the evaluate. */
export async function tryModule(page: Page, mod: string, fn: string, args: unknown[] = []): Promise<{ ok: boolean; value: unknown; error: string }> {
  await installAppImport(page);
  return bounded(
    `${mod}#${fn}`,
    page.evaluate(
      async ({ mod, fn, args }) => {
        try {
          const m = (await (window as unknown as AppWindow).__appImport!(mod)) as Record<string, (...a: unknown[]) => unknown>;
          const value = (await m[fn](...args)) as unknown;
          return { ok: true, value, error: "" };
        } catch (e) {
          return { ok: false, value: null, error: e instanceof Error ? e.message : String(e) };
        }
      },
      { mod, fn, args },
    ),
  );
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
    `${label}: still ${JSON.stringify(last)?.slice(0, 600)} after ${timeoutMs}ms` + (lastErr ? ` (last error: ${String(lastErr)})` : ""),
  );
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/** The app's own File > New (never a raw invoke("new_file"), BUG-0205). */
export async function newFile(page: Page): Promise<void> {
  await page.keyboard.press("Escape").catch(() => undefined);
  await callModule(page, FILE_API, "newFile");
  await page.waitForTimeout(700);
}

export async function saveAs(page: Page, target: string): Promise<void> {
  await invoke(page, "save_file", { path: target });
  await page.waitForTimeout(300);
}

export async function openAt(page: Page, target: string): Promise<void> {
  await callModule(page, FILE_API, "openFileAtPath", [target]);
  await page.waitForTimeout(1500);
}

export async function isDirty(page: Page): Promise<boolean> {
  return invoke<boolean>(page, "is_file_modified");
}

// ---------------------------------------------------------------------------
// Sheets -- through the tab strip's own events
// ---------------------------------------------------------------------------

export async function sheets(page: Page): Promise<{ sheets: SheetRow[]; activeIndex: number }> {
  return invoke(page, "get_sheets");
}

export async function sheetNames(page: Page): Promise<string[]> {
  return (await sheets(page)).sheets.map((s) => s.name);
}

export async function sheetIndex(page: Page, name: string): Promise<number> {
  const s = (await sheets(page)).sheets.find((x) => x.name === name);
  if (!s) throw new Error(`no sheet named "${name}" in ${JSON.stringify(await sheetNames(page))}`);
  return s.index;
}

/** Click the tab (the user's route) and wait until the backend agrees. */
export async function activate(page: Page, name: string): Promise<number> {
  const idx = await sheetIndex(page, name);
  if ((await sheets(page)).activeIndex !== idx) {
    await page.locator(`button[data-sheet-tab="${idx}"]`).click();
    await eventually(() => sheets(page), (r) => r.activeIndex === idx, `could not activate "${name}"`);
    await page.waitForTimeout(300);
  }
  return idx;
}

/** Add a worksheet through the tab strip's add route; returns its index. */
export async function addWorksheet(page: Page): Promise<SheetRow> {
  const before = await sheets(page);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("sheet:requestAdd", { detail: null })));
  const after = await eventually(() => sheets(page), (r) => r.sheets.length === before.sheets.length + 1, "no worksheet was added");
  await page.waitForTimeout(250);
  const known = new Set(before.sheets.map((s) => s.name));
  return after.sheets.find((s) => !known.has(s.name))!;
}

export async function addCanvas(page: Page): Promise<SheetRow> {
  const before = await sheets(page);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("sheet:requestAdd", { detail: { kind: "canvas" } })));
  const after = await eventually(
    () => sheets(page),
    (r) => r.sheets.length === before.sheets.length + 1 && r.sheets.some((s) => s.kind === "canvas"),
    "no canvas was added",
  );
  await page.waitForTimeout(300);
  const known = new Set(before.sheets.map((s) => s.sheetId));
  return after.sheets.find((s) => !known.has(s.sheetId))!;
}

/** The tab strip's rename route (the context menu / double-click lands here). */
export async function renameSheetByName(page: Page, from: string, to: string): Promise<void> {
  const idx = await sheetIndex(page, from);
  await page.evaluate(({ index, newName }) => window.dispatchEvent(new CustomEvent("sheet:requestRename", { detail: { index, newName } })), {
    index: idx,
    newName: to,
  });
  await eventually(() => sheetNames(page), (n) => n.includes(to) && !n.includes(from), `rename "${from}" -> "${to}" did not land`);
  await page.waitForTimeout(300);
}

/** The tab strip's delete route, confirmed in its own React dialog. */
export async function deleteSheetByName(page: Page, name: string): Promise<void> {
  const idx = await sheetIndex(page, name);
  await page.evaluate((index) => window.dispatchEvent(new CustomEvent("sheet:requestDelete", { detail: { index } })), idx);
  const dialogButton = page.locator("button", { hasText: /^Delete$/ }).last();
  await dialogButton.waitFor({ state: "visible", timeout: 8000 });
  await dialogButton.click();
  await eventually(() => sheetNames(page), (n) => !n.includes(name), `delete of "${name}" did not land`);
  await page.waitForTimeout(400);
}

export async function moveSheetByName(page: Page, name: string, toIndex: number): Promise<void> {
  const idx = await sheetIndex(page, name);
  await page.evaluate(({ fromIndex, toIndex }) => window.dispatchEvent(new CustomEvent("sheet:requestMove", { detail: { fromIndex, toIndex } })), {
    fromIndex: idx,
    toIndex,
  });
  await eventually(() => sheetIndex(page, name), (i) => i === toIndex, `move of "${name}" did not land`);
  await page.waitForTimeout(400);
}

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

/** Write cells on ANY sheet through the @api range facade (the app's own write path). */
export async function setCells(page: Page, sheetIdx: number, cells: Array<[string, string]>): Promise<void> {
  await installAppImport(page);
  for (const [ref, value] of cells) {
    const { row, col } = parseCellRef(ref);
    await bounded(
      `setCell ${ref}`,
      page.evaluate(
        async ({ mod, row, col, s, value }) => {
          const m = (await (window as unknown as AppWindow).__appImport!(mod)) as {
            CellRange: { fromCell: (r: number, c: number, s?: number) => { setValue: (v: string) => Promise<unknown> } };
          };
          await m.CellRange.fromCell(row, col, s).setValue(value);
        },
        { mod: RANGE, row, col, s: sheetIdx, value },
      ),
    );
  }
  await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
  await page.waitForTimeout(150);
}

export interface CellRead {
  display: string;
  formula: string | null;
}

/** Display + formula of cells on any sheet, from the backend. */
export async function readCells(page: Page, sheetIdx: number, refs: string[]): Promise<CellRead[]> {
  const requests = refs.map((r) => {
    const { row, col } = parseCellRef(r);
    return [sheetIdx, row, col] as [number, number, number];
  });
  const rows = await invoke<Array<{ display?: string; formula?: string | null } | null>>(page, "get_watch_cells", { requests });
  return rows.map((c) => ({ display: c ? String(c.display ?? "") : "", formula: c?.formula ?? null }));
}

export async function readCell(page: Page, sheetIdx: number, ref: string): Promise<CellRead> {
  return (await readCells(page, sheetIdx, [ref]))[0];
}

/** Toasts currently on screen (text). */
export async function toastTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>("[data-toast]")).map((t) => (t.textContent ?? "").trim()));
}

export async function dismissToasts(page: Page): Promise<void> {
  await page.evaluate(() => document.querySelectorAll<HTMLElement>("[data-toast] button").forEach((b) => b.click()));
  await page.waitForTimeout(150);
}

/** Emit an app event through the app's own events module. */
export async function emitApp(page: Page, name: string, detail: unknown = {}): Promise<void> {
  await installAppImport(page);
  await page.evaluate(
    async ({ mod, name, detail }) => {
      const ev = (await (window as unknown as AppWindow).__appImport!(mod)) as {
        emitAppEvent: (n: string, d?: unknown) => void;
        AppEvents: Record<string, string>;
      };
      ev.emitAppEvent(ev.AppEvents[name] ?? name, detail);
    },
    { mod: EVENTS, name, detail },
  );
}

/** Undo state as the Edit menu reads it. */
export async function undoState(page: Page): Promise<{ canUndo: boolean; undoDescription: string | null; undoDepth: number }> {
  return invoke(page, "get_undo_state");
}

/** Press Ctrl+Z with the grid focused (the user's key). */
export async function pressUndo(page: Page): Promise<void> {
  await page.locator("[data-focus-container='spreadsheet']").focus();
  await page.waitForTimeout(100);
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(600);
}
