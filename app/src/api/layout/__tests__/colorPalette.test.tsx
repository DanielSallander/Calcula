// Tests for ColorPalette: the palette BODY that ColorPopover renders, exported
// on its own so it can be the content of a MenuSub flyout -- Excel's Format >
// Tab Color > and Borders > Line Color >, where the palette is not a popover
// of its own but the flyout of a menu row.
//
// What is pinned:
// - ONE body. ColorPopover renders ColorPalette's markup, so the two cannot
//   drift (compared element for element, ids aside).
// - Inside a MenuSub a pick -- a swatch, the automatic row, the hex field's
//   Enter, the extra action -- closes the WHOLE menu chain (useMenuClose) and
//   focus goes back to the control that opened the top menu, the way choosing
//   a MenuItem does.
// - Escape is ONE level back (the flyout closes, focus on its row) and it
//   CANCELS: a half-typed hex draft is dropped, never applied.
// - Opened from the keyboard, focus lands on the SELECTED swatch once the
//   theme has loaded (the palette's own rule), not on whatever button happens
//   to be first in the DOM before the theme grid arrives; ArrowRight on a
//   pointer-opened row steps into the palette the same way. Opened by the
//   pointer, focus stays on the row (the MenuSub rule).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const { paletteMock } = vi.hoisted(() => ({ paletteMock: vi.fn() }));

// The theme palette is a Tauri round-trip in the app (see color.test.tsx).
vi.mock("../../theme", () => ({ getThemeColorPalette: paletteMock }));

import {
  Button,
  ColorPalette,
  ColorPopover,
  MenuButton,
  MenuItem,
  MenuSub,
  SurfaceLayoutProvider,
  bandLayout,
  panelLayout,
  type ColorPaletteProps,
  type SurfaceLayout,
} from "../index";
import { hardcodedColours } from "./colourScan";

const SLOTS = ["bg1", "tx1", "bg2", "tx2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6"];
const BASE_HEX = ["#ffffff", "#000000", "#e7e6e6", "#44546a", "#4472c4", "#ed7d31", "#a5a5a5", "#ffc000", "#5b9bd5", "#70ad47"];
const TINT_HEX = ["#f2f2f2", "#7f7f7f", "#d0cece", "#d6dce4", "#d9e2f3", "#fbe5d5", "#ededed", "#fff2cc", "#deebf6", "#e2efd9"];
const THEME_PALETTE = [
  ...SLOTS.map((slot, i) => ({ slot, tint: 0, resolvedColor: BASE_HEX[i], label: `Theme ${slot}` })),
  ...SLOTS.map((slot, i) => ({ slot, tint: 800, resolvedColor: TINT_HEX[i], label: `Theme ${slot}, lighter 80%` })),
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
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

function render(node: React.ReactNode, layout: SurfaceLayout = panelLayout(300)): void {
  act(() => {
    root.render(<SurfaceLayoutProvider value={layout}>{node}</SurfaceLayoutProvider>);
  });
}

/** Flush the palette promise and the deferred focus, one act per turn so the
 *  effects a resolved promise schedules run before the next timer. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

/** A keyboard (or assistive) activation: detail 0. */
function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

/** A real pointer click: detail 1. */
function pointerClick(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, detail: 1 }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
  });
}

function mouseMove(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
  });
}

function key(el: Element, k: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
  act(() => {
    el.dispatchEvent(event);
  });
  return event;
}

function setInputValue(el: HTMLInputElement, v: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter?.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function byTestId<T extends Element = HTMLElement>(id: string): T {
  const el = document.querySelector(`[data-testid='${id}']`);
  if (!el) throw new Error(`no element for ${id}`);
  return el as T;
}

function maybe(id: string): HTMLElement | null {
  return document.querySelector(`[data-testid='${id}']`);
}

function menus(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[role='menu']"));
}

function swatches(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("[data-colour-swatch]"));
}

function swatchNamed(label: string): HTMLButtonElement {
  const el = swatches().find((s) => s.getAttribute("aria-label") === label);
  if (!el) throw new Error(`no swatch named "${label}"`);
  return el;
}

/** useId values differ by tree position; the markup around them must not. */
function withoutIds(html: string): string {
  return html.replace(/«[^»]*»|:r[0-9a-z]+:/g, "<id>");
}

interface Spies {
  onChange: ReturnType<typeof vi.fn>;
  onTheme: ReturnType<typeof vi.fn>;
  onAutomatic: ReturnType<typeof vi.fn>;
  onMore: ReturnType<typeof vi.fn>;
}

function spies(): Spies {
  return { onChange: vi.fn(), onTheme: vi.fn(), onAutomatic: vi.fn(), onMore: vi.fn() };
}

/** Excel's Format menu, cut down: Format > Tab Color > (a palette flyout). */
function FormatMenu({
  s,
  value = "#0070c0",
  extra = {},
}: {
  s: Spies;
  value?: string | null;
  extra?: Partial<ColorPaletteProps>;
}): React.ReactElement {
  return (
    <>
      <MenuButton trigger={<Button data-testid="trigger">Format</Button>} ariaLabel="Format">
        <MenuItem testId="rename" onSelect={() => undefined}>
          Rename Sheet
        </MenuItem>
        <MenuSub label="Tab Color" testId="tabColor">
          <ColorPalette
            value={value}
            onChange={s.onChange}
            onThemeColorChange={s.onTheme}
            allowAutomatic
            automaticLabel="No Color"
            automaticChip="none"
            automaticPlacement="afterColors"
            onAutomatic={s.onAutomatic}
            moreAction={{ label: "More Colors...", onSelect: s.onMore, testId: "tab-more" }}
            testId="tab-palette"
            {...extra}
          />
        </MenuSub>
        <MenuItem testId="protect" onSelect={() => undefined}>
          Protect Sheet...
        </MenuItem>
      </MenuButton>
      <input data-testid="elsewhere" />
    </>
  );
}

/** Open Format, then Tab Color from the keyboard, and let the theme load. */
async function openTabColorFromKeys(): Promise<void> {
  click(byTestId("trigger"));
  key(byTestId("tabColor"), "ArrowRight");
  await settle();
}

// ============================================================================
// One body
// ============================================================================

describe("ColorPalette -- one body", () => {
  it("is exported from the @api/layout barrel", () => {
    expect(typeof ColorPalette).toBe("function");
  });

  it("renders the very markup ColorPopover renders as its body (ids aside)", async () => {
    const props = {
      value: "#d9e2f3",
      themeSlot: "accent1",
      themeTint: 800,
      onChange: () => undefined,
      allowAutomatic: true,
      automaticLabel: "No Fill",
      automaticChip: "none" as const,
      automaticPlacement: "afterColors" as const,
      moreAction: { label: "More Fill Options...", onSelect: () => undefined, testId: "more" },
      testId: "pal",
    };
    const anchor = document.createElement("button");
    document.body.appendChild(anchor);
    render(<ColorPopover anchorEl={anchor} open onClose={() => undefined} {...props} />);
    await settle();
    const fromPopover = withoutIds(byTestId("pal").outerHTML);
    act(() => root.unmount());
    document.body.innerHTML = "";
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    render(<ColorPalette {...props} />);
    await settle();
    const alone = withoutIds(byTestId("pal").outerHTML);
    // Precondition: the comparison sees a whole palette, not two empty shells.
    expect(alone).toContain("Theme Colors");
    expect(alone).toContain("Standard Colors");
    expect(alone).toContain("No Fill");
    expect(alone).toContain("More Fill Options...");
    expect(alone).toBe(fromPopover);
  });

  it("standalone (no menu, no popover): a pick reports and calls onDone", async () => {
    const s = spies();
    const onDone = vi.fn();
    render(<ColorPalette value={null} onChange={s.onChange} onThemeColorChange={s.onTheme} onDone={onDone} />);
    await settle();
    click(swatchNamed("Red"));
    expect(s.onChange).toHaveBeenCalledWith("#ff0000");
    expect(onDone).toHaveBeenCalledTimes(1);
    click(swatchNamed("Theme accent2, lighter 80%"));
    expect(s.onTheme).toHaveBeenCalledWith("accent2", 800, "#fbe5d5");
    expect(onDone).toHaveBeenCalledTimes(2);
  });

  it("standalone without onDone is harmless (useMenuClose outside a menu is a no-op)", async () => {
    const s = spies();
    render(<ColorPalette value={null} onChange={s.onChange} />);
    await settle();
    expect(() => click(swatchNamed("Red"))).not.toThrow();
    expect(s.onChange).toHaveBeenCalledWith("#ff0000");
    // Still there: nothing to close.
    expect(swatches().length).toBeGreaterThan(0);
  });

  it("autoFocus puts focus on the selected swatch once the theme has loaded", async () => {
    render(<ColorPalette value="#0070c0" onChange={() => undefined} autoFocus />);
    await settle();
    expect(document.activeElement).toBe(swatchNamed("Blue"));
  });

  it("without autoFocus, outside a flyout, it never takes focus", async () => {
    render(
      <>
        <input data-testid="field" />
        <ColorPalette value="#0070c0" onChange={() => undefined} />
      </>,
    );
    act(() => byTestId("field").focus());
    await settle();
    expect(document.activeElement).toBe(byTestId("field"));
  });
});

// ============================================================================
// Inside a MenuSub flyout
// ============================================================================

describe("ColorPalette in a MenuSub (Format > Tab Color >)", () => {
  it("is the flyout's custom content: a group the row announces as a dialog popup", async () => {
    render(<FormatMenu s={spies()} />);
    await openTabColorFromKeys();
    const body = byTestId("tab-palette");
    const group = body.closest("[role='group'][aria-labelledby]") as HTMLElement;
    expect(group).not.toBeNull();
    expect(group.getAttribute("aria-labelledby")).toBe(byTestId("tabColor").id);
    expect(byTestId("tabColor").getAttribute("aria-haspopup")).toBe("dialog");
    // The whole palette is there: theme grid, standard row.
    expect(swatches()).toHaveLength(30);
  });

  it("opened from the KEYBOARD, focus lands on the SELECTED swatch after the theme loads", async () => {
    // The theme arrives after the flyout mounts. Focusing "the first
    // focusable" at mount would land on a STANDARD swatch that the theme grid
    // then pushes down; the palette places its own focus once it has settled.
    let resolve: (v: unknown) => void = () => undefined;
    paletteMock.mockReturnValue(new Promise((r) => (resolve = r)));
    render(<FormatMenu s={spies()} value="#d9e2f3" extra={{ themeSlot: "accent1", themeTint: 800 }} />);
    click(byTestId("trigger"));
    key(byTestId("tabColor"), "ArrowRight");
    await settle();
    // Not yet loaded: focus has not been parked on a standard swatch.
    expect(document.activeElement?.hasAttribute("data-colour-swatch")).toBe(false);
    await act(async () => {
      resolve(THEME_PALETTE);
    });
    await settle();
    expect(document.activeElement).toBe(swatchNamed("Theme accent1, lighter 80%"));
  });

  it("with nothing selected, keyboard focus starts on the first swatch", async () => {
    render(<FormatMenu s={spies()} value="#123456" />);
    await openTabColorFromKeys();
    expect(document.activeElement).toBe(swatches()[0]);
  });

  it("opened by the POINTER, focus stays on the row (the MenuSub rule)", async () => {
    render(<FormatMenu s={spies()} />);
    click(byTestId("trigger"));
    // The pointer reaches the row (which focuses it, as in a popup menu) and clicks.
    mouseMove(byTestId("tabColor"));
    pointerClick(byTestId("tabColor"));
    await settle();
    expect(maybe("tab-palette")).not.toBeNull();
    expect(swatches()).toHaveLength(30);
    expect(document.activeElement).toBe(byTestId("tabColor"));
  });

  it("ArrowRight on a pointer-opened row steps INTO the palette, on the selected swatch", async () => {
    render(<FormatMenu s={spies()} />);
    click(byTestId("trigger"));
    mouseMove(byTestId("tabColor"));
    pointerClick(byTestId("tabColor"));
    await settle();
    expect(document.activeElement).toBe(byTestId("tabColor"));
    key(byTestId("tabColor"), "ArrowRight");
    // Not the first button in the DOM (a theme swatch): the SELECTED one.
    expect(document.activeElement).toBe(swatchNamed("Blue"));
  });

  it("a swatch pick closes the WHOLE chain, focus back on the trigger, applied once", async () => {
    const s = spies();
    render(<FormatMenu s={s} />);
    await openTabColorFromKeys();
    click(swatchNamed("Red"));
    expect(s.onChange.mock.calls).toEqual([["#ff0000"]]);
    expect(menus()).toHaveLength(0);
    expect(maybe("tab-palette")).toBeNull();
    expect(document.activeElement).toBe(byTestId("trigger"));
  });

  it("a theme pick keeps the SLOT and tint, and closes the chain", async () => {
    const s = spies();
    render(<FormatMenu s={s} />);
    await openTabColorFromKeys();
    click(swatchNamed("Theme accent6"));
    expect(s.onTheme).toHaveBeenCalledWith("accent6", 0, "#70ad47");
    expect(s.onChange).not.toHaveBeenCalled();
    expect(menus()).toHaveLength(0);
  });

  it("the automatic row ('No Color') runs onAutomatic only, and closes the chain", async () => {
    const s = spies();
    render(<FormatMenu s={s} />);
    await openTabColorFromKeys();
    click(byTestId("tab-palette-automatic"));
    expect(s.onAutomatic).toHaveBeenCalledTimes(1);
    expect(s.onChange).not.toHaveBeenCalled();
    expect(menus()).toHaveLength(0);
    expect(document.activeElement).toBe(byTestId("trigger"));
  });

  it("the extra action closes the chain BEFORE it runs (it usually opens a dialog)", async () => {
    // The close is a state change React applies after the handler, so "closed
    // first" is observable as FOCUS: the chain's close has already handed
    // focus back to the trigger when the action runs, and a dialog the action
    // opens takes it from there (and gives it back there), not from a palette
    // that is about to unmount under it.
    const s = spies();
    let focusedAtRun: Element | null = null;
    s.onMore.mockImplementation(() => {
      focusedAtRun = document.activeElement;
    });
    render(<FormatMenu s={s} />);
    await openTabColorFromKeys();
    expect(byTestId("tab-palette").contains(document.activeElement)).toBe(true);
    click(byTestId("tab-more"));
    expect(s.onMore).toHaveBeenCalledTimes(1);
    expect(focusedAtRun).toBe(byTestId("trigger"));
    expect(menus()).toHaveLength(0);
  });

  it("Enter in the hex field applies ONCE and closes the chain", async () => {
    const s = spies();
    render(<FormatMenu s={s} />);
    await openTabColorFromKeys();
    const hex = byTestId<HTMLInputElement>("tab-palette-hex");
    act(() => hex.focus());
    setInputValue(hex, "12ab34");
    key(hex, "Enter");
    await settle();
    expect(s.onChange.mock.calls).toEqual([["#12ab34"]]);
    expect(menus()).toHaveLength(0);
  });

  it("Escape on a swatch closes ONLY the flyout: the menu stays, focus on the row", async () => {
    const s = spies();
    render(<FormatMenu s={s} />);
    await openTabColorFromKeys();
    const event = key(document.activeElement!, "Escape");
    expect(event.defaultPrevented).toBe(true);
    expect(maybe("tab-palette")).toBeNull();
    expect(menus()).toHaveLength(1);
    expect(document.activeElement).toBe(byTestId("tabColor"));
    expect(s.onChange).not.toHaveBeenCalled();
  });

  it("Enter in the hex field applies the colour the palette ALREADY shows (a pick, like a swatch click)", async () => {
    // Fill Color's value is the REMEMBERED colour (Excel's yellow by default),
    // not the cell's: typing that colour and pressing Enter must still fill
    // the selection (BUG-0537, found live in floating-grid-home FG2).
    const s = spies();
    render(<FormatMenu s={s} value="#0070c0" />);
    await openTabColorFromKeys();
    const hex = byTestId<HTMLInputElement>("tab-palette-hex");
    act(() => hex.focus());
    setInputValue(hex, "#0070C0");
    key(hex, "Enter");
    await settle();
    expect(s.onChange.mock.calls).toEqual([["#0070c0"]]);
    expect(menus()).toHaveLength(0);
  });

  it("Escape in a FOCUSED hex field drops the draft: one level back, nothing applied", async () => {
    const s = spies();
    render(<FormatMenu s={s} />);
    await openTabColorFromKeys();
    const hex = byTestId<HTMLInputElement>("tab-palette-hex");
    act(() => hex.focus());
    setInputValue(hex, "12ab34");
    key(hex, "Escape");
    await settle();
    expect(maybe("tab-palette")).toBeNull();
    expect(menus()).toHaveLength(1);
    expect(document.activeElement, "precondition: the close moved focus off the field").toBe(
      byTestId("tabColor"),
    );
    expect(s.onChange).not.toHaveBeenCalled();
  });

  it("the arrows walk the palette grid and never close the flyout", async () => {
    render(<FormatMenu s={spies()} value="#123456" />);
    await openTabColorFromKeys();
    const all = swatches();
    expect(document.activeElement).toBe(all[0]);
    for (const k of ["ArrowLeft", "ArrowRight", "ArrowDown", "Home", "End"]) key(document.activeElement!, k);
    expect(document.activeElement).toBe(all[all.length - 1]);
    expect(maybe("tab-palette")).not.toBeNull();
    expect(menus()).toHaveLength(1);
  });

  it("a press inside the palette dismisses nothing", async () => {
    render(<FormatMenu s={spies()} />);
    await openTabColorFromKeys();
    act(() => {
      swatchNamed("Red").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(maybe("tab-palette")).not.toBeNull();
    expect(menus()).toHaveLength(1);
  });

  it.each([
    ["band", bandLayout()],
    ["panel", panelLayout(300)],
  ])("paints no hardcoded colour in the %s (the swatches are data)", async (_name, layout) => {
    render(<FormatMenu s={spies()} />, layout);
    await openTabColorFromKeys();
    expect(swatches().length).toBeGreaterThan(0);
    expect(hardcodedColours(document.body)).toEqual([]);
  });
});
