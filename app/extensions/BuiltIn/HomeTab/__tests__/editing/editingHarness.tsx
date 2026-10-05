//! FILENAME: app/extensions/BuiltIn/HomeTab/__tests__/editing/editingHarness.tsx
// PURPOSE: The shared harness of the Editing group's control tests: the five
//          catalog entries as the programme contract defines them, one React
//          root per test, the two surfaces (ribbon band, sidebar panel), and
//          the readers that turn an open menu into something a test can compare
//          (its outline, each row's picture, its checked / disabled state).
// CONTEXT: Not a test file (the name does not match *.test.*), so vitest never
//          collects it; every test file still declares its own vi.mock()s,
//          because a mock is per file and hoisted above the imports.
//
//          The catalog entries are FIXTURES rather than ITEMS_BY_ID lookups:
//          the home-core lane adds "autoSum", "fill", "clear", "sortFilter" and
//          "findSelect" to ALL_ITEMS after this lane, and a test that depended
//          on the catalog would either fail before that or silently start
//          asserting someone else's label after it. These are the contract's
//          (CONTRACT section 2) and the components derive everything else.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SurfaceLayoutProvider, bandLayout, panelLayout, type SurfaceLayout } from "@api/layout";
import type { HomeTabItem } from "../../homeTabConfig";
import type { HomeItemProps, HomeTabState } from "../../components/homeItemProps";

// ============================================================================
// The catalog entries (CONTRACT section 2)
// ============================================================================

export const EDITING_ITEMS = {
  autoSum: { id: "autoSum", label: "AutoSum", tooltip: "AutoSum (Alt+=)", type: "button", category: "Editing", addedIn: 2 },
  fill: { id: "fill", label: "Fill", tooltip: "Fill", type: "dropdown", category: "Editing", addedIn: 2 },
  clear: { id: "clear", label: "Clear", tooltip: "Clear", type: "dropdown", category: "Editing", addedIn: 2 },
  sortFilter: {
    id: "sortFilter",
    label: "Sort & Filter",
    tooltip: "Sort & Filter",
    type: "dropdown",
    category: "Editing",
    hero: true,
    addedIn: 2,
  },
  findSelect: {
    id: "findSelect",
    label: "Find & Select",
    tooltip: "Find & Select",
    type: "dropdown",
    category: "Editing",
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

// ============================================================================
// Reading an open menu
// ============================================================================

/** The open menu (the one popup a test opens at a time). */
export function openMenu(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[role='menu']");
}

const ROW_SELECTOR = "[role='menuitem'], [role='menuitemradio'], [role='menuitemcheckbox']";

/** The menu's rows, in order. */
export function menuRows(): HTMLButtonElement[] {
  const menu = openMenu();
  return menu ? Array.from(menu.querySelectorAll<HTMLButtonElement>(ROW_SELECTOR)) : [];
}

/** A row's visible label (the label span, never the shortcut chip). */
export function rowLabel(row: Element): string {
  return row.querySelector("[data-menu-label]")?.textContent ?? "";
}

/**
 * The menu as Excel draws it: each row's label in order, with "---" where a
 * separator sits, so a test pins the separators' places as well as the rows.
 */
export function menuOutline(): string[] {
  const menu = openMenu();
  if (!menu) return [];
  return Array.from(menu.children).map((el) =>
    el.getAttribute("role") === "separator" ? "---" : rowLabel(el),
  );
}

/** What a row shows in its picture column: a drawing, a reserved blank, or nothing (no column at all). */
export function rowPicture(row: Element): "icon" | "blank" | "none" {
  if (row.querySelector("svg")) return "icon";
  if (row.querySelector("[data-menu-icon-blank]")) return "blank";
  return "none";
}

/** The drawn icon's width attribute, for "menu-row icons are 20px". */
export function rowIconSize(row: Element): string | null {
  return row.querySelector("svg")?.getAttribute("width") ?? null;
}

export function isRowDisabled(row: HTMLButtonElement): boolean {
  return row.disabled || row.getAttribute("aria-disabled") === "true";
}

/** The shortcut chip a row shows, or null. */
export function rowShortcut(row: Element): string | null {
  return row.querySelector("kbd")?.textContent ?? null;
}
