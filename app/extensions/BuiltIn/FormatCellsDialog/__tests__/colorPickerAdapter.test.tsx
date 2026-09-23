//! FILENAME: app/extensions/BuiltIn/FormatCellsDialog/__tests__/colorPickerAdapter.test.tsx
// PURPOSE: The Format Cells ColorPicker is a thin adapter over the ONE @api
//          colour picker (ColorSwatch -> ColorPopover), with the old props and
//          the old contract: theme picks go to onThemeColorChange when given
//          and fall back to onChange(resolved hex); selection is by slot+tint
//          for theme colours and by hex for standard ones.
// CONTEXT: Also pins the one rule the adapter adds. The popover portals to
//          <body> but React bubbles its keys through the component tree into
//          the dialog's onKeyDown (Escape = Cancel, Enter = OK), so Escape and
//          Enter that start INSIDE the popover must stop at the picker — or
//          closing the palette would discard the whole dialog.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const { paletteMock } = vi.hoisted(() => ({ paletteMock: vi.fn() }));
vi.mock("@api/theme", () => ({ getThemeColorPalette: paletteMock }));

import {
  SurfaceLayoutProvider,
  bandLayout,
  panelLayout,
  findHardcodedColours,
  STANDARD_COLORS,
  type SurfaceLayout,
} from "@api/layout";
import { ColorPicker } from "../components/ColorPicker";

// ============================================================================
// Fixtures + harness
// ============================================================================

const SLOTS = ["bg1", "tx1", "bg2", "tx2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6"];
const BASE_HEX = ["#ffffff", "#000000", "#e7e6e6", "#44546a", "#4472c4", "#ed7d31", "#a5a5a5", "#ffc000", "#5b9bd5", "#70ad47"];
const THEME_PALETTE = [
  ...SLOTS.map((slot, i) => ({ slot, tint: 0, resolvedColor: BASE_HEX[i], label: `Theme ${slot}` })),
  ...SLOTS.map((slot) => ({ slot, tint: 400, resolvedColor: "#cccccc", label: `Theme ${slot}, lighter 40%` })),
];

const LAYOUTS: Array<[string, SurfaceLayout]> = [
  ["band", bandLayout()],
  ["panel", panelLayout(300)],
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  paletteMock.mockReset();
  paletteMock.mockResolvedValue(THEME_PALETTE);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

function render(node: React.ReactNode, layout: SurfaceLayout = panelLayout(300)): void {
  act(() => {
    root.render(<SurfaceLayoutProvider value={layout}>{node}</SurfaceLayoutProvider>);
  });
}

/** Flush the palette promise and the deferred focus-on-open. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

function key(el: Element, k: string): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
  act(() => {
    el.dispatchEvent(ev);
  });
  return ev;
}

function trigger(): HTMLButtonElement {
  const btn = container.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]');
  if (!btn) throw new Error("no swatch button");
  return btn;
}

function popover(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>("[data-section-flyout]");
}

function swatch(name: string): HTMLButtonElement {
  const el = popover()?.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
  if (!el) throw new Error(`no swatch "${name}"`);
  return el;
}

// ============================================================================
// Tests
// ============================================================================

describe("Format Cells ColorPicker (adapter over @api ColorSwatch/ColorPopover)", () => {
  it.each(LAYOUTS)("paints only with tokens in the %s layout, trigger and open popover", async (_n, layout) => {
    render(<ColorPicker value="#ff0000" onChange={() => {}} label="Color:" />, layout);
    expect(findHardcodedColours(container)).toEqual([]);
    await click(trigger());
    await settle();
    const pop = popover();
    expect(pop).not.toBeNull();
    expect(findHardcodedColours(pop!)).toEqual([]);
  });

  it("keeps the visible label and names the swatch without the colon", () => {
    render(<ColorPicker value="#112233" onChange={() => {}} label="Pattern:" />);
    expect(container.textContent).toContain("Pattern:");
    expect(trigger().getAttribute("aria-label")).toBe("Pattern");
    // No hand-rolled chrome is left: no styled-components grid, no glyph arrow.
    expect(container.textContent).not.toMatch(/[▲▼]/);
    expect(container.querySelector("select")).toBeNull();
  });

  it("shows the theme grid and the standard colours in the ONE popover", async () => {
    render(<ColorPicker value="#000000" onChange={() => {}} />);
    await click(trigger());
    await settle();
    expect(paletteMock).toHaveBeenCalled();
    const swatches = popover()!.querySelectorAll("[data-colour-swatch]");
    expect(swatches.length).toBe(THEME_PALETTE.length + STANDARD_COLORS.length);
    // Every swatch is data, so the chrome scan above may ignore it.
    for (const s of Array.from(swatches)) expect(s.hasAttribute("data-colour-data")).toBe(true);
  });

  it("a theme pick falls back to onChange(resolved hex) when no theme handler is given", async () => {
    const onChange = vi.fn();
    render(<ColorPicker value="#000000" onChange={onChange} />);
    await click(trigger());
    await settle();
    await click(swatch("Theme accent1"));
    expect(onChange).toHaveBeenCalledWith("#4472c4");
    expect(popover()).toBeNull();
  });

  it("a theme pick goes to onThemeColorChange(slot, tint, hex) when given", async () => {
    const onChange = vi.fn();
    const onTheme = vi.fn();
    render(<ColorPicker value="#000000" onChange={onChange} onThemeColorChange={onTheme} />);
    await click(trigger());
    await settle();
    await click(swatch("Theme accent2, lighter 40%"));
    expect(onTheme).toHaveBeenCalledWith("accent2", 400, "#cccccc");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("a standard pick calls onChange with the hex", async () => {
    const onChange = vi.fn();
    render(<ColorPicker value="#000000" onChange={onChange} />);
    await click(trigger());
    await settle();
    const std = popover()!.querySelectorAll<HTMLButtonElement>("[data-colour-swatch]")[THEME_PALETTE.length];
    await click(std);
    expect(onChange).toHaveBeenCalledWith(STANDARD_COLORS[0]);
  });

  it("marks the theme swatch by slot+tint, and a standard swatch by hex only without a slot", async () => {
    render(<ColorPicker value="#cccccc" themeSlot="accent3" themeTint={400} onChange={() => {}} />);
    await click(trigger());
    await settle();
    expect(swatch("Theme accent3, lighter 40%").getAttribute("aria-pressed")).toBe("true");
    expect(swatch("Theme accent4, lighter 40%").getAttribute("aria-pressed")).toBe("false");
  });

  describe("keys that start inside the popover stop at the picker", () => {
    function renderInDialog(onDialogKey: (k: string) => void): void {
      render(
        <div onKeyDown={(e) => onDialogKey(e.key)}>
          <ColorPicker value="#000000" onChange={() => {}} label="Color:" />
        </div>,
      );
    }

    it("Escape closes the popover, returns focus to the swatch, and never reaches the dialog", async () => {
      const dialogKey = vi.fn();
      renderInDialog(dialogKey);
      await click(trigger());
      await settle();
      const first = popover()!.querySelector<HTMLButtonElement>("[data-colour-swatch]")!;
      first.focus();
      key(first, "Escape");
      expect(dialogKey).not.toHaveBeenCalled();
      expect(popover()).toBeNull();
      expect(document.activeElement).toBe(trigger());
      expect(trigger().getAttribute("aria-expanded")).toBe("false");
    });

    it("Enter in the popover never reaches the dialog", async () => {
      const dialogKey = vi.fn();
      renderInDialog(dialogKey);
      await click(trigger());
      await settle();
      const hex = popover()!.querySelector<HTMLInputElement>('input[aria-label="Hex colour"]')!;
      key(hex, "Enter");
      expect(dialogKey).not.toHaveBeenCalled();
    });

    it("other keys in the popover, and every key on the swatch button, still reach the dialog", async () => {
      const dialogKey = vi.fn();
      renderInDialog(dialogKey);
      key(trigger(), "Enter");
      expect(dialogKey).toHaveBeenCalledWith("Enter");
      await click(trigger());
      await settle();
      const first = popover()!.querySelector<HTMLButtonElement>("[data-colour-swatch]")!;
      key(first, "ArrowRight");
      expect(dialogKey).toHaveBeenCalledWith("ArrowRight");
    });
  });
});
