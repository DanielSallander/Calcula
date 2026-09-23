//! FILENAME: app/src/shell/Overlays/MiniFormatToolbar/__tests__/MiniFormatToolbar.test.tsx
// PURPOSE: The mini format toolbar as the Calcula Clusters floating pill: the
//          @api/layout control grammar (Segmented pills, 28px IconButtons,
//          ColorSwatch bars + the shared ColorPopover, the shared Select), the
//          same formatting behaviour as before, and no hardcoded chrome colour.
// CONTEXT: The toolbar sits one layer above the grid context menu and stops
//          mousedown at its root so a press on it never reads as an outside
//          click to the menu. That stop also hides presses from an open colour
//          palette's own dismissal, so the toolbar closes palettes itself — the
//          cases below pin both halves.
//
//          LAYERS. The palettes and tooltips are portalled to <body>, where the
//          @api defaults (1100 / 1200) would put them BEHIND the context menu
//          at --z-context-menu (10000). The toolbar hands every overlay a
//          numeric layer through the primitives' own props; the layer cases
//          read those inline z-indexes and pin the constant against both
//          built-in themes, so a theme that raises the menu fails here.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const { getCellMock, getStyleMock, applyMock, emitMock, paletteMock } = vi.hoisted(() => ({
  getCellMock: vi.fn(),
  getStyleMock: vi.fn(),
  applyMock: vi.fn(),
  emitMock: vi.fn(),
  paletteMock: vi.fn(),
}));

vi.mock("../../../../api/lib", () => ({
  getCell: getCellMock,
  getStyle: getStyleMock,
  applyFormatting: applyMock,
}));

vi.mock("../../../../api", () => ({ cellEvents: { emit: emitMock } }));

// The quick palette never asks for the document theme; mocked so a regression
// that turns the theme grid on fails loudly instead of reaching for Tauri.
vi.mock("../../../../api/theme", () => ({ getThemeColorPalette: paletteMock }));

import { MiniFormatToolbar } from "../MiniFormatToolbar";
import {
  CONTEXT_MENU_LAYER,
  MINI_TOOLBAR_LAYER,
  MINI_TOOLBAR_TOOLTIP_LAYER,
} from "../MiniFormatToolbar.styles";
import { THEME_TOKENS } from "../../../../core/theme/tokens";
import { defaultTheme } from "../../../../core/theme/defaultTheme";
import { darkTheme } from "../../../../core/theme/darkTheme";
import {
  QUICK_COLORS,
  SurfaceLayoutProvider,
  bandLayout,
  findHardcodedColours,
  panelLayout,
  type SurfaceLayout,
} from "../../../../api/layout";
import type { GridMenuContext } from "../../../../api/extensions";

// ============================================================================
// Harness
// ============================================================================

let container: HTMLDivElement;
let root: Root;

function menuContext(overrides: Partial<GridMenuContext> = {}): GridMenuContext {
  return {
    selection: { startRow: 1, startCol: 2, endRow: 2, endCol: 3, type: "cells" },
    clickedCell: { row: 1, col: 2 },
    isWithinSelection: true,
    sheetIndex: 0,
    sheetName: "Sheet1",
    ...overrides,
  } as unknown as GridMenuContext;
}

async function render(
  context: GridMenuContext = menuContext(),
  layout?: SurfaceLayout,
): Promise<void> {
  const node = <MiniFormatToolbar position={{ x: 200, y: 300 }} context={context} onClose={() => {}} />;
  await act(async () => {
    root.render(layout ? <SurfaceLayoutProvider value={layout}>{node}</SurfaceLayoutProvider> : node);
  });
  // Let the style load resolve.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function toolbar(): HTMLElement {
  const el = container.querySelector<HTMLElement>('[data-testid="mini-format-toolbar"]');
  if (!el) throw new Error("toolbar not rendered");
  return el;
}

function byTestId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.querySelector<T>(`[data-testid="${id}"]`);
  if (!el) throw new Error(`no element [data-testid="${id}"]`);
  return el;
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

async function selectValue(el: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function colourPopover(slot: "text" | "fill"): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="mini-format-${slot}-color-popover"]`);
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  getCellMock.mockReset();
  getStyleMock.mockReset();
  applyMock.mockReset();
  emitMock.mockReset();
  paletteMock.mockReset();
  paletteMock.mockResolvedValue([]);
  getCellMock.mockResolvedValue({ row: 1, col: 2, styleIndex: 7, display: "" });
  getStyleMock.mockResolvedValue({
    fontFamily: "Calibri",
    fontSize: 11,
    bold: true,
    italic: false,
    underline: "none",
    strikethrough: false,
    textColor: "#000000",
    backgroundColor: "#ffffff",
    textAlign: "center",
  });
  applyMock.mockResolvedValue({ cells: [{ row: 1, col: 2, display: "x", formula: null }] });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

// ============================================================================
// Structure
// ============================================================================

describe("MiniFormatToolbar — the floating pill", () => {
  it("is a named toolbar", async () => {
    await render();
    const bar = toolbar();
    expect(bar.getAttribute("role")).toBe("toolbar");
    expect(bar.getAttribute("aria-label")).toBe("Format");
  });

  it("groups its toggles into Segmented pills", async () => {
    await render();
    const groups = Array.from(toolbar().querySelectorAll('[role="group"]')).map((g) =>
      g.getAttribute("aria-label"),
    );
    expect(groups).toEqual(["Font size steps", "Emphasis", "Horizontal alignment", "Number format"]);
    const emphasis = toolbar().querySelector('[role="group"][aria-label="Emphasis"]')!;
    expect(Array.from(emphasis.children).map((b) => b.getAttribute("aria-label"))).toEqual([
      "Bold",
      "Italic",
      "Underline",
      "Strikethrough",
    ]);
  });

  it("keeps B / I / U / S typographic and draws every other button with an icon", async () => {
    await render();
    expect(byTestId("mini-format-bold").textContent).toBe("B");
    expect(byTestId("mini-format-italic").textContent).toBe("I");
    expect(byTestId("mini-format-underline").textContent).toBe("U");
    expect(byTestId("mini-format-strikethrough").textContent).toBe("S");
    for (const id of [
      "grow",
      "shrink",
      "align-left",
      "align-center",
      "align-right",
      "percent",
      "comma",
      "decimal-increase",
      "decimal-decrease",
    ]) {
      const button = byTestId(`mini-format-${id}`);
      expect(button.tagName).toBe("BUTTON");
      expect(button.querySelector("svg"), id).not.toBeNull();
      // No unicode/emoji glyph stands in for an icon.
      expect(button.textContent, id).toBe("");
    }
  });

  it("renders 28px icon buttons (the standard control row)", async () => {
    await render();
    const bold = byTestId("mini-format-bold");
    expect(bold.style.height).toBe("28px");
    expect(bold.style.width).toBe("28px");
  });

  it("uses the shared Select for font and size, showing the loaded values", async () => {
    await render();
    const font = byTestId<HTMLSelectElement>("mini-format-font");
    const size = byTestId<HTMLSelectElement>("mini-format-size");
    expect(font.tagName).toBe("SELECT");
    expect(font.getAttribute("aria-label")).toBe("Font");
    expect(font.value).toBe("Calibri");
    expect(size.value).toBe("11");
    // The @api Select wraps the native element with its chevron.
    expect(font.parentElement?.tagName).toBe("SPAN");
    expect(font.parentElement?.querySelector("svg")).not.toBeNull();
  });

  it("shows a font the list does not know instead of the first option", async () => {
    getStyleMock.mockResolvedValue({ fontFamily: "Aptos", fontSize: 10.5 });
    await render();
    expect(byTestId<HTMLSelectElement>("mini-format-font").value).toBe("Aptos");
    expect(byTestId<HTMLSelectElement>("mini-format-size").value).toBe("10.5");
  });

  it("reflects the loaded style as pressed state", async () => {
    await render();
    expect(byTestId("mini-format-bold").getAttribute("aria-pressed")).toBe("true");
    expect(byTestId("mini-format-italic").getAttribute("aria-pressed")).toBe("false");
    expect(byTestId("mini-format-align-center").getAttribute("aria-pressed")).toBe("true");
    expect(byTestId("mini-format-align-left").getAttribute("aria-pressed")).toBe("false");
    // Actions are not toggles.
    expect(byTestId("mini-format-percent").hasAttribute("aria-pressed")).toBe(false);
  });

  it("disables every control when there is no selection", async () => {
    await render(menuContext({ selection: null } as Partial<GridMenuContext>));
    const controls = toolbar().querySelectorAll<HTMLButtonElement | HTMLSelectElement>("button, select");
    expect(controls.length).toBeGreaterThan(10);
    for (const c of Array.from(controls)) expect(c.disabled, c.getAttribute("aria-label") ?? "").toBe(true);
  });
});

// ============================================================================
// Behaviour
// ============================================================================

describe("MiniFormatToolbar — formatting", () => {
  it("toggles bold over the whole selection and refreshes the grid", async () => {
    const refresh = vi.fn();
    window.addEventListener("grid:refresh", refresh);
    await render();
    await click(byTestId("mini-format-bold"));
    expect(applyMock).toHaveBeenCalledWith([1, 2], [2, 3], { bold: false });
    expect(emitMock).toHaveBeenCalledWith(expect.objectContaining({ row: 1, col: 2, newValue: "x" }));
    expect(refresh).toHaveBeenCalled();
    expect(byTestId("mini-format-bold").getAttribute("aria-pressed")).toBe("false");
    window.removeEventListener("grid:refresh", refresh);
  });

  it("applies font family and size from the selects", async () => {
    await render();
    await selectValue(byTestId<HTMLSelectElement>("mini-format-font"), "Verdana");
    expect(applyMock).toHaveBeenLastCalledWith([1, 2], [2, 3], { fontFamily: "Verdana" });
    await selectValue(byTestId<HTMLSelectElement>("mini-format-size"), "14");
    expect(applyMock).toHaveBeenLastCalledWith([1, 2], [2, 3], { fontSize: 14 });
  });

  it("steps the font size through the size list", async () => {
    await render();
    await click(byTestId("mini-format-grow"));
    expect(applyMock).toHaveBeenLastCalledWith([1, 2], [2, 3], { fontSize: 12 });
    await click(byTestId("mini-format-shrink"));
    expect(applyMock).toHaveBeenLastCalledWith([1, 2], [2, 3], { fontSize: 11 });
  });

  it("applies alignment and the number-format shortcuts", async () => {
    await render();
    await click(byTestId("mini-format-align-right"));
    expect(applyMock).toHaveBeenLastCalledWith([1, 2], [2, 3], { textAlign: "right" });
    expect(byTestId("mini-format-align-right").getAttribute("aria-pressed")).toBe("true");
    await click(byTestId("mini-format-percent"));
    expect(applyMock).toHaveBeenLastCalledWith([1, 2], [2, 3], { numberFormat: "0%" });
    await click(byTestId("mini-format-comma"));
    expect(applyMock).toHaveBeenLastCalledWith([1, 2], [2, 3], { numberFormat: "#,##0.00" });
    await click(byTestId("mini-format-decimal-increase"));
    expect(applyMock).toHaveBeenLastCalledWith([1, 2], [2, 3], { numberFormat: "#,##0.000" });
    await click(byTestId("mini-format-decimal-decrease"));
    expect(applyMock).toHaveBeenLastCalledWith([1, 2], [2, 3], { numberFormat: "#,##0" });
  });

  it("keeps presses on the toolbar away from the context menu's outside-click listener", async () => {
    const outside = vi.fn();
    document.addEventListener("mousedown", outside);
    await render();
    await click(byTestId("mini-format-italic"));
    expect(outside).not.toHaveBeenCalled();
    document.removeEventListener("mousedown", outside);
  });
});

// ============================================================================
// Colour
// ============================================================================

describe("MiniFormatToolbar — colours", () => {
  it("shows the current colours as data bars under the colour icons", async () => {
    await render();
    const font = byTestId("mini-format-text-color");
    expect(font.getAttribute("aria-label")).toBe("Font colour");
    const bar = font.querySelector<HTMLElement>("[data-colour-data]");
    expect(bar).not.toBeNull();
    expect(bar!.style.background).toBe("rgb(0, 0, 0)");
    expect(byTestId("mini-format-fill-color").querySelector("svg")).not.toBeNull();
  });

  it("opens the shared palette with the quick colours and applies a pick", async () => {
    await render();
    await click(byTestId("mini-format-text-color"));
    const body = colourPopover("text");
    expect(body).not.toBeNull();
    const swatches = body!.querySelectorAll("[data-colour-swatch]");
    expect(swatches.length).toBe(QUICK_COLORS.length);
    // Quick set only: the document theme is never asked for.
    expect(paletteMock).not.toHaveBeenCalled();
    expect(body!.closest("[data-section-flyout]")?.getAttribute("aria-label")).toBe("Font colour");

    await click(body!.querySelector('[aria-label="Red"]')!);
    expect(applyMock).toHaveBeenLastCalledWith([1, 2], [2, 3], { textColor: "#ff0000" });
    expect(colourPopover("text")).toBeNull();
  });

  it("applies a fill colour", async () => {
    await render();
    await click(byTestId("mini-format-fill-color"));
    await click(colourPopover("fill")!.querySelector('[aria-label="Yellow"]')!);
    expect(applyMock).toHaveBeenLastCalledWith([1, 2], [2, 3], { backgroundColor: "#ffff00" });
  });

  it("opening one colour palette closes the other", async () => {
    await render();
    await click(byTestId("mini-format-text-color"));
    expect(colourPopover("text")).not.toBeNull();
    await click(byTestId("mini-format-fill-color"));
    expect(colourPopover("text")).toBeNull();
    expect(colourPopover("fill")).not.toBeNull();
    expect(byTestId("mini-format-text-color").getAttribute("aria-expanded")).toBe("false");
    expect(byTestId("mini-format-fill-color").getAttribute("aria-expanded")).toBe("true");
  });

  it("opening Fill closes Font colour WITHOUT remounting either swatch", async () => {
    await render();
    const textTrigger = byTestId("mini-format-text-color");
    const fillTrigger = byTestId("mini-format-fill-color");

    await click(textTrigger);
    expect(colourPopover("text")).not.toBeNull();
    await click(fillTrigger);
    expect(colourPopover("text")).toBeNull();
    expect(colourPopover("fill")).not.toBeNull();
    // The very same DOM nodes: the palette was closed through the controlled
    // open state, not by throwing its swatch away and building a new one.
    expect(byTestId("mini-format-text-color")).toBe(textTrigger);
    expect(byTestId("mini-format-fill-color")).toBe(fillTrigger);
    expect(textTrigger.isConnected).toBe(true);

    // And back the other way.
    await click(textTrigger);
    expect(colourPopover("fill")).toBeNull();
    expect(colourPopover("text")).not.toBeNull();
    expect(byTestId("mini-format-fill-color")).toBe(fillTrigger);
  });

  it("one palette at a time even without a press (a keyboard Enter is a bare click)", async () => {
    await render();
    await click(byTestId("mini-format-text-color"));
    expect(colourPopover("text")).not.toBeNull();
    // No mousedown, so the toolbar's press handler never runs: the other
    // palette closes because there is only ONE open-palette state.
    await act(async () => {
      byTestId("mini-format-fill-color").dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });
    expect(colourPopover("text")).toBeNull();
    expect(colourPopover("fill")).not.toBeNull();
  });

  it("a press on another toolbar control closes an open palette", async () => {
    await render();
    await click(byTestId("mini-format-text-color"));
    expect(colourPopover("text")).not.toBeNull();
    await click(byTestId("mini-format-underline"));
    expect(colourPopover("text")).toBeNull();
    expect(applyMock).toHaveBeenLastCalledWith([1, 2], [2, 3], { underline: "single" });
  });

  it("a press inside the open palette keeps it open and the context menu too", async () => {
    const outside = vi.fn();
    document.addEventListener("mousedown", outside);
    await render();
    await click(byTestId("mini-format-text-color"));
    const hex = colourPopover("text")!.querySelector<HTMLInputElement>('input[aria-label="Hex colour"]')!;
    await act(async () => {
      hex.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    });
    expect(colourPopover("text")).not.toBeNull();
    expect(outside).not.toHaveBeenCalled();
    document.removeEventListener("mousedown", outside);
  });

  it("clicking the trigger again closes its palette", async () => {
    await render();
    const trigger = byTestId("mini-format-text-color");
    await click(trigger);
    expect(colourPopover("text")).not.toBeNull();
    await click(byTestId("mini-format-text-color"));
    expect(colourPopover("text")).toBeNull();
  });
});

// ============================================================================
// Tooltips
// ============================================================================

describe("MiniFormatToolbar — tooltips", () => {
  function hover(el: Element): void {
    act(() => {
      el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null }));
    });
  }

  it("names the control and carries its shortcut chip", async () => {
    await render();
    vi.useFakeTimers();
    hover(byTestId("mini-format-bold"));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    const tips = document.querySelectorAll('[role="tooltip"]');
    expect(tips.length).toBe(1);
    expect(tips[0].textContent).toContain("Bold");
    expect(tips[0].querySelector("kbd")?.textContent).toBe("Ctrl+B");
    // A tooltip is never ribbon content.
    expect(tips[0].hasAttribute("data-ribbon-content")).toBe(false);
  });

  it("shows one tooltip for a colour trigger, not two", async () => {
    await render();
    vi.useFakeTimers();
    hover(byTestId("mini-format-fill-color"));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    const tips = document.querySelectorAll('[role="tooltip"]');
    expect(tips.length).toBe(1);
    expect(tips[0].textContent).toBe("Fill colour");
  });

  it("names the font pickers too, one tooltip each", async () => {
    await render();
    vi.useFakeTimers();
    hover(byTestId("mini-format-size"));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    const tips = document.querySelectorAll('[role="tooltip"]');
    expect(tips.length).toBe(1);
    expect(tips[0].textContent).toBe("Font size");
    // Attached to the <select> itself (the Tooltip clones, it never wraps).
    expect(byTestId("mini-format-size").getAttribute("aria-describedby")).toBe(tips[0].id);
  });

  it("opens every tooltip ABOVE the pill, away from the context menu below it", async () => {
    await render();
    const rect = {
      left: 100,
      right: 128,
      top: 300,
      bottom: 328,
      width: 28,
      height: 28,
      x: 100,
      y: 300,
      toJSON: () => ({}),
    } as DOMRect;
    const ids = ["mini-format-bold", "mini-format-align-left", "mini-format-fill-color", "mini-format-font"];
    for (const id of ids) vi.spyOn(byTestId(id), "getBoundingClientRect").mockReturnValue(rect);

    vi.useFakeTimers();
    for (const id of ids) {
      const el = byTestId(id);
      hover(el);
      act(() => {
        vi.advanceTimersByTime(500);
      });
      const tip = document.querySelector<HTMLElement>('[role="tooltip"]');
      expect(tip, id).not.toBeNull();
      // Placement "bottom" would put it at 328 + gap; "top" puts it above 300.
      expect(parseFloat(tip!.style.top), id).toBeLessThan(rect.top);
      act(() => {
        el.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: null }));
      });
      expect(document.querySelector('[role="tooltip"]'), `${id} closed`).toBeNull();
    }
  });
});

// ============================================================================
// Layers
// ============================================================================

describe("MiniFormatToolbar — layers above the context menu", () => {
  function hoverFor(el: Element, ms = 500): HTMLElement | null {
    act(() => {
      el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null }));
    });
    act(() => {
      vi.advanceTimersByTime(ms);
    });
    return document.querySelector<HTMLElement>('[role="tooltip"]');
  }

  it("derives its layers from the context menu's, which both built-in themes pin", () => {
    for (const theme of [defaultTheme, darkTheme]) {
      expect(Number(theme[THEME_TOKENS.CTX_MENU_Z_INDEX])).toBe(CONTEXT_MENU_LAYER);
    }
    // The pill is the menu + 1; the palettes sit above the pill, and every
    // tooltip above a palette AND above the palette's own swatch tooltips.
    expect(MINI_TOOLBAR_LAYER).toBeGreaterThan(CONTEXT_MENU_LAYER + 1);
    expect(MINI_TOOLBAR_TOOLTIP_LAYER).toBeGreaterThan(MINI_TOOLBAR_LAYER + 1);
  });

  it("opens a colour palette with an inline z-index above the context menu and the pill", async () => {
    await render();
    for (const slot of ["text", "fill"] as const) {
      await click(byTestId(`mini-format-${slot}-color`));
      const flyout = colourPopover(slot)!.closest<HTMLElement>("[data-section-flyout]")!;
      const z = Number(flyout.style.zIndex);
      expect(z, slot).toBe(MINI_TOOLBAR_LAYER);
      expect(z, slot).toBeGreaterThan(CONTEXT_MENU_LAYER + 1);
    }
  });

  it("draws the toolbar's tooltips above the context menu", async () => {
    await render();
    vi.useFakeTimers();
    for (const id of ["mini-format-bold", "mini-format-font", "mini-format-text-color"]) {
      const tip = hoverFor(byTestId(id));
      expect(tip, id).not.toBeNull();
      expect(Number(tip!.style.zIndex), id).toBeGreaterThan(MINI_TOOLBAR_LAYER);
      act(() => {
        byTestId(id).dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: null }));
      });
    }
  });

  it("draws a palette swatch's tooltip above the palette it sits in", async () => {
    await render();
    await click(byTestId("mini-format-text-color"));
    const flyout = colourPopover("text")!.closest<HTMLElement>("[data-section-flyout]")!;
    vi.useFakeTimers();
    const tip = hoverFor(colourPopover("text")!.querySelector('[aria-label="Red"]')!);
    expect(tip?.textContent).toBe("Red");
    expect(Number(tip!.style.zIndex)).toBeGreaterThan(Number(flyout.style.zIndex));
  });

  it("lifts its overlays through props, not a global stylesheet rule", async () => {
    await render();
    const sheets = Array.from(document.querySelectorAll("style"))
      .map((s) => s.textContent ?? "")
      .join("\n");
    // The scan sees the emotion rules at all (the pill's own class is there)...
    expect(sheets).toContain(toolbar().className.split(" ")[0]);
    // ...and none of them reaches for the portalled overlays.
    expect(sheets).not.toMatch(/\[data-section-flyout\]:has/);
    expect(sheets).not.toContain("data-mini-format-toolbar");
  });
});

// ============================================================================
// Tokens only
// ============================================================================

describe("MiniFormatToolbar — no hardcoded chrome colours", () => {
  for (const [name, layout] of [
    ["band", bandLayout()],
    ["panel", panelLayout(320)],
  ] as const) {
    it(`paints only with tokens under ${name} geometry`, async () => {
      await render(menuContext(), layout);
      expect(findHardcodedColours(toolbar())).toEqual([]);
    });

    it(`the open palette's chrome is tokens only under ${name} geometry`, async () => {
      await render(menuContext(), layout);
      await click(byTestId("mini-format-text-color"));
      const flyout = colourPopover("text")!.closest("[data-section-flyout]")!;
      expect(findHardcodedColours(flyout)).toEqual([]);
    });
  }
});
