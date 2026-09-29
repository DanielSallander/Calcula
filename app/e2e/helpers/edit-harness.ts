/**
 * Plumbing for the "edit" area's live journey (journeys/fixall-edit.spec.ts).
 *
 * Everything here READS the running app -- the backend through invoke(), the
 * app's own module instances through `__calcImport` (the SAME instance the app
 * loaded, found through the page's resource timings, so module-level stores
 * such as the toast store, the selection-owner registry or the floating-grid
 * selection are the live ones) -- or drives it the way a user does. Nothing
 * here writes product state behind the product's back except where a helper
 * says so in its name (`writeCells`, `seed...`).
 */
import type { Page } from "@playwright/test";
import { readGridGeometry } from "./grid";

export interface AppWindow {
  __calcImport: (u: string) => Promise<unknown>;
  __appImport?: (modulePath: string) => Promise<unknown>;
  __TAURI__: { core: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } };
  __CALCULA_GRID_STATE__?: {
    selection: {
      startRow: number;
      startCol: number;
      endRow: number;
      endCol: number;
      additionalRanges?: Array<{ startRow: number; startCol: number; endRow: number; endCol: number }>;
    } | null;
    editing: { row: number; col: number; value: string; sheetIndex?: number } | null;
    clipboard?: { mode: string } | null;
    viewport?: { scrollX: number; scrollY: number; startRow?: number; endRow?: number };
    sheetContext?: { activeSheetIndex: number };
  };
  __e2eToastLog?: Array<{ id: string; message: string; variant: string }>;
  __e2eToastUnsub?: () => void;
  __e2eRejections?: string[];
  __e2eRejectionsHooked?: boolean;
}

export const FILE_API = "/src/core/lib/file-api.ts";
export const CELL_EDIT_FLAG = "/src/core/lib/cellEditFlag.ts";
export const SELECTION_OWNER = "/src/core/lib/selectionOwner.ts";
export const TOAST_STORE = "/src/shell/Toast/useToastStore.ts";
export const API_UI = "/src/api/ui.ts";
export const API_COMMANDS = "/src/api/commands.ts";
export const API_GRID = "/src/api/grid.ts";
export const API_KEYBINDINGS = "/src/api/keybindings.ts";
export const API_EDIT_PREFS = "/src/api/editingPreferences.ts";
export const TAURI_API = "/src/core/lib/tauri-api.ts";
export const FLOATING_RANGES = "/src/api/floatingRanges.ts";
export const FR_SELECTION = "/extensions/FloatingRange/lib/frSelection.ts";
export const FR_EDITOR = "/extensions/FloatingRange/editor/frEditor.ts";
export const BOOKMARK_STORE = "/extensions/BuiltIn/CellBookmarks/lib/bookmarkStore.ts";
export const FORMAT_PAINTER_STATE = "/extensions/BuiltIn/FormatPainter/formatPainterState.ts";
export const ACTIVITY_BAR_STORE = "/src/shell/ActivityBar/useActivityBarStore.ts";

// ---------------------------------------------------------------------------
// Module access and the backend
// ---------------------------------------------------------------------------

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

/** A page call that cannot hang the test: `page.evaluate` has no timeout of its own. */
export async function bounded<T>(label: string, p: Promise<T>, ms = 20_000): Promise<T> {
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

export async function invoke<T = unknown>(page: Page, cmd: string, args: unknown = {}, ms = 20_000): Promise<T> {
  return bounded(
    `invoke ${cmd}`,
    page.evaluate(
      async ({ c, a }) => (window as unknown as AppWindow).__TAURI__.core.invoke(c, a),
      { c: cmd, a: args },
    ) as Promise<T>,
    ms,
  );
}

/** Call an exported function of an app module (the product's own route, same instance). */
export async function callModule<T = unknown>(page: Page, mod: string, fn: string, args: unknown[] = []): Promise<T> {
  await installAppImport(page);
  return bounded(
    `${mod}#${fn}`,
    page.evaluate(
      async ({ mod, fn, args }) => {
        const m = (await (window as unknown as AppWindow).__appImport!(mod)) as Record<string, unknown>;
        const f = m[fn];
        if (typeof f !== "function") throw new Error(`${mod} exports no function ${fn}`);
        return (await (f as (...a: unknown[]) => unknown)(...args)) as unknown;
      },
      { mod, fn, args },
    ) as Promise<T>,
  );
}

export async function eventually<T>(
  probe: () => Promise<T>,
  ok: (v: T) => boolean,
  label: string,
  timeoutMs = 8000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T = undefined as T;
  while (Date.now() < deadline) {
    last = await probe();
    if (ok(last)) return last;
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`${label}: still ${JSON.stringify(last)?.slice(0, 600)} after ${timeoutMs}ms`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** The app's own File > New (never a raw `new_file`, BUG-0205). */
export async function newFile(page: Page): Promise<void> {
  await callModule(page, FILE_API, "newFile");
  await page.waitForTimeout(400);
}

// ---------------------------------------------------------------------------
// Cells, sheets, selection
// ---------------------------------------------------------------------------

export interface CellRow {
  display?: string;
  formula?: string | null;
  styleIndex?: number;
}

/** Write cells on the ACTIVE sheet (seed data) and tell the grid to repaint. */
export async function writeCells(page: Page, cells: Array<[number, number, string]>): Promise<void> {
  for (const [row, col, value] of cells) {
    await invoke(page, "update_cell", { row, col, value });
  }
  await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
  await page.waitForTimeout(200);
}

/** Display text of cells on ANY sheet, from the backend ("" when empty). */
export async function cellsOn(page: Page, requests: Array<[number, number, number]>): Promise<string[]> {
  const rows = await invoke<Array<CellRow | null>>(page, "get_watch_cells", { requests });
  return rows.map((c) => (c ? String(c.display ?? "") : ""));
}

/** One cell of the ACTIVE sheet as the backend holds it (null when empty). */
export async function cellAt(page: Page, row: number, col: number): Promise<CellRow | null> {
  return invoke<CellRow | null>(page, "get_cell", { row, col });
}

/** The style of one cell of the ACTIVE sheet. */
export async function styleAt(page: Page, row: number, col: number): Promise<Record<string, unknown> & { index: number }> {
  const cell = await cellAt(page, row, col);
  const index = cell?.styleIndex ?? 0;
  const style = await invoke<Record<string, unknown>>(page, "get_style", { index });
  return { ...style, index };
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

export async function activeSheet(page: Page): Promise<number> {
  return (await sheets(page)).activeIndex;
}

/** Add a worksheet through the tab strip's own route; the new sheet becomes active. */
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

/** Rename through the tab strip's own route. */
export async function renameSheet(page: Page, index: number, newName: string): Promise<void> {
  await page.evaluate(
    ({ index, newName }) => window.dispatchEvent(new CustomEvent("sheet:requestRename", { detail: { index, newName } })),
    { index, newName },
  );
  await eventually(
    () => sheets(page),
    (r) => r.sheets.find((s) => s.index === index)?.name === newName,
    `sheet ${index} was not renamed to ${newName}`,
  );
  await page.waitForTimeout(200);
}

/** Click a sheet tab and wait for the backend to show it. */
export async function clickSheetTab(page: Page, index: number): Promise<void> {
  await page.locator(`button[data-sheet-tab="${index}"]`).click();
  await eventually(() => activeSheet(page), (i) => i === index, `the tab click did not show sheet ${index}`);
  await page.waitForTimeout(300);
}

export type Sel = { startRow: number; startCol: number; endRow: number; endCol: number };

/** Core's selection (and its extra areas) from the live grid state. */
export async function gridSelection(page: Page): Promise<(Sel & { additionalRanges: Sel[] }) | null> {
  return page.evaluate(() => {
    const s = (window as unknown as AppWindow).__CALCULA_GRID_STATE__?.selection;
    if (!s) return null;
    return {
      startRow: s.startRow,
      startCol: s.startCol,
      endRow: s.endRow,
      endCol: s.endCol,
      additionalRanges: (s.additionalRanges ?? []).map((r) => ({
        startRow: r.startRow,
        startCol: r.startCol,
        endRow: r.endRow,
        endCol: r.endCol,
      })),
    };
  });
}

/** Core's own cell edit (value + cell), from the live grid state. */
export async function gridEditing(page: Page): Promise<{ row: number; col: number; value: string } | null> {
  return page.evaluate(() => {
    const e = (window as unknown as AppWindow).__CALCULA_GRID_STATE__?.editing;
    return e ? { row: e.row, col: e.col, value: e.value } : null;
  });
}

export async function coreEditOpen(page: Page): Promise<boolean> {
  return callModule<boolean>(page, CELL_EDIT_FLAG, "isCoreCellEditOpen");
}

export async function focusGrid(page: Page): Promise<void> {
  await page.locator("[data-focus-container='spreadsheet']").focus();
  await page.waitForTimeout(80);
}

/** What holds the keyboard right now. */
export async function focusInfo(page: Page): Promise<{ tag: string; gridContainer: boolean; formulaBar: boolean; frEditor: boolean }> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return {
      tag: el?.tagName ?? "(none)",
      gridContainer: !!el?.matches("[data-focus-container='spreadsheet']"),
      formulaBar: !!el?.matches('[data-formula-bar="true"]'),
      frEditor: !!el?.matches("textarea[data-fr-editor]"),
    };
  });
}

export async function formulaBarValue(page: Page): Promise<string> {
  return page.locator('input[data-formula-bar="true"], textarea[data-formula-bar="true"]').first().inputValue();
}

// ---------------------------------------------------------------------------
// Undo history
// ---------------------------------------------------------------------------

export interface UndoStateRow {
  canUndo: boolean;
  canRedo: boolean;
  undoDescription: string | null;
  redoDescription: string | null;
  undoDepth: number;
  redoDepth: number;
  transactionOpen: boolean;
  undoSeqs: number[];
}

export async function undoState(page: Page): Promise<UndoStateRow> {
  return invoke<UndoStateRow>(page, "get_undo_state");
}

// ---------------------------------------------------------------------------
// Toasts, dialogs, overlays, unhandled rejections
// ---------------------------------------------------------------------------

/**
 * Record every toast the app raises from now on, in order, by subscribing to
 * the Shell's own toast store (a DOM count would miss one dismissed early and
 * double-count a leftover). Idempotent.
 */
export async function startToastLog(page: Page): Promise<void> {
  await installAppImport(page);
  await page.evaluate(async (mod) => {
    const w = window as unknown as AppWindow;
    if (w.__e2eToastUnsub) return;
    w.__e2eToastLog = [];
    const m = (await w.__appImport!(mod)) as {
      useToastStore: {
        subscribe: (l: (s: { toasts: Array<{ id: string; message: string; variant: string }> }, p: { toasts: Array<{ id: string }> }) => void) => () => void;
      };
    };
    w.__e2eToastUnsub = m.useToastStore.subscribe((state, prev) => {
      const had = new Set(prev.toasts.map((t) => t.id));
      for (const t of state.toasts) {
        if (!had.has(t.id)) w.__e2eToastLog!.push({ id: t.id, message: String(t.message), variant: t.variant });
      }
    });
  }, TOAST_STORE);
}

/** The position in the toast log (pass it to `toastsSince`). */
export async function toastMark(page: Page): Promise<number> {
  await startToastLog(page);
  return page.evaluate(() => (window as unknown as AppWindow).__e2eToastLog!.length);
}

export async function toastsSince(page: Page, mark: number): Promise<Array<{ message: string; variant: string }>> {
  return page.evaluate(
    (mark) => ((window as unknown as AppWindow).__e2eToastLog ?? []).slice(mark).map((t) => ({ message: t.message, variant: t.variant })),
    mark,
  );
}

/** Close every visible toast (their OK buttons), so none covers the grid. */
export async function dismissToasts(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.querySelectorAll<HTMLElement>("[data-toast] button").forEach((b) => b.click());
  });
  await page.waitForTimeout(80);
}

/** Ids of the dialogs the Shell shows right now (the dialog registry, not the DOM). */
export async function openDialogs(page: Page): Promise<Array<{ id: string; data: unknown }>> {
  await installAppImport(page);
  return page.evaluate(async (mod) => {
    const m = (await (window as unknown as AppWindow).__appImport!(mod)) as {
      DialogExtensions: { getVisibleDialogs: () => Array<{ definition: { id: string }; data?: unknown }> };
    };
    return m.DialogExtensions.getVisibleDialogs().map((d) => ({ id: d.definition.id, data: d.data ?? null }));
  }, API_UI);
}

/** Ids of the overlays the Shell shows right now. */
export async function openOverlays(page: Page): Promise<string[]> {
  await installAppImport(page);
  return page.evaluate(async (mod) => {
    const m = (await (window as unknown as AppWindow).__appImport!(mod)) as {
      OverlayExtensions: { getVisibleOverlays: () => Array<{ definition: { id: string } }> };
    };
    return m.OverlayExtensions.getVisibleOverlays().map((o) => o.definition.id);
  }, API_UI);
}

/** Close every dialog and overlay the registries show (cleanup). */
export async function closeDialogsAndOverlays(page: Page): Promise<void> {
  await installAppImport(page);
  await page.evaluate(async (mod) => {
    const m = (await (window as unknown as AppWindow).__appImport!(mod)) as {
      DialogExtensions: { getVisibleDialogs: () => Array<{ definition: { id: string } }>; closeDialog: (id: string) => void };
      OverlayExtensions: { hideAllOverlays?: () => void };
    };
    for (const d of m.DialogExtensions.getVisibleDialogs()) m.DialogExtensions.closeDialog(d.definition.id);
    m.OverlayExtensions.hideAllOverlays?.();
  }, API_UI);
  await page.waitForTimeout(150);
}

/** Record unhandled promise rejections from now on. Idempotent; returns the mark. */
export async function rejectionMark(page: Page): Promise<number> {
  return page.evaluate(() => {
    const w = window as unknown as AppWindow;
    if (!w.__e2eRejectionsHooked) {
      w.__e2eRejections = [];
      window.addEventListener("unhandledrejection", (e) => {
        const r = (e as PromiseRejectionEvent).reason;
        w.__e2eRejections!.push(r instanceof Error ? r.message : String(r));
      });
      w.__e2eRejectionsHooked = true;
    }
    return w.__e2eRejections!.length;
  });
}

export async function rejectionsSince(page: Page, mark: number): Promise<string[]> {
  return page.evaluate((mark) => ((window as unknown as AppWindow).__e2eRejections ?? []).slice(mark), mark);
}

// ---------------------------------------------------------------------------
// Menus (the registry the MenuBar renders), driven as the MenuBar drives them
// ---------------------------------------------------------------------------

/**
 * Run the menu item at `path` (["Data", "Sort A to Z"]) exactly as the MenuBar
 * does when it is clicked: its `action()`, else `CommandRegistry.execute` of
 * its command. Labels match exactly, or by a leading-text match when the path
 * element ends in "..." is omitted. Fails naming the labels that exist.
 */
export async function runMenuItem(page: Page, path: string[]): Promise<void> {
  await installAppImport(page);
  const err = await bounded(
    `menu ${path.join(" > ")}`,
    page.evaluate(
      async ({ path, uiMod, cmdMod }) => {
        type Item = {
          id?: string;
          label: string;
          action?: () => unknown;
          commandId?: string;
          children?: Item[];
          hidden?: boolean;
          separator?: boolean;
          disabled?: boolean;
        };
        const ui = (await (window as unknown as AppWindow).__appImport!(uiMod)) as { getMenus: () => Array<{ label: string; items: Item[]; hidden?: boolean }> };
        const cmds = (await (window as unknown as AppWindow).__appImport!(cmdMod)) as {
          CommandRegistry: { execute: (id: string) => Promise<unknown> };
        };
        const menus = ui.getMenus().filter((m) => !m.hidden);
        const norm = (s: string) => s.replace(/…/g, "...").trim().toLowerCase();
        const menu = menus.find((m) => norm(m.label) === norm(path[0]));
        if (!menu) return `no menu "${path[0]}" (menus: ${menus.map((m) => m.label).join(", ")})`;
        let level: Item[] = menu.items;
        let item: Item | undefined;
        for (const label of path.slice(1)) {
          const visible = level.filter((i) => !i.hidden && !i.separator);
          item =
            visible.find((i) => norm(i.label) === norm(label)) ??
            visible.find((i) => norm(i.label).replace(/\.\.\.$/, "") === norm(label).replace(/\.\.\.$/, ""));
          if (!item) return `no item "${label}" under ${path.slice(0, path.indexOf(label)).join(" > ")} (items: ${visible.map((i) => i.label).join(" | ")})`;
          level = item.children ?? [];
        }
        if (!item) return "empty path";
        if (item.disabled) return `item "${item.label}" is disabled`;
        if (item.action) await item.action();
        else if (item.commandId) await cmds.CommandRegistry.execute(item.commandId);
        else return `item "${item.label}" has neither an action nor a command`;
        return null;
      },
      { path, uiMod: API_UI, cmdMod: API_COMMANDS },
    ),
  );
  if (err) throw new Error(`runMenuItem: ${err}`);
  await page.waitForTimeout(250);
}

/** Whether a menu item exists at `path`, and how many items carry its last label. */
export async function menuItemCount(page: Page, path: string[]): Promise<number> {
  await installAppImport(page);
  return page.evaluate(
    async ({ path, uiMod }) => {
      type Item = { label: string; children?: Item[]; hidden?: boolean; separator?: boolean };
      const ui = (await (window as unknown as AppWindow).__appImport!(uiMod)) as { getMenus: () => Array<{ label: string; items: Item[]; hidden?: boolean }> };
      const norm = (s: string) => s.replace(/…/g, "...").trim().toLowerCase();
      const menu = ui.getMenus().find((m) => !m.hidden && norm(m.label) === norm(path[0]));
      if (!menu) return 0;
      let level: Item[] = menu.items;
      for (let i = 1; i < path.length; i++) {
        const matches = level.filter((x) => !x.hidden && !x.separator && norm(x.label) === norm(path[i]));
        if (i === path.length - 1) return matches.length;
        if (matches.length === 0) return 0;
        level = matches[0].children ?? [];
      }
      return 1;
    },
    { path, uiMod: API_UI },
  );
}

/** Run a registered command by id (the palette's and a menu item's own route). */
export async function executeCommand(page: Page, id: string, arg?: unknown): Promise<void> {
  await installAppImport(page);
  await bounded(
    `command ${id}`,
    page.evaluate(
      async ({ id, arg, mod }) => {
        const m = (await (window as unknown as AppWindow).__appImport!(mod)) as {
          CommandRegistry: { execute: (id: string, arg?: unknown) => Promise<unknown> };
        };
        await m.CommandRegistry.execute(id, arg);
      },
      { id, arg, mod: API_COMMANDS },
    ),
  );
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

export interface SynthKey {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
}

/**
 * Dispatch a synthetic keydown (+ keyup) to the FOCUSED element, the way a
 * keyboard layout Playwright cannot emulate (sv-SE AltGr: ctrl+alt with the
 * layout's character) would deliver it. Returns whether the keydown was
 * default-prevented (someone took it).
 */
export async function synthKey(page: Page, init: SynthKey): Promise<boolean> {
  return page.evaluate((init) => {
    const target = (document.activeElement as HTMLElement | null) ?? document.body;
    const opts = { bubbles: true, cancelable: true, composed: true, ...init };
    const down = new KeyboardEvent("keydown", opts);
    target.dispatchEvent(down);
    target.dispatchEvent(new KeyboardEvent("keyup", opts));
    return down.defaultPrevented;
  }, init);
}

/**
 * Diagnostics: record every keydown as it LEAVES the page (a window bubble
 * listener added now, so it runs after the app's own window listeners) --
 * whether someone prevented it, and where it was aimed. Idempotent.
 */
export async function startKeyLog(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __e2eKeyLog?: unknown[]; __e2eKeyLogOn?: boolean };
    w.__e2eKeyLog = [];
    if (w.__e2eKeyLogOn) return;
    w.__e2eKeyLogOn = true;
    window.addEventListener("keydown", (e) => {
      const t = e.target as HTMLElement | null;
      (w.__e2eKeyLog as unknown[]).push({
        key: e.key,
        code: e.code,
        ctrl: e.ctrlKey,
        shift: e.shiftKey,
        alt: e.altKey,
        prevented: e.defaultPrevented,
        target: t ? `${t.tagName}${t.getAttribute("data-focus-container") ? "[grid]" : ""}` : "?",
      });
      if ((w.__e2eKeyLog as unknown[]).length > 30) (w.__e2eKeyLog as unknown[]).shift();
    });
  });
}

export async function keyLog(page: Page): Promise<unknown[]> {
  return page.evaluate(() => ((window as unknown as { __e2eKeyLog?: unknown[] }).__e2eKeyLog ?? []).slice(-6));
}

// ---------------------------------------------------------------------------
// Page geometry
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

/** Page pixel of a sheet-pixel point on the ACTIVE sheet (sheet px measured from A1's corner). */
export async function sheetPointToPage(page: Page, sx: number, sy: number): Promise<{ x: number; y: number }> {
  const geo = await readGridGeometry(page);
  const o = await gridOrigin(page);
  return {
    x: o.x + (geo.rowHeaderWidth + sx - geo.scrollX) * geo.zoom,
    y: o.y + (geo.colHeaderHeight + sy - geo.scrollY) * geo.zoom,
  };
}

/** Page pixel of the centre of a grid cell of the ACTIVE worksheet (scroll-aware). */
export async function cellPagePoint(page: Page, row: number, col: number): Promise<{ x: number; y: number }> {
  const geo = await readGridGeometry(page);
  const o = await gridOrigin(page);
  let x = 0;
  for (let c = 0; c < col; c++) x += geo.hiddenCols.includes(c) ? 0 : geo.columnWidths[c] ?? geo.defaultCellWidth;
  let y = 0;
  for (let r = 0; r < row; r++) y += geo.hiddenRows.includes(r) ? 0 : geo.rowHeights[r] ?? geo.defaultCellHeight;
  const w = geo.columnWidths[col] ?? geo.defaultCellWidth;
  const h = geo.rowHeights[row] ?? geo.defaultCellHeight;
  return {
    x: o.x + (geo.rowHeaderWidth + x + w / 2 - geo.scrollX) * geo.zoom,
    y: o.y + (geo.colHeaderHeight + y + h / 2 - geo.scrollY) * geo.zoom,
  };
}

/** Page pixel of the centre of a column's header (worksheet). */
export async function columnHeaderPoint(page: Page, col: number): Promise<{ x: number; y: number }> {
  const geo = await readGridGeometry(page);
  const o = await gridOrigin(page);
  let x = 0;
  for (let c = 0; c < col; c++) x += geo.hiddenCols.includes(c) ? 0 : geo.columnWidths[c] ?? geo.defaultCellWidth;
  const w = geo.columnWidths[col] ?? geo.defaultCellWidth;
  return {
    x: o.x + (geo.rowHeaderWidth + x + w / 2 - geo.scrollX) * geo.zoom,
    y: o.y + (geo.colHeaderHeight / 2) * geo.zoom,
  };
}

/** Page pixel of the centre of a row's header (worksheet). */
export async function rowHeaderPoint(page: Page, row: number): Promise<{ x: number; y: number }> {
  const geo = await readGridGeometry(page);
  const o = await gridOrigin(page);
  let y = 0;
  for (let r = 0; r < row; r++) y += geo.hiddenRows.includes(r) ? 0 : geo.rowHeights[r] ?? geo.defaultCellHeight;
  const h = geo.rowHeights[row] ?? geo.defaultCellHeight;
  return {
    x: o.x + (geo.rowHeaderWidth / 2) * geo.zoom,
    y: o.y + (geo.colHeaderHeight + y + h / 2 - geo.scrollY) * geo.zoom,
  };
}

/** Page pixel of the select-all corner (worksheet). */
export async function cornerPoint(page: Page): Promise<{ x: number; y: number }> {
  const geo = await readGridGeometry(page);
  const o = await gridOrigin(page);
  return { x: o.x + (geo.rowHeaderWidth / 2) * geo.zoom, y: o.y + (geo.colHeaderHeight / 2) * geo.zoom };
}

// ---------------------------------------------------------------------------
// Floating grids
// ---------------------------------------------------------------------------

/** The default chrome of a floating grid (FloatingRange/lib/frDimensions.ts). */
export const FR_CHROME = { title: 20, colHeader: 16, rowHeader: 28, cellW: 64.29, cellH: 20 };

export interface FrInfo {
  id: string;
  name: string;
  hostSheetIndex: number;
  backingSheetIndex: number;
  rowCount: number;
  colCount: number;
  x: number;
  y: number;
}

/**
 * Create a floating grid on the ACTIVE sheet at sheet px (x, y), through @api
 * (it paints). A new range is 1x1; `size` widens its window (the product's
 * own update route) so its cells can be navigated and picked.
 */
export async function createFr(
  page: Page,
  x: number,
  y: number,
  name: string,
  size: { rows: number; cols: number } = { rows: 6, cols: 4 },
): Promise<FrInfo> {
  const created = await callModule<{ id: string }>(page, FLOATING_RANGES, "createFloatingRange", [x, y, name]);
  if (size.rows !== 1 || size.cols !== 1) {
    await callModule(page, FLOATING_RANGES, "updateFloatingRange", [created.id, { rowCount: size.rows, colCount: size.cols }]);
  }
  const list = await eventually(
    () => invoke<FrInfo[]>(page, "list_floating_ranges"),
    (l) => l.some((f) => f.id === created.id && f.rowCount === size.rows && f.colCount === size.cols),
    "the floating grid was not created at its size",
  );
  await page.waitForTimeout(700);
  return list.find((f) => f.id === created.id)!;
}

export async function frList(page: Page): Promise<FrInfo[]> {
  return invoke<FrInfo[]>(page, "list_floating_ranges");
}

/** Set one floating-grid cell through @api (the product's announced route). */
export async function setFrCell(page: Page, id: string, row: number, col: number, value: string): Promise<void> {
  await callModule(page, FLOATING_RANGES, "updateFloatingRangeCell", [id, row, col, value]);
  await page.waitForTimeout(150);
}

export async function frCell(page: Page, id: string, row: number, col: number): Promise<{ value: unknown; formula: string | null; display?: string } | null> {
  const cells = await callModule<Array<{ row: number; col: number; value: unknown; formula: string | null; display?: string }>>(
    page,
    FLOATING_RANGES,
    "getFloatingRangeCells",
    [id, row, col, row, col],
  );
  return cells.find((c) => c.row === row && c.col === col) ?? cells[0] ?? null;
}

/** Page pixel of the centre of a floating grid's cell (default chrome, unscrolled). */
export async function frCellPoint(page: Page, fr: { x: number; y: number }, row: number, col: number): Promise<{ x: number; y: number }> {
  return sheetPointToPage(
    page,
    fr.x + FR_CHROME.rowHeader + col * FR_CHROME.cellW + FR_CHROME.cellW / 2,
    fr.y + FR_CHROME.title + FR_CHROME.colHeader + row * FR_CHROME.cellH + FR_CHROME.cellH / 2,
  );
}

/** Page pixel of a floating grid's title bar (the object itself, no cell). */
export async function frTitlePoint(page: Page, fr: { x: number; y: number }): Promise<{ x: number; y: number }> {
  return sheetPointToPage(page, fr.x + 60, fr.y + FR_CHROME.title / 2);
}

export async function clickFrCell(page: Page, fr: { x: number; y: number }, row: number, col: number): Promise<void> {
  const p = await frCellPoint(page, fr, row, col);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(250);
}

export async function frLocalSelection(page: Page): Promise<{ frId: string; anchorRow: number; anchorCol: number; endRow: number; endCol: number } | null> {
  return callModule(page, FR_SELECTION, "getLocalSelection");
}

export async function frObjectSelected(page: Page): Promise<string | null> {
  return callModule(page, FR_SELECTION, "getSelectedFloatingRange");
}

export async function frEditorOpen(page: Page): Promise<boolean> {
  return callModule<boolean>(page, FR_EDITOR, "isFrEditorOpen");
}

export async function frEditorText(page: Page): Promise<string | null> {
  return page.evaluate(() => (document.querySelector("textarea[data-fr-editor]") as HTMLTextAreaElement | null)?.value ?? null);
}

export async function selectionOwned(page: Page): Promise<boolean> {
  return callModule<boolean>(page, SELECTION_OWNER, "isSelectionOwned");
}
