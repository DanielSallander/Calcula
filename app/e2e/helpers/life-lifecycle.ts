/**
 * Helpers for `journeys/fixall-lifecycle.spec.ts`: the extension-lifecycle,
 * menu and door journeys of the fix-all live wave.
 *
 * EVERYTHING HERE READS THE RUNNING APP'S OWN MODULE INSTANCES. The menu
 * registry, the context-menu registries and the command registries are module
 * state; a second copy pulled in under a different URL would be an empty
 * registry that "proves" every item is gone. `appImport` therefore resolves a
 * module to the exact URL the app loaded it from (its resource-timing entry),
 * the idiom canvas.spec.ts and core-edit-keys.spec.ts use.
 */
import type { Page, Locator } from "@playwright/test";
import { readGridGeometry } from "./grid";

// ---------------------------------------------------------------------------
// Page plumbing
// ---------------------------------------------------------------------------

export interface LifeWindow {
  __calcImport: (u: string) => Promise<unknown>;
  __appImport?: (modulePath: string) => Promise<unknown>;
  __TAURI__: { core: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } };
  __CALCULA_EXTENSION_LIFECYCLE__?: {
    deactivate: (id: string) => Promise<void>;
    activate: (id: string) => Promise<void>;
    builtIns: () => Array<{ id: string; status: string }>;
  };
  __CALCULA_EXTENSION_REGISTRY__?: {
    getCommand: (id: string) => unknown;
    getAllCommands: () => Array<{ id: string }>;
    registerCommand: (c: unknown) => void;
    unregisterCommand: (c: unknown) => void;
  };
  __CALCULA_GRID_STATE__?: {
    selection: { startRow: number; startCol: number; endRow: number; endCol: number } | null;
  };
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

export async function installAppImport(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as LifeWindow;
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

export async function invoke<T = unknown>(page: Page, cmd: string, args: unknown = {}): Promise<T> {
  return bounded(
    `invoke ${cmd}`,
    page.evaluate(async ({ c, a }) => (window as unknown as LifeWindow).__TAURI__.core.invoke(c, a), {
      c: cmd,
      a: args,
    }) as Promise<T>,
  );
}

/** Call an exported function of an app module (the app's own instance). */
export async function callModule<T = unknown>(page: Page, mod: string, fn: string, args: unknown[] = []): Promise<T> {
  await installAppImport(page);
  return bounded(
    `${mod}#${fn}`,
    page.evaluate(
      async ({ mod, fn, args }) => {
        const m = (await (window as unknown as LifeWindow).__appImport!(mod)) as Record<string, (...a: unknown[]) => unknown>;
        if (typeof m[fn] !== "function") throw new Error(`${mod} has no export ${fn}`);
        return (await m[fn](...args)) as unknown;
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

// ---------------------------------------------------------------------------
// The app's own File > New (BUG-0205: never a raw invoke("new_file"))
// ---------------------------------------------------------------------------

export const FILE_API = "/src/core/lib/file-api.ts";

export async function appNewFile(page: Page): Promise<void> {
  await callModule(page, FILE_API, "newFile");
  await page.waitForTimeout(400);
}

// ---------------------------------------------------------------------------
// The dev lifecycle hook (wave E, Y15)
// ---------------------------------------------------------------------------

export async function builtIns(page: Page): Promise<Array<{ id: string; status: string }>> {
  return bounded(
    "builtIns",
    page.evaluate(() => {
      const L = (window as unknown as LifeWindow).__CALCULA_EXTENSION_LIFECYCLE__;
      if (!L) throw new Error("window.__CALCULA_EXTENSION_LIFECYCLE__ is not installed (not a dev build?)");
      return L.builtIns();
    }),
  );
}

/** Run the hook's deactivate/activate; resolves to null or the rejection message. */
export async function lifecycle(page: Page, op: "deactivate" | "activate", id: string): Promise<string | null> {
  return bounded(
    `${op} ${id}`,
    page.evaluate(
      async ({ op, id }) => {
        const L = (window as unknown as LifeWindow).__CALCULA_EXTENSION_LIFECYCLE__;
        if (!L) return "window.__CALCULA_EXTENSION_LIFECYCLE__ is not installed";
        try {
          await L[op](id);
          return null;
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
      },
      { op, id },
    ),
    30_000,
  );
}

export async function statusOf(page: Page, id: string): Promise<string | undefined> {
  return (await builtIns(page)).find((e) => e.id === id)?.status;
}

/**
 * Put every built-in the test took down back up. Never throws: it runs in
 * `finally` blocks, where a second error would hide the first.
 */
export async function reactivateAll(page: Page, ids: string[]): Promise<string[]> {
  const problems: string[] = [];
  for (const id of ids) {
    try {
      const status = await statusOf(page, id);
      if (status === "active") continue;
      const err = await lifecycle(page, "activate", id);
      if (err) problems.push(`${id}: ${err}`);
    } catch (e) {
      problems.push(`${id}: ${String(e)}`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Registry snapshots
// ---------------------------------------------------------------------------

export interface MenuNode {
  id: string;
  label: string;
  hidden: boolean;
  separator: boolean;
  children: MenuNode[];
}

export interface MenuSnap {
  id: string;
  label: string;
  hidden: boolean;
  items: MenuNode[];
}

export interface RegistrySnapshot {
  menus: MenuSnap[];
  gridContext: string[];
  sheetContext: string[];
  extCommands: string[];
  coreCommands: string[];
  ribbonTabs: string[];
}

export async function snapshot(page: Page): Promise<RegistrySnapshot> {
  await installAppImport(page);
  return bounded(
    "registry snapshot",
    page.evaluate(async () => {
      const w = window as unknown as LifeWindow;
      const ui = (await w.__appImport!("/src/api/ui.ts")) as {
        getMenus: () => Array<{ id: string; label: string; hidden?: boolean; items: unknown[] }>;
      };
      const ext = (await w.__appImport!("/src/api/extensions.ts")) as {
        gridExtensions: { getContextMenuItems: () => Array<{ id: string; children?: unknown[] }> };
        sheetExtensions: { getContextMenuItems: () => Array<{ id: string }> };
        ExtensionRegistry: { getAllCommands: () => Array<{ id: string }>; getRibbonTabs: () => Array<{ id: string }> };
      };
      const cmds = (await w.__appImport!("/src/api/commands.ts")) as { CommandRegistry: { getAll: () => string[] } };
      type Raw = { id: string; label?: unknown; hidden?: boolean; separator?: boolean; children?: Raw[] };
      const walk = (items: Raw[] | undefined): unknown[] =>
        (items ?? []).map((it) => ({
          id: String(it.id),
          label: typeof it.label === "string" ? it.label : "",
          hidden: !!it.hidden,
          separator: !!it.separator,
          children: walk(it.children),
        }));
      const ctxIds = (items: Array<{ id: string; children?: unknown[] }>): string[] => {
        const out: string[] = [];
        const go = (xs: Array<{ id: string; children?: unknown[] }>) => {
          for (const x of xs) {
            out.push(String(x.id));
            if (Array.isArray(x.children)) go(x.children as Array<{ id: string; children?: unknown[] }>);
          }
        };
        go(items);
        return out;
      };
      return {
        menus: ui.getMenus().map((m) => ({
          id: m.id,
          label: m.label,
          hidden: !!m.hidden,
          items: walk(m.items as Raw[]),
        })),
        gridContext: ctxIds(ext.gridExtensions.getContextMenuItems()),
        sheetContext: ctxIds(ext.sheetExtensions.getContextMenuItems()),
        extCommands: ext.ExtensionRegistry.getAllCommands().map((c) => String(c.id)),
        coreCommands: cmds.CommandRegistry.getAll().map(String),
        ribbonTabs: ext.ExtensionRegistry.getRibbonTabs().map((t) => String(t.id)),
      };
    }),
  ) as Promise<RegistrySnapshot>;
}

/** Every menu-item key, `menuId>itemId`, at every depth (with repeats). */
export function menuKeys(s: RegistrySnapshot): string[] {
  const out: string[] = [];
  for (const m of s.menus) {
    out.push(`#menu:${m.id}`);
    const go = (xs: MenuNode[]) => {
      for (const x of xs) {
        out.push(`${m.id}>${x.id}`);
        go(x.children);
      }
    };
    go(m.items);
  }
  return out;
}

/** All keys of every registry in one list, prefixed by registry, repeats kept. */
export function allKeys(s: RegistrySnapshot): string[] {
  return [
    ...menuKeys(s),
    ...s.gridContext.map((id) => `grid-ctx:${id}`),
    ...s.sheetContext.map((id) => `sheet-ctx:${id}`),
    ...s.extCommands.map((id) => `ext-cmd:${id}`),
    ...s.coreCommands.map((id) => `cmd:${id}`),
    ...s.ribbonTabs.map((id) => `ribbon:${id}`),
  ];
}

/** Multiset difference a - b (each key once per surplus occurrence). */
export function multisetMinus(a: string[], b: string[]): string[] {
  const counts = new Map<string, number>();
  for (const k of b) counts.set(k, (counts.get(k) ?? 0) + 1);
  const out: string[] = [];
  for (const k of a) {
    const n = counts.get(k) ?? 0;
    if (n > 0) counts.set(k, n - 1);
    else out.push(k);
  }
  return out;
}

export function duplicates(keys: string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const k of keys) {
    if (seen.has(k)) dup.add(k);
    seen.add(k);
  }
  return [...dup].sort();
}

/** Labels (non-separator, non-hidden) under a menu, optionally below a path of labels. */
export function labelsIn(s: RegistrySnapshot, menuId: string, path: string[] = []): string[] | null {
  const m = s.menus.find((x) => x.id === menuId);
  if (!m) return null;
  let items = m.items;
  for (const step of path) {
    const next = items.find((x) => x.label === step);
    if (!next) return null;
    items = next.children;
  }
  return items.filter((x) => !x.separator && !x.hidden).map((x) => x.label);
}

/** Every non-separator label anywhere under a menu (flattened). */
export function allLabelsIn(s: RegistrySnapshot, menuId: string): string[] {
  const m = s.menus.find((x) => x.id === menuId);
  if (!m) return [];
  const out: string[] = [];
  const go = (xs: MenuNode[]) => {
    for (const x of xs) {
      if (!x.separator && !x.hidden) out.push(x.label);
      go(x.children);
    }
  };
  go(m.items);
  return out;
}

export function menuIds(s: RegistrySnapshot): string[] {
  return s.menus.map((m) => m.id);
}

export function hasItem(s: RegistrySnapshot, menuId: string, itemId: string): boolean {
  return menuKeys(s).includes(`${menuId}>${itemId}`);
}

// ---------------------------------------------------------------------------
// The RENDERED menu bar (what the user sees)
// ---------------------------------------------------------------------------

const MENUBAR_ATTR = "data-life-menubar";

/**
 * Find the menu bar and mark it with a test attribute. The bar has no data
 * attributes of its own, so it is found by STRUCTURE: the element whose
 * children are one container per visible menu (in the registry's order), each
 * starting with a button that reads the menu's label. Returns the bar's
 * top-level labels as rendered, or [] when no element matches.
 */
export async function renderedMenuBar(page: Page): Promise<string[]> {
  const snap = await snapshot(page);
  const labels = snap.menus.filter((m) => !m.hidden).map((m) => m.label);
  return bounded(
    "rendered menu bar",
    page.evaluate(
      ({ labels, attr }) => {
        document.querySelectorAll(`[${attr}]`).forEach((e) => e.removeAttribute(attr));
        if (labels.length === 0) return [] as string[];
        const candidates = Array.from(document.querySelectorAll("button")).filter(
          (b) => (b.textContent ?? "").trim() === labels[0] && b.parentElement?.firstElementChild === b,
        );
        for (const b of candidates) {
          const bar = b.parentElement?.parentElement;
          if (!bar) continue;
          const buttons = Array.from(bar.children)
            .map((c) => c.firstElementChild)
            .filter((x): x is HTMLButtonElement => x instanceof HTMLButtonElement)
            .map((x) => (x.textContent ?? "").trim());
          if (buttons.length === labels.length && labels.every((l, i) => buttons[i] === l)) {
            bar.setAttribute(attr, "");
            return buttons;
          }
        }
        return [] as string[];
      },
      { labels, attr: MENUBAR_ATTR },
    ),
  );
}

function exact(label: string): RegExp {
  return new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
}

/** The top-level button of a menu inside the (marked) menu bar. */
async function menuButton(page: Page, label: string): Promise<Locator> {
  await renderedMenuBar(page);
  return page.locator(`[${MENUBAR_ATTR}] > div > button`).filter({ hasText: exact(label) }).first();
}

/**
 * The label a rendered menu item shows. Its first child is the icon + the
 * label span; several icons draw TEXT ("A/Z" on the sort icons, "fx", "PDF"),
 * so the label is the LAST line of that child's text, never the whole of it --
 * a whole-text comparison would read every such item as absent, which makes a
 * "gone" assertion pass for an item that is still there.
 */
async function itemLabel(b: Locator): Promise<string> {
  const text = ((await b.locator("xpath=./*[1]").innerText().catch(() => "")) ?? "").trim();
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1] : "";
}

/** Open `menuLabel` and walk `path` by hovering; returns the level holding the last items. */
async function openLevel(page: Page, menuLabel: string, path: string[]): Promise<{ btn: Locator; level: Locator | null }> {
  const btn = await menuButton(page, menuLabel);
  if ((await btn.count()) === 0) return { btn, level: null };
  await btn.click();
  await page.waitForTimeout(250);
  let level: Locator = btn.locator("xpath=../*[2]");
  if ((await level.count()) === 0) return { btn, level: null };
  for (const step of path) {
    const itemButtons = level.locator("xpath=./div/button");
    const n = await itemButtons.count();
    let found: Locator | null = null;
    for (let i = 0; i < n; i++) {
      if ((await itemLabel(itemButtons.nth(i))) === step) {
        found = itemButtons.nth(i);
        break;
      }
    }
    if (!found) return { btn, level: null };
    await found.hover();
    await page.waitForTimeout(300);
    level = found.locator("xpath=../*[2]");
    if ((await level.count()) === 0) return { btn, level: null };
  }
  return { btn, level };
}

async function closeMenuBar(page: Page, btn: Locator): Promise<void> {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  const still = await btn.locator("xpath=../*[2]").count().catch(() => 0);
  if (still > 0) {
    await btn.click().catch(() => {});
    await page.waitForTimeout(150);
  }
}

/**
 * Open a top-level menu in the REAL menu bar and read what it shows. With a
 * `path`, hover each submenu label in turn and read the last one's children.
 * Returns the item labels as rendered (separators excluded), or null when the
 * menu (or a step of the path) is not there. Closes the menu.
 */
export async function renderedMenuItems(page: Page, menuLabel: string, path: string[] = []): Promise<string[] | null> {
  const { btn, level } = await openLevel(page, menuLabel, path);
  try {
    if (!level) return null;
    const itemButtons = level.locator("xpath=./div/button");
    const n = await itemButtons.count();
    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push(await itemLabel(itemButtons.nth(i)));
    return out;
  } finally {
    if ((await btn.count()) > 0) await closeMenuBar(page, btn);
  }
}

/**
 * Click a menu item through the REAL menu bar: open `path[0]`, hover every
 * intermediate submenu, click the last label. Throws with what WAS there when
 * a step is missing, so a failure names the menu the user would have seen.
 */
export async function clickMenuPath(page: Page, path: string[]): Promise<void> {
  const [top, ...rest] = path;
  const last = rest.pop();
  if (!last) throw new Error("clickMenuPath needs a menu and an item");
  const { btn, level } = await openLevel(page, top, rest);
  if (!level) {
    if ((await btn.count()) > 0) await closeMenuBar(page, btn);
    throw new Error(`menu path ${JSON.stringify(path)}: '${top}' or a submenu on the way is not there`);
  }
  const itemButtons = level.locator("xpath=./div/button");
  const n = await itemButtons.count();
  const seen: string[] = [];
  for (let i = 0; i < n; i++) {
    const label = await itemLabel(itemButtons.nth(i));
    seen.push(label);
    if (label === last) {
      await itemButtons.nth(i).click();
      await page.waitForTimeout(400);
      return;
    }
  }
  await closeMenuBar(page, btn);
  throw new Error(`menu path ${JSON.stringify(path)}: no item '${last}' (saw ${JSON.stringify(seen)})`);
}

/** The ribbon's tab strip labels (the canvas.spec reading). */
export async function ribbonTabs(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const band = document.querySelector("[data-ribbon-content]");
    const strip = band?.parentElement?.querySelector("div");
    return Array.from(strip?.querySelectorAll("button") ?? []).map((b) => (b.textContent ?? "").trim());
  });
}

// ---------------------------------------------------------------------------
// Grid state, the selection owner, floating ranges
// ---------------------------------------------------------------------------

export async function gridSelection(
  page: Page,
): Promise<{ startRow: number; startCol: number; endRow: number; endCol: number } | null> {
  return page.evaluate(() => {
    const s = (window as unknown as LifeWindow).__CALCULA_GRID_STATE__?.selection;
    return s ? { startRow: s.startRow, startCol: s.startCol, endRow: s.endRow, endCol: s.endCol } : null;
  });
}

export async function selectionOwned(page: Page): Promise<boolean> {
  return callModule<boolean>(page, "/src/core/lib/selectionOwner.ts", "isSelectionOwned");
}

export const FLOATING_RANGES = "/src/api/floatingRanges.ts";

export interface FrInfo {
  id: string;
  name: string;
  x: number;
  y: number;
}

/** Create a floating range through the @api wrapper (announces, so it paints). */
export async function createFr(page: Page, x: number, y: number, name: string): Promise<FrInfo> {
  return callModule<FrInfo>(page, FLOATING_RANGES, "createFloatingRange", [x, y, name]);
}

export async function deleteFr(page: Page, id: string): Promise<void> {
  await callModule(page, FLOATING_RANGES, "deleteFloatingRange", [id]);
}

/**
 * Click a local cell of a floating range sitting at sheet pixel (frX, frY),
 * default chrome (the floating-range.spec geometry: 28px row headers, 20px
 * title, 16px column headers, 64.29 x 20 cells).
 */
export async function clickFrCell(page: Page, frX: number, frY: number, row: number, col: number): Promise<void> {
  const g = await readGridGeometry(page);
  const dx = 28 + col * 64.29 + 64.29 / 2;
  const dy = 20 + 16 + row * 20 + 10;
  const canvasX = g.rowHeaderWidth + frX - g.scrollX + dx;
  const canvasY = g.colHeaderHeight + frY - g.scrollY + dy;
  const p = await page.evaluate(
    ({ canvasX, canvasY, zoom }) => {
      const layer = document.querySelector("[data-grid-canvas-layer]");
      if (!layer) throw new Error("grid canvas layer not found");
      const rect = layer.getBoundingClientRect();
      return { x: rect.left + canvasX * zoom, y: rect.top + canvasY * zoom };
    },
    { canvasX, canvasY, zoom: g.zoom },
  );
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(250);
}

// ---------------------------------------------------------------------------
// Context menus
// ---------------------------------------------------------------------------

export const GRID_MENU = '[role="menu"][aria-label="Context menu"]';

/**
 * Right-click a cell of the active worksheet and read the grid context menu's
 * items: each item's text as LINES (icon text, label, shortcut), so a caller
 * matches a label against any line. Closes the menu.
 */
export async function gridContextMenuLabels(
  page: Page,
  cellCenter: { x: number; y: number },
): Promise<string[][]> {
  const box = await page.locator("canvas").first().boundingBox();
  if (!box) throw new Error("grid canvas not found");
  const x = box.x + cellCenter.x;
  const y = box.y + cellCenter.y;
  await page.mouse.move(x, y);
  await page.waitForTimeout(120);
  await page.mouse.click(x, y, { button: "right" });
  const menu = page.locator(GRID_MENU);
  try {
    await menu.first().waitFor({ state: "visible", timeout: 5000 });
    return (await menu.first().locator('[role="menuitem"]').allInnerTexts()).map((t) =>
      t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean),
    );
  } finally {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
  }
}

// ---------------------------------------------------------------------------
// Dialog teardown
// ---------------------------------------------------------------------------

/** Press Escape a few times and click any close button left (dialogs left by a failure). */
export async function closeDialogs(page: Page): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(80);
  }
  await page.evaluate(() => {
    document.querySelectorAll<HTMLElement>("[data-calcula-prompt] button").forEach((b) => {
      if ((b.textContent ?? "").trim() === "Cancel") b.click();
    });
  });
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

/** The MESSAGE of every toast on screen (the card's second span; its OK button excluded). */
export async function toastTexts(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-toast]")).map((t) => {
      const spans = t.querySelectorAll<HTMLElement>(":scope > span");
      const msg = spans.length >= 2 ? spans[1] : t;
      return (msg.innerText ?? msg.textContent ?? "").trim();
    }),
  );
}

export async function dismissToasts(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.querySelectorAll<HTMLElement>("[data-toast] button").forEach((b) => b.click());
  });
  await page.waitForTimeout(150);
}
