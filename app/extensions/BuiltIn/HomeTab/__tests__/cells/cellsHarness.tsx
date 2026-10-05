//! FILENAME: app/extensions/BuiltIn/HomeTab/__tests__/cells/cellsHarness.tsx
// PURPOSE: The shared harness of the Cells group's control tests (Insert,
//          Delete, Format): the three catalog entries as the programme contract
//          defines them, one React root per test, the two surfaces (ribbon
//          band, sidebar panel), and the readers that turn an open menu -- and
//          an open submenu -- into something a test can compare (its outline
//          with headings and separators, each row's picture, its checked /
//          disabled state).
// CONTEXT: Not a test file (the name does not match *.test.*), so vitest never
//          collects it; every test file still declares its own vi.mock()s,
//          because a mock is per file and hoisted above the imports.
//
//          The catalog entries are FIXTURES rather than ITEMS_BY_ID lookups:
//          the home-core lane adds "insertCells", "deleteCells" and
//          "formatMenu" to ALL_ITEMS after this lane, and a test that depended
//          on the catalog would either fail before that or silently start
//          asserting someone else's label after it. These are CONTRACT
//          section 2's, and the components derive everything else.
//
//          A copy of the Editing lane's harness shape (editing/editingHarness.tsx)
//          rather than an import of it: each lane owns only its own folder, and
//          this one also reads MenuHeadings and NESTED menus, which the Format
//          menu has and the Editing menus do not.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SurfaceLayoutProvider, bandLayout, panelLayout, type SurfaceLayout } from "@api/layout";
import type { HomeTabItem } from "../../homeTabConfig";
import type { HomeItemProps, HomeTabState } from "../../components/homeItemProps";

// ============================================================================
// The catalog entries (CONTRACT section 2)
// ============================================================================

export const CELLS_ITEMS = {
  insertCells: {
    id: "insertCells",
    label: "Insert",
    tooltip: "Insert Cells",
    type: "button",
    category: "Cells",
    hero: true,
    addedIn: 2,
  },
  deleteCells: {
    id: "deleteCells",
    label: "Delete",
    tooltip: "Delete Cells",
    type: "button",
    category: "Cells",
    hero: true,
    addedIn: 2,
  },
  formatMenu: {
    id: "formatMenu",
    label: "Format",
    tooltip: "Format",
    type: "dropdown",
    category: "Cells",
    hero: true,
    addedIn: 2,
  },
} satisfies Record<string, HomeTabItem>;

/**
 * The group state the components are handed. They run every command through
 * CommandRegistry (the one door the menu bar, the keyboard and scripts share)
 * and read nothing from the group's formatting state, so an empty object is
 * the honest stand-in: a component that started depending on it would fail
 * here rather than pass on a double that answered everything.
 */
export const NO_GROUP_STATE = {} as HomeTabState;

/** HomeItemProps for one entry on one surface. */
export function propsFor(item: HomeTabItem, band: boolean): HomeItemProps {
  return { item, state: NO_GROUP_STATE, band };
}

// ============================================================================
// Surfaces
// ============================================================================

export interface Surface {
  name: "band" | "panel";
  layout: () => SurfaceLayout;
  /** The `band` prop the dispatcher passes on this surface. */
  band: boolean;
}

export const SURFACES: readonly Surface[] = [
  { name: "band", layout: () => bandLayout(1200), band: true },
  { name: "panel", layout: () => panelLayout(300), band: false },
];

// ============================================================================
// The root
// ============================================================================

let container: HTMLDivElement | null = null;
let root: Root | null = null;

/** beforeEach: a fresh root in a fresh container. */
export function mountRoot(): void {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
}

/** afterEach: unmount, and drop every portal the test left behind. */
export function unmountRoot(): void {
  const r = root;
  if (r) act(() => r.unmount());
  root = null;
  container = null;
  document.body.innerHTML = "";
}

export function host(): HTMLDivElement {
  if (!container) throw new Error("mountRoot() was not called");
  return container;
}

/** Render `node` on `surface` and let its effects (and their reads) settle. */
export async function renderOn(surface: Surface, node: React.ReactElement): Promise<void> {
  const r = root;
  if (!r) throw new Error("mountRoot() was not called");
  await act(async () => {
    r.render(<SurfaceLayoutProvider value={surface.layout()}>{node}</SurfaceLayoutProvider>);
  });
}

// ============================================================================
// Events
// ============================================================================

export function byTestId(id: string): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>(`[data-testid='${id}']`);
  if (!el) throw new Error(`no [data-testid='${id}']`);
  return el;
}

export function maybeTestId(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid='${id}']`);
}

/** A pointer click (detail 1, as a real press gives). */
export function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
  });
}

export function key(el: Element, k: string): void {
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
}

/** Let resolved promises (a backend read, a rejected command) land. */
export async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

/** Like settle(), but also lets zero-delay timers run (the colour palette's
 *  theme load and its deferred focus). */
export async function settleTimers(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

// ============================================================================
// Reading an open menu
// ============================================================================

/** Every open menu level, outermost first (portals append in opening order). */
export function openMenus(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[role='menu']"));
}

/** The top-level open menu, or null. */
export function openMenu(): HTMLElement | null {
  return openMenus()[0] ?? null;
}

const ROW_SELECTOR = "[role='menuitem'], [role='menuitemradio'], [role='menuitemcheckbox']";

/** The rows of `menu` (default: the top menu), in order -- its OWN rows, never
 *  a nested flyout's (flyouts are portals, so they are not descendants). */
export function menuRows(menu: HTMLElement | null = openMenu()): HTMLButtonElement[] {
  return menu ? Array.from(menu.querySelectorAll<HTMLButtonElement>(ROW_SELECTOR)) : [];
}

/** A row's visible label (the label span, never the shortcut chip). */
export function rowLabel(row: Element): string {
  return row.querySelector("[data-menu-label]")?.textContent ?? "";
}

/**
 * The menu as Excel draws it: each row's label in order, "---" where a
 * separator sits and "# Heading" where a MenuHeading sits, so a test pins the
 * headings' and the separators' places as well as the rows.
 */
export function menuOutline(menu: HTMLElement | null = openMenu()): string[] {
  if (!menu) return [];
  return Array.from(menu.children).map((el) => {
    if (el.getAttribute("role") === "separator") return "---";
    if (el.getAttribute("role") === "presentation") return `# ${el.textContent ?? ""}`;
    return rowLabel(el);
  });
}

/**
 * The row's picture column: the span just before the label. A row is [check
 * column][picture column?][label][trailing], so the span before the label is
 * the picture column UNLESS it is the row's first child -- then the row has no
 * picture column and that span is the check column (whose tick is an svg too,
 * as a submenu row's right chevron is: neither is a picture).
 */
function pictureColumn(row: Element): Element | null {
  const before = row.querySelector("[data-menu-label]")?.previousElementSibling ?? null;
  return before && before !== row.firstElementChild ? before : null;
}

function pictureSvg(row: Element): SVGElement | null {
  return pictureColumn(row)?.querySelector<SVGElement>("svg") ?? null;
}

/** What a row shows in its picture column: a drawing, a reserved blank, or nothing (no column at all). */
export function rowPicture(row: Element): "icon" | "blank" | "none" {
  if (pictureSvg(row)) return "icon";
  if (pictureColumn(row)?.querySelector("[data-menu-icon-blank]")) return "blank";
  return "none";
}

/** The drawn icon's width attribute, for "menu-row icons are 20px". */
export function rowIconSize(row: Element): string | null {
  return pictureSvg(row)?.getAttribute("width") ?? null;
}

/** Whether a row opens a submenu (MenuSub). */
export function isSubmenuRow(row: Element): boolean {
  return row.querySelector("[data-submenu-chevron]") !== null;
}

export function isRowDisabled(row: HTMLButtonElement): boolean {
  return row.disabled || row.getAttribute("aria-disabled") === "true";
}

/** The shortcut chip a row shows, or null. */
export function rowShortcut(row: Element): string | null {
  return row.querySelector("kbd")?.textContent ?? null;
}
