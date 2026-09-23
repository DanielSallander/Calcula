//! FILENAME: app/src/api/layout/__tests__/formControlsKit.tsx
// PURPOSE: The shared harness of the form-control tests (toggles, chip,
//          slider, fields): mount under a surface geometry, drive a controlled
//          input the way a user does, read declared CSS, and scan for colours.
// CONTEXT: Not a test file itself (no `.test.` in the name, so vitest does not
//          collect it). It exists so four suites do not each carry their own
//          copy of the colour-scan workaround below, which is exactly the kind
//          of second copy that drifts.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SurfaceLayoutProvider, bandLayout, panelLayout, popoverLayout, type SurfaceLayout } from "../context";
import { findHardcodedColours } from "../testing";

/** The surfaces every control is proven under. */
export const LAYOUTS: Array<[string, SurfaceLayout]> = [
  ["band", bandLayout()],
  ["panel", panelLayout(300)],
  ["popover", popoverLayout(300)],
];

/** A mounted React root inside a fresh container in document.body. */
export interface Mount {
  container: HTMLDivElement;
  render(node: React.ReactNode, layout?: SurfaceLayout): void;
  unmount(): void;
}

export function mount(): Mount {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  return {
    container,
    render(node, layout = panelLayout(300)) {
      act(() => {
        root.render(<SurfaceLayoutProvider value={layout}>{node}</SurfaceLayoutProvider>);
      });
    },
    unmount() {
      act(() => root.unmount());
      document.body.innerHTML = "";
    },
  };
}

/** Query inside `root` or throw with the selector in the message. */
export function q<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
  const el = root.querySelector(selector);
  if (!el) throw new Error(`no element for ${selector}`);
  return el as T;
}

export function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

/** React derives onMouseEnter from a bubbling mouseover (from outside). */
export function hover(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null }));
  });
}

/** Dispatch a plain event of `type` (pointer/key events React listens for by
 *  name; jsdom's PointerEvent support is not needed to reach the handler). */
export function fire(el: Element, type: string, init: Record<string, unknown> = {}): void {
  act(() => {
    const event =
      type.startsWith("key")
        ? new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })
        : new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
    el.dispatchEvent(event);
  });
}

/**
 * Set a controlled input's value the way typing does. React tracks the last
 * value it wrote; assigning through the element would update that tracker and
 * React would see "no change". The prototype setter bypasses it, so the
 * following `input` event reaches onChange.
 */
export function typeValue(el: HTMLInputElement | HTMLSelectElement, value: string): void {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

/** Move focus off `el` exactly once (React's onBlur listens for focusout;
 *  jsdom fires it from blur() only when `el` actually had focus). */
export function blur(el: HTMLElement): void {
  act(() => {
    if (document.activeElement === el) el.blur();
    else el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
}

/**
 * findHardcodedColours with its one known false positive neutralised. The
 * colour-name alternation in testing.ts is `\b(?:white|...)\b`, and `\b`
 * matches between "white" and "-", so every `white-space: nowrap` reports
 * "-> white". Filtering those findings out afterwards is NOT safe: the helper
 * reports only the FIRST hit per rule, so a real literal after a white-space
 * declaration in the same rule would be dropped with it. So the white-space
 * declarations are removed from the stylesheet text AND from inline style
 * attributes for the duration of the scan, and every real colour stays
 * visible. Once testing.ts is fixed this is a harmless no-op.
 */
export function hardcodedColours(root: Element): string[] {
  const strip = (text: string) => text.replace(/white-space\s*:\s*[a-z-]+\s*;?/gi, "");
  const tags = Array.from(document.querySelectorAll("style"));
  const savedTags = tags.map((tag) => tag.textContent);
  const styled = Array.from(root.querySelectorAll("[style]"));
  if (root.hasAttribute("style")) styled.push(root);
  const savedStyles = styled.map((el) => el.getAttribute("style"));
  try {
    for (const tag of tags) tag.textContent = strip(tag.textContent ?? "");
    for (const el of styled) el.setAttribute("style", strip(el.getAttribute("style") ?? ""));
    return findHardcodedColours(root);
  } finally {
    tags.forEach((tag, i) => {
      tag.textContent = savedTags[i];
    });
    styled.forEach((el, i) => {
      const s = savedStyles[i];
      if (s === null) el.removeAttribute("style");
      else el.setAttribute("style", s);
    });
  }
}

/**
 * The value `el` is DECLARED to have for `prop` by the stylesheet rules that
 * match it (last match wins). jsdom's getComputedStyle drops shorthands
 * written with var() (`background: var(--x, ...)` reads as the initial
 * transparent), so the token a rule paints with is read from the rule text.
 * Rules whose selector jsdom cannot match (pseudo-elements) are skipped.
 */
export function declared(el: Element, prop: string): string {
  let value = "";
  const decl = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`);
  for (const style of Array.from(document.querySelectorAll("style"))) {
    const text = style.textContent ?? "";
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      let matches = false;
      try {
        matches = el.matches(m[1].trim());
      } catch {
        matches = false;
      }
      if (!matches) continue;
      const hit = decl.exec(m[2]);
      if (hit) value = hit[1].trim();
    }
  }
  return value;
}

/** Every stylesheet rule body whose selector mentions one of `el`'s classes
 *  and contains `fragment` in the selector (e.g. "::after", ":checked"). */
export function ruleBodies(el: Element, fragment: string): string[] {
  const classes = Array.from(el.classList);
  const out: string[] = [];
  for (const style of Array.from(document.querySelectorAll("style"))) {
    const text = style.textContent ?? "";
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const selector = m[1];
      if (!selector.includes(fragment)) continue;
      if (classes.some((c) => selector.includes(`.${c}`))) out.push(m[2]);
    }
  }
  return out;
}
