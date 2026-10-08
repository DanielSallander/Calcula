//! FILENAME: app/extensions/CanvasSheet/__tests__/tabHarness.tsx
// PURPOSE: The few DOM helpers every Canvas-tab section test shares: mount a
//          section in the ribbon BAND or in a panel, find controls by test id,
//          click them the way a pointer does, and tell which RibbonIcon a
//          control draws.
// CONTEXT: @testing-library/react is not installed; react-dom + `act`, as the
//          rest of this folder does. Not a test file itself (no `.test.`), so
//          vitest never runs it on its own.
//
//          WHICH PICTURE. A rendered RibbonIcon carries no key, so "this
//          control shows LockObjects" is proved by markup: the inner markup of
//          an <svg> inside the control equals the inner markup of the key drawn
//          on its own. The outer <svg> differs by size (a hero is 30px, a menu
//          row 20px, a band button is fitted), the drawing inside does not.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SurfaceLayoutProvider, bandLayout, panelLayout } from "@api/layout";
import { RibbonIcon, type RibbonIconKey } from "@api/ribbonIcons";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

export type Surface = "band" | "panel";

export interface Harness {
  container: HTMLDivElement;
  render(element: React.ReactElement, surface?: Surface): void;
  unmount(): void;
}

/** A fresh container and root; `unmount` also empties the body (popovers portal there). */
export function mountHarness(): Harness {
  Reflect.set(globalThis, "ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root | null = createRoot(container);
  return {
    container,
    render(element, surface = "band") {
      const layout = surface === "band" ? bandLayout() : panelLayout();
      act(() => {
        root!.render(<SurfaceLayoutProvider value={layout}>{element}</SurfaceLayoutProvider>);
      });
    },
    unmount() {
      if (root) act(() => root!.unmount());
      root = null;
      container.remove();
      document.body.innerHTML = "";
    },
  };
}

/** An attribute value quoted for a selector (jsdom has no CSS.escape). Ids such
 *  as "canvas-page-size-16:9" carry a colon, which is fine inside quotes. */
function attr(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** The element with `data-testid=id` (anywhere in the document by default), or a throw naming it. */
export function byTestId<T extends HTMLElement = HTMLButtonElement>(id: string, scope: ParentNode = document): T {
  const el = scope.querySelector<T>(`[data-testid="${attr(id)}"]`);
  if (!el) throw new Error(`no element with data-testid="${id}"`);
  return el;
}

/** The element with `data-testid=id`, or null. */
export function maybeTestId<T extends HTMLElement = HTMLButtonElement>(id: string, scope: ParentNode = document): T | null {
  return scope.querySelector<T>(`[data-testid="${attr(id)}"]`);
}

/** Every data-testid under `scope` that starts with `prefix`, in document order. */
export function testIdsWithPrefix(prefix: string, scope: ParentNode = document): string[] {
  return [...scope.querySelectorAll<HTMLElement>("[data-testid]")]
    .map((e) => e.getAttribute("data-testid") ?? "")
    .filter((id) => id.startsWith(prefix));
}

/** A primary click, as a pointer makes it (detail 1). */
export function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
  });
}

/** Let promises and a macrotask settle inside act. */
export async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

const markupCache = new Map<string, string>();

/** The inner markup of `key`'s drawing, rendered on its own. */
export function iconInnerMarkup(key: RibbonIconKey): string {
  const hit = markupCache.get(key);
  if (hit !== undefined) return hit;
  const host = document.createElement("div");
  const root = createRoot(host);
  const Icon = RibbonIcon[key] as React.ComponentType<{ size?: number }>;
  act(() => root.render(<Icon size={20} />));
  const svg = host.querySelector("svg");
  const inner = svg ? svg.innerHTML : "";
  act(() => root.unmount());
  markupCache.set(key, inner);
  return inner;
}

/** Whether `el` draws the picture of `key` (some svg inside it has that drawing). */
export function drawsIcon(el: Element, key: RibbonIconKey): boolean {
  const want = iconInnerMarkup(key);
  if (want === "") return false;
  return [...el.querySelectorAll("svg")].some((svg) => svg.innerHTML === want);
}

/** The visible label words of a menu row (its data-menu-label span). */
export function rowLabel(row: Element): string {
  return row.querySelector("[data-menu-label]")?.textContent ?? row.textContent ?? "";
}
