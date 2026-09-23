//! FILENAME: app/src/shell/Toast/__tests__/toastChrome.test.tsx
// PURPOSE: Toast chrome after the Calcula Clusters redesign — each variant is a
//          semantic tone (--tone-<t>-bg / --tone-<t>-fg) with its duotone status
//          icon, and nothing the toast renders is a hardcoded colour.
// CONTEXT: The four variants used to be fixed light tints (#f0f4ff, #fff0f0 ...)
//          with literal #333 text and unicode glyph icons (circled i, check,
//          warning sign, ballot x), so a toast was a bright box in the Dark
//          skin. The click-through contract is pinned separately in
//          toastClickThrough.test.tsx and is re-checked here only as far as the
//          E2E fixture depends on it: `[data-toast] button` dismisses.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ToastContainer } from "../Toast";
import { useToastStore, type ToastItem } from "../useToastStore";
import { findHardcodedColours } from "../../../api/layout";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let container: HTMLDivElement;
let root: Root;

const VARIANTS: ToastItem["variant"][] = ["info", "success", "warning", "error"];

/** The tone token each variant must paint its icon with. */
const TONE_OF: Record<ToastItem["variant"], string> = {
  info: "--tone-info-fg",
  success: "--tone-ok-fg",
  warning: "--tone-warn-fg",
  error: "--tone-danger-fg",
};

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
  useToastStore.setState({ toasts: [] });
});

function renderAll(): void {
  useToastStore.setState({
    toasts: VARIANTS.map((variant, i) => ({ id: `t${i}`, message: `${variant} message`, variant, duration: 0 })),
  });
  act(() => {
    root.render(<ToastContainer />);
  });
}

describe("toast chrome", () => {
  it("renders every variant with an svg status icon painted in its tone", () => {
    renderAll();
    const toasts = Array.from(container.querySelectorAll<HTMLElement>("[data-toast]"));
    expect(toasts.map((t) => t.getAttribute("data-toast-variant"))).toEqual(VARIANTS);
    for (const toast of toasts) {
      const variant = toast.getAttribute("data-toast-variant") as ToastItem["variant"];
      const icon = toast.querySelector("svg");
      expect(icon, `${variant} toast has no drawn icon`).not.toBeNull();
      const slot = icon!.parentElement as HTMLElement;
      expect(slot.style.color).toContain(TONE_OF[variant]);
    }
  });

  it("uses no unicode glyph icons", () => {
    renderAll();
    for (const glyph of ["ⓘ", "✓", "⚠", "✗"]) {
      expect(container.textContent).not.toContain(glyph);
    }
  });

  it("keeps an OK button inside each [data-toast] (the E2E fixture clicks them)", () => {
    renderAll();
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("[data-toast] button"));
    expect(buttons.map((b) => b.textContent)).toEqual(["OK", "OK", "OK", "OK"]);
    act(() => buttons[0].click());
    expect(useToastStore.getState().toasts.map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
  });

  it("paints no hardcoded colour in any variant", () => {
    renderAll();
    expect(container.querySelectorAll("[data-toast]").length).toBe(4);
    expect(findHardcodedColours(container)).toEqual([]);
  });
});
