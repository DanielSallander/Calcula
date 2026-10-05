//! FILENAME: app/extensions/BuiltIn/HomeTab/__tests__/font/colorSplitButton.test.tsx
// PURPOSE: Excel's Fill Color and Font Color split buttons on the Home tab's
//          Font group (CONTRACT 3.5): the bar shows -- and the face applies --
//          the LAST colour applied from that button this session (Excel's
//          defaults yellow and red), a theme pick stays a theme slot + tint,
//          the palette's "No Fill" (after the Standard Colors, where live Excel
//          puts it) and "Automatic" (first) rows, "More Fill Options...", and
//          refusals reaching the user.
// CONTEXT: Rendered alone (HomeItemProps: item, state, band), in the ribbon
//          band and in the sidebar panel. The group's formatting door
//          (`state.applyFormat`) is a double, so each test sees exactly the
//          formatting a click sends; the theme palette is a double too (a
//          Tauri round-trip in the app).

/* eslint-disable @typescript-eslint/naming-convention --
 * The module double below stands in for RibbonIcon, whose real name is
 * PascalCase. */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@api", async () => {
  const icons = await import("@api/ribbonIcons");
  return { RibbonIcon: icons.RibbonIcon };
});

const dialogs = vi.hoisted(() => ({ alertAsync: vi.fn(async (..._a: unknown[]) => undefined) }));
vi.mock("@api/dialogs", () => dialogs);

const theme = vi.hoisted(() => ({ getThemeColorPalette: vi.fn() }));
vi.mock("@api/theme", () => theme);

import {
  SurfaceLayoutProvider,
  bandLayout,
  panelLayout,
  findHardcodedColours,
  type SurfaceLayout,
} from "@api/layout";
import { RibbonIcon } from "@api/ribbonIcons";
import { CommandRegistry, CoreCommands } from "@api/commands";
import type { HomeTabItem } from "../../homeTabConfig";
import type { HomeTabState } from "../../components/homeItemProps";
import { ColorSplitButton } from "../../components/font/ColorSplitButton";
import { COLOR_DEFAULTS, colorChoiceStore, resetColorChoices } from "../../components/font/colorChoice";

// ============================================================================
// Harness
// ============================================================================

/** The catalog's own entries (homeTabConfig). */
const FILL: HomeTabItem = { id: "backgroundColor", label: "Fill Color", tooltip: "Fill Color", type: "color", icon: "█", category: "Font" };
const FONT: HomeTabItem = { id: "textColor", label: "Text Color", tooltip: "Font Color", type: "color", icon: "A", category: "Font" };

const THEME = [
  { slot: "light1", tint: 0, resolvedColor: "#ffffff", label: "White, Background 1" },
  { slot: "accent1", tint: 0, resolvedColor: "#4472c4", label: "Blue, Accent 1" },
  { slot: "accent1", tint: 400, resolvedColor: "#8faadc", label: "Blue, Accent 1, Lighter 40%" },
];

const applyFormat = vi.fn();
const STATE = { applyFormat } as unknown as HomeTabState;

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  resetColorChoices();
  dialogs.alertAsync.mockClear();
  applyFormat.mockReset().mockResolvedValue(undefined);
  theme.getThemeColorPalette.mockReset().mockResolvedValue(THEME);
});

afterEach(() => {
  act(() => root.unmount());
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

const SURFACES: Array<[string, () => SurfaceLayout, boolean]> = [
  ["band", () => bandLayout(1200), true],
  ["panel", () => panelLayout(300), false],
];

async function render(item: HomeTabItem, surface: [string, () => SurfaceLayout, boolean] = SURFACES[0]): Promise<void> {
  const [, layout, band] = surface;
  await act(async () => {
    root.render(
      <SurfaceLayoutProvider value={layout()}>
        <ColorSplitButton item={item} state={STATE} band={band} />
      </SurfaceLayoutProvider>,
    );
  });
}

function byTestId(id: string): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>(`[data-testid='${id}']`);
  if (!el) throw new Error(`no ${id}`);
  return el;
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
  });
}

async function settle(): Promise<void> {
  for (let round = 0; round < 2; round++) {
    await act(async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

/** The colour the bar paints (jsdom normalises it to rgb()). */
function bar(id: string): string {
  return byTestId(`fmt-${id}`).querySelector<HTMLElement>("[data-colour-data]")!.style.background;
}

function svgMarkup(Comp: (p: { size: number }) => React.ReactElement, size: number): string {
  const host = document.createElement("div");
  const r = createRoot(host);
  act(() => r.render(React.createElement(Comp, { size })));
  const html = host.innerHTML;
  act(() => r.unmount());
  return html;
}

async function openPalette(id: string): Promise<HTMLElement> {
  click(byTestId(`fmt-${id}-options`));
  await settle();
  return byTestId(`fmt-${id}-popover`);
}

function swatch(palette: HTMLElement, name: string): HTMLButtonElement {
  const el = palette.querySelector<HTMLButtonElement>(`button[aria-label='${name}']`);
  if (!el) throw new Error(`no swatch ${name}`);
  return el;
}

// ============================================================================
// The control
// ============================================================================

describe("the control", () => {
  for (const surface of SURFACES) {
    for (const [item, name, icon] of [
      [FILL, "Fill Color", RibbonIcon.FillColor],
      [FONT, "Font Color", RibbonIcon.FontColor],
    ] as const) {
      it(`${name} is a split colour bar: two named halves, its picture (${surface[0]})`, async () => {
        await render(item, surface);
        const face = byTestId(`fmt-${item.id}`);
        const chevron = byTestId(`fmt-${item.id}-options`);
        expect(face.getAttribute("aria-label")).toBe(name);
        expect(face.hasAttribute("aria-haspopup")).toBe(false);
        expect(chevron.getAttribute("aria-label")).toBe(`${name} options`);
        expect(chevron.getAttribute("aria-haspopup")).toBe("dialog");
        expect(face.closest(".split")).not.toBeNull();
        expect(face.querySelector("svg")?.outerHTML).toBe(svgMarkup(icon, 20));
      });
    }
  }

  it("the bars start at Excel's defaults: yellow fill, red font", async () => {
    expect(COLOR_DEFAULTS.backgroundColor).toEqual({ kind: "hex", hex: "#ffff00" });
    expect(COLOR_DEFAULTS.textColor).toEqual({ kind: "hex", hex: "#ff0000" });
    await render(FILL);
    expect(bar("backgroundColor")).toBe("rgb(255, 255, 0)");
    await render(FONT);
    expect(bar("textColor")).toBe("rgb(255, 0, 0)");
  });

  it("the face applies the bar's colour without opening the palette", async () => {
    await render(FILL);
    click(byTestId("fmt-backgroundColor"));
    await settle();
    expect(applyFormat).toHaveBeenCalledWith({ backgroundColor: "#ffff00" }, "Fill Color");
    expect(document.querySelector("[data-testid='fmt-backgroundColor-popover']")).toBeNull();
    await render(FONT);
    click(byTestId("fmt-textColor"));
    await settle();
    expect(applyFormat).toHaveBeenLastCalledWith({ textColor: "#ff0000" }, "Font Color");
  });

  it("paints with tokens only around the colour data, the open palette included", async () => {
    await render(FILL);
    await openPalette("backgroundColor");
    // Colour DATA (swatches, the bar) is marked data-colour-data and exempt.
    expect(findHardcodedColours(document.body)).toEqual([]);
  });
});

// ============================================================================
// Fill Color's palette
// ============================================================================

describe("Fill Color", () => {
  it("a standard colour applies, becomes the bar, and the face then re-applies it", async () => {
    await render(FILL);
    const palette = await openPalette("backgroundColor");
    click(swatch(palette, "Red"));
    await settle();
    expect(applyFormat).toHaveBeenCalledWith({ backgroundColor: "#ff0000" }, "Fill Color");
    expect(bar("backgroundColor")).toBe("rgb(255, 0, 0)");
    applyFormat.mockClear();
    click(byTestId("fmt-backgroundColor"));
    await settle();
    expect(applyFormat).toHaveBeenCalledWith({ backgroundColor: "#ff0000" }, "Fill Color");
  });

  it("a theme colour keeps its slot and tint -- never flattened -- on the pick and on the face", async () => {
    await render(FILL);
    const palette = await openPalette("backgroundColor");
    click(swatch(palette, "Blue, Accent 1, Lighter 40%"));
    await settle();
    const sent = { backgroundColor: "#8faadc", bgColorTheme: "accent1", bgColorTint: 400 };
    expect(applyFormat).toHaveBeenCalledWith(sent, "Fill Color");
    expect(colorChoiceStore("backgroundColor").get()).toEqual({ kind: "theme", slot: "accent1", tint: 400, hex: "#8faadc" });
    expect(bar("backgroundColor")).toBe("rgb(143, 170, 220)");
    applyFormat.mockClear();
    click(byTestId("fmt-backgroundColor"));
    await settle();
    expect(applyFormat).toHaveBeenCalledWith(sent, "Fill Color");
  });

  it("'No Fill' sits after the Standard Colors (Excel's measured order) and removes the fill", async () => {
    await render(FILL);
    const palette = await openPalette("backgroundColor");
    const noFill = byTestId("fmt-backgroundColor-popover-automatic");
    expect(noFill.textContent).toBe("No Fill");
    const standard = Array.from(palette.querySelectorAll("[role='group']")).at(-1)!;
    expect(standard.textContent).toContain("Standard Colors");
    expect(standard.compareDocumentPosition(noFill) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(palette.firstElementChild).not.toBe(noFill);
    click(noFill);
    await settle();
    expect(applyFormat).toHaveBeenCalledWith({ fill: { type: "none" } }, "Fill Color");
    // The bar is now empty (no colour), and the face removes fills too.
    expect(byTestId("fmt-backgroundColor").querySelector("[data-colour-data]")!.getAttribute("style")).toContain("transparent");
    applyFormat.mockClear();
    click(byTestId("fmt-backgroundColor"));
    await settle();
    expect(applyFormat).toHaveBeenCalledWith({ fill: { type: "none" } }, "Fill Color");
  });

  it("keeps 'More Fill Options...', which opens Format Cells on its Fill tab", async () => {
    const execute = vi.spyOn(CommandRegistry, "execute").mockResolvedValue(undefined as never);
    await render(FILL);
    await openPalette("backgroundColor");
    const more = byTestId("fmt-backgroundColor-more");
    expect(more.textContent).toBe("More Fill Options...");
    click(more);
    await settle();
    expect(execute).toHaveBeenCalledWith(CoreCommands.FORMAT_CELLS, { tab: "fill" });
    expect(applyFormat).not.toHaveBeenCalled();
  });

  it("the palette says Excel's words: Theme Colors, Standard Colors, More Colors...", async () => {
    await render(FILL);
    const palette = await openPalette("backgroundColor");
    expect(palette.textContent).toContain("Theme Colors");
    expect(palette.textContent).toContain("Standard Colors");
    expect(palette.textContent).toContain("More Colors...");
  });
});

// ============================================================================
// Font Color's palette
// ============================================================================

describe("Font Color", () => {
  it("'Automatic' is FIRST and writes the default text colour (dark 1, no tint)", async () => {
    await render(FONT);
    const palette = await openPalette("textColor");
    const automatic = byTestId("fmt-textColor-popover-automatic");
    expect(palette.firstElementChild).toBe(automatic);
    expect(automatic.textContent).toBe("Automatic");
    click(automatic);
    await settle();
    expect(applyFormat).toHaveBeenCalledWith({ textColorTheme: "dark1", textColorTint: 0 }, "Font Color");
    // The bar shows the automatic ink, and the face applies Automatic again.
    expect(bar("textColor")).toBe("rgb(0, 0, 0)");
    applyFormat.mockClear();
    click(byTestId("fmt-textColor"));
    await settle();
    expect(applyFormat).toHaveBeenCalledWith({ textColorTheme: "dark1", textColorTint: 0 }, "Font Color");
  });

  it("has no 'More Fill Options...' row", async () => {
    await render(FONT);
    await openPalette("textColor");
    expect(document.querySelector("[data-testid='fmt-textColor-more']")).toBeNull();
    expect(document.body.textContent).not.toContain("More Fill Options");
  });

  it("a theme colour keeps its slot and tint", async () => {
    await render(FONT);
    const palette = await openPalette("textColor");
    click(swatch(palette, "Blue, Accent 1"));
    await settle();
    expect(applyFormat).toHaveBeenCalledWith(
      { textColor: "#4472c4", textColorTheme: "accent1", textColorTint: 0 },
      "Font Color",
    );
  });

  it("Fill and Font remember their colours separately", async () => {
    await render(FONT);
    const palette = await openPalette("textColor");
    click(swatch(palette, "Blue"));
    await settle();
    expect(colorChoiceStore("backgroundColor").get()).toEqual(COLOR_DEFAULTS.backgroundColor);
    await render(FILL);
    expect(bar("backgroundColor")).toBe("rgb(255, 255, 0)");
  });
});

// ============================================================================
// Refusals
// ============================================================================

describe("refusals", () => {
  it("a door that throws reaches the user (face)", async () => {
    applyFormat.mockRejectedValueOnce(new Error("Cell B2 is locked."));
    await render(FILL);
    click(byTestId("fmt-backgroundColor"));
    await settle();
    expect(dialogs.alertAsync).toHaveBeenCalledWith("Cell B2 is locked.");
  });

  it("a door that throws reaches the user (palette)", async () => {
    applyFormat.mockRejectedValueOnce(new Error("Nope."));
    await render(FONT);
    const palette = await openPalette("textColor");
    click(swatch(palette, "Red"));
    await settle();
    expect(dialogs.alertAsync).toHaveBeenCalledWith("Nope.");
  });

  it("More Fill Options... refused reaches the user", async () => {
    vi.spyOn(CommandRegistry, "execute").mockRejectedValue(new Error("Not now."));
    await render(FILL);
    await openPalette("backgroundColor");
    click(byTestId("fmt-backgroundColor-more"));
    await settle();
    expect(dialogs.alertAsync).toHaveBeenCalledWith("Not now.");
  });
});
