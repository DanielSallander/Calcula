//! FILENAME: app/extensions/BuiltIn/HomeTab/__tests__/styles/stylesHarness.tsx
// PURPOSE: The shared harness of the Styles-group tests: mounting under a
//          surface layout, the DOM events the controls answer, reading a
//          tooltip, and registering items in the REAL menu registry with a
//          cleanup that really takes them back.
// CONTEXT: Not a test file (vitest collects only *.test.tsx). The vi.mock
//          calls each test needs stay in the test files themselves, because
//          vitest hoists them per file.
//
//          WHY THE CLEANUP IS FUSSY. The menu registry is a module singleton,
//          and `unregisterMenu` deliberately KEEPS the items other extensions
//          added with registerMenuItem -- they come back with the next
//          registerMenu. So a test that only took the Format menu back would
//          hand its Conditional Formatting tree to the next test, which would
//          then pass for the wrong reason ("the button is enabled" -- by the
//          previous test's registration). Every registered item is taken back
//          by its own id first.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { vi } from "vitest";
import { SurfaceLayoutProvider, TOOLTIP_DELAY_MS, type SurfaceLayout } from "@api/layout";
import {
  registerMenu,
  registerMenuItem,
  unregisterMenu,
  unregisterMenuItem,
  type MenuItemDefinition,
} from "@api/ui";
import { ITEMS_BY_ID, type HomeTabItem } from "../../homeTabConfig";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

export function mount(): void {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
}

export function unmount(): void {
  const r = root;
  if (r) act(() => r.unmount());
  root = null;
  container = null;
  vi.useRealTimers();
  document.body.innerHTML = "";
}

export function host(): HTMLDivElement {
  if (!container) throw new Error("mount() first");
  return container;
}

export async function render(node: React.ReactNode, layout: SurfaceLayout): Promise<void> {
  const r = root;
  if (!r) throw new Error("mount() first");
  await act(async () => {
    r.render(<SurfaceLayoutProvider value={layout}>{node}</SurfaceLayoutProvider>);
  });
}

/** A pointer click (detail 1, as a mouse sends it). */
export function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
  });
}

/** What Enter or Space on a focused button sends: a click with detail 0. */
export function keyboardClick(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
  });
}

export function key(el: Element, k: string): void {
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
}

export function mouseDown(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  });
}

/** Let promise chains started by a click settle. */
export async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

export function byTestId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.querySelector<T>(`[data-testid='${id}']`);
  if (!el) throw new Error(`no element with data-testid ${id}`);
  return el;
}

export function maybe(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid='${id}']`);
}

export function menus(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[role='menu']"));
}

/** The rows of one menu level, in order (its flyouts are portalled elsewhere). */
export function rows(menu: HTMLElement): HTMLElement[] {
  return Array.from(
    menu.querySelectorAll<HTMLElement>("[role='menuitem'], [role='menuitemradio'], [role='menuitemcheckbox']"),
  );
}

/** A menu level as Excel's menus read: row labels, "---" for a separator. */
export function shape(menu: HTMLElement): string[] {
  return Array.from(menu.children).map((el) =>
    el.getAttribute("role") === "separator"
      ? "---"
      : (el.querySelector("[data-menu-label]")?.textContent ?? el.textContent ?? ""),
  );
}

/** Hover `el` past the tooltip delay, read what `read` wants from the tooltip
 *  it opens, and move away again. */
function withTooltip<T>(el: Element, read: (tip: Element | null) => T): T {
  vi.useFakeTimers();
  try {
    act(() => {
      el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null }));
    });
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS + 50);
    });
  } finally {
    vi.useRealTimers();
  }
  const value = read(document.querySelector("[role='tooltip']"));
  act(() => {
    el.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: null }));
  });
  return value;
}

/** The text of the tooltip `el` opens on hover (chip included), or null. */
export function tooltipOf(el: Element): string | null {
  return withTooltip(el, (tip) => tip?.textContent ?? null);
}

/** The shortcut chip of the tooltip `el` opens on hover, or null. */
export function tooltipChipOf(el: Element): string | null {
  return withTooltip(el, (tip) => tip?.querySelector("kbd")?.textContent ?? null);
}

/** The face picture's markup, drawn alone, to compare with what a control shows. */
export function pictureMarkup(node: React.ReactElement): string {
  const scratch = document.createElement("div");
  const scratchRoot = createRoot(scratch);
  act(() => scratchRoot.render(node));
  const markup = scratch.innerHTML;
  act(() => scratchRoot.unmount());
  return markup;
}

// ============================================================================
// The real menu registry
// ============================================================================

/** The Format menu as StandardMenus builds it (its own rows do not matter here). */
export const FORMAT_MENU_ID = "format";

const registeredItems: Array<[string, string]> = [];
const registeredMenus: string[] = [];

/** Register the Format menu itself (StandardMenus' job in the app). */
export function registerFormatMenu(): void {
  act(() => {
    registerMenu({ id: FORMAT_MENU_ID, label: "Format", order: 50, items: [] });
  });
  registeredMenus.push(FORMAT_MENU_ID);
}

/** Register `item` into `menuId` the way an extension does (registerMenuItem). */
export function registerItem(item: MenuItemDefinition, menuId = FORMAT_MENU_ID): void {
  act(() => {
    registerMenuItem(menuId, item);
  });
  registeredItems.push([menuId, item.id]);
}

/** Take back every registration this test made: items first, then menus. */
export function cleanupRegistry(): void {
  act(() => {
    for (const [menuId, itemId] of registeredItems.splice(0)) unregisterMenuItem(menuId, itemId);
    for (const menuId of registeredMenus.splice(0)) unregisterMenu(menuId);
  });
}

// ============================================================================
// Catalog entries
// ============================================================================

/**
 * The contract's catalog entries for the Styles group (CONTRACT section 2),
 * used until the home-core lane adds them to ALL_ITEMS -- after which the REAL
 * entry wins, so these tests then pin the catalog itself.
 */
const CONTRACT_ITEMS: Readonly<Record<string, HomeTabItem>> = {
  conditionalFormatting: {
    id: "conditionalFormatting",
    label: "Conditional Formatting",
    tooltip: "Conditional Formatting",
    type: "dropdown",
    category: "Styles",
    hero: true,
    addedIn: 2,
  },
  formatAsTable: {
    id: "formatAsTable",
    label: "Format as Table",
    tooltip: "Format as Table",
    type: "dropdown",
    category: "Styles",
    hero: true,
    addedIn: 2,
  },
};

export function stylesItem(id: string): HomeTabItem {
  const item = ITEMS_BY_ID.get(id) ?? CONTRACT_ITEMS[id];
  if (!item) throw new Error(`no catalog entry for ${id}`);
  return item;
}
