// Tests for the @api/layout colour primitives: colors.ts (the DATA and the hex
// helpers), ColorSwatch (bar / swatch faces, sizes, the native OS-picker mode)
// and ColorPopover (theme grid with tints, standard row, automatic, custom
// input, hex field, keyboard, focus return). ColorPopover must be able to
// replace the Format Cells ColorPicker, so the theme contract is pinned:
// onThemeColorChange(slot, tint, hex) when given, onChange(hex) otherwise, and
// selection by slot+tint for theme colours but by hex for standard ones.
// Every surface is scanned for hardcoded colours under band AND panel
// geometry; the swatches are data and must be the only literals rendered.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const { paletteMock } = vi.hoisted(() => ({ paletteMock: vi.fn() }));

// The theme palette is a Tauri round-trip in the app; the test pins the shape
// the Rust side returns (ThemeColorInfo: slot, tint, resolvedColor, label).
vi.mock("../../theme", () => ({ getThemeColorPalette: paletteMock }));

import { SurfaceLayoutProvider, bandLayout, panelLayout, type SurfaceLayout } from "../context";
import { findHardcodedColours } from "../testing";
import {
  QUICK_COLORS,
  STANDARD_COLORS,
  colorLabel,
  normalizeHex,
  sameColor,
} from "../colors";
import { ColorPopover, ColorSwatch } from "../primitives/Color";

// ============================================================================
// Fixtures + harness
// ============================================================================

const SLOTS = ["bg1", "tx1", "bg2", "tx2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6"];
const BASE_HEX = ["#ffffff", "#000000", "#e7e6e6", "#44546a", "#4472c4", "#ed7d31", "#a5a5a5", "#ffc000", "#5b9bd5", "#70ad47"];
const TINT_HEX = ["#f2f2f2", "#7f7f7f", "#d0cece", "#d6dce4", "#d9e2f3", "#fbe5d5", "#ededed", "#fff2cc", "#deebf6", "#e2efd9"];

const THEME_PALETTE = [
  ...SLOTS.map((slot, i) => ({ slot, tint: 0, resolvedColor: BASE_HEX[i], label: `Theme ${slot}` })),
  ...SLOTS.map((slot, i) => ({
    slot,
    tint: 800,
    resolvedColor: TINT_HEX[i],
    label: `Theme ${slot}, lighter 80%`,
  })),
];

/**
 * findHardcodedColours with its one known false positive neutralised: the
 * colour-name alternation in testing.ts matches the "white" of `white-space`.
 * The declarations are removed from the stylesheet text for the duration of
 * the scan (filtering findings instead would hide a real literal later in the
 * same rule, since the helper reports the first hit per rule). Same helper as
 * buttons.test.tsx; a harmless no-op once testing.ts is fixed.
 */
function hardcodedColours(root: Element): string[] {
  const tags = Array.from(document.querySelectorAll("style"));
  const saved = tags.map((tag) => tag.textContent);
  try {
    for (const tag of tags) {
      tag.textContent = (tag.textContent ?? "").replace(/white-space\s*:\s*[a-z-]+\s*;?/gi, "");
    }
    return findHardcodedColours(root);
  } finally {
    tags.forEach((tag, i) => {
      tag.textContent = saved[i];
    });
  }
}

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

/** Flush the palette promise and the deferred focus-on-open, inside act. */
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

function key(el: Element, k: string): void {
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
}

/** Drive an <input> the way React sees a user edit: native value setter,
 *  then input + change events (the same idiom the chart-pane tests use). */
function setInputValue(el: HTMLInputElement, v: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter?.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function flyout(): HTMLElement | null {
  return document.querySelector("[data-section-flyout]");
}

function swatches(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("[data-colour-swatch]"));
}

function swatchNamed(label: string): HTMLButtonElement {
  const el = swatches().find((s) => s.getAttribute("aria-label") === label);
  if (!el) throw new Error(`no swatch named "${label}"`);
  return el;
}

const Icon = (): React.ReactElement => (
  <svg data-testid="fc-icon" width="20" height="20" viewBox="0 0 24 24">
    <rect x="4" y="4" width="16" height="16" fill="currentColor" />
  </svg>
);

// ============================================================================
// colors.ts
// ============================================================================

describe("colors.ts", () => {
  it("STANDARD_COLORS is Office's standard row, in Office's order", () => {
    expect([...STANDARD_COLORS]).toEqual([
      "#c00000",
      "#ff0000",
      "#ffc000",
      "#ffff00",
      "#92d050",
      "#00b050",
      "#00b0f0",
      "#0070c0",
      "#002060",
      "#7030a0",
    ]);
  });

  it("QUICK_COLORS is two rows of ten canonical hex colours", () => {
    expect(QUICK_COLORS).toHaveLength(20);
    for (const c of QUICK_COLORS) expect(normalizeHex(c)).toBe(c);
  });

  it("normalizeHex canonicalises #rgb / #rrggbb with or without # and rejects the rest", () => {
    expect(normalizeHex("#ABCDEF")).toBe("#abcdef");
    expect(normalizeHex("abcdef")).toBe("#abcdef");
    expect(normalizeHex("#f0a")).toBe("#ff00aa");
    expect(normalizeHex(" 123 ")).toBe("#112233");
    expect(normalizeHex("rgb(1, 2, 3)")).toBeNull();
    expect(normalizeHex("red")).toBeNull();
    expect(normalizeHex("#12345678")).toBeNull();
    expect(normalizeHex(null)).toBeNull();
    expect(normalizeHex(undefined)).toBeNull();
  });

  it("colorLabel names the palette colours and falls back to upper-case hex", () => {
    expect(colorLabel("#C00000")).toBe("Dark red");
    expect(colorLabel("#fff")).toBe("White");
    expect(colorLabel("#1a2b3c")).toBe("#1A2B3C");
    expect(colorLabel("tomato")).toBe("tomato");
  });

  it("sameColor compares hex shorthand- and case-insensitively", () => {
    expect(sameColor("#FFF", "#ffffff")).toBe(true);
    expect(sameColor("#ff0000", "#fe0000")).toBe(false);
    expect(sameColor(null, "#ffffff")).toBe(false);
    expect(sameColor("Red", "red")).toBe(true);
  });
});

// ============================================================================
// ColorSwatch — faces and geometry
// ============================================================================

describe("ColorSwatch — faces", () => {
  it("bar: a 32x28 button with the icon over a 4px bar of the colour", () => {
    render(<ColorSwatch variant="bar" icon={<Icon />} color="#c0392b" onChange={() => {}} label="Font colour" />);
    const btn = container.querySelector("button")!;
    expect(btn.getAttribute("aria-label")).toBe("Font colour");
    expect(btn.getAttribute("aria-haspopup")).toBe("dialog");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(btn.style.width).toBe("32px");
    expect(btn.style.height).toBe("28px");
    expect(container.querySelector("[data-testid='fc-icon']")).not.toBeNull();

    const bar = btn.querySelector<HTMLElement>("[data-colour-data]")!;
    expect(bar).not.toBeNull();
    expect(bar.style.height).toBe("4px");
    // 3px above the content box = 4px above the outer edge (1px border).
    expect(bar.style.bottom).toBe("3px");
    expect(bar.style.background).toContain("rgb(192, 57, 43)");
  });

  it("swatch: a 28x28 button with a 16px chip carrying the colour", () => {
    render(<ColorSwatch color="#00b050" onChange={() => {}} label="Series colour" />);
    const btn = container.querySelector("button")!;
    expect(btn.style.width).toBe("28px");
    expect(btn.style.height).toBe("28px");
    const chip = btn.querySelector<HTMLElement>("[data-colour-data]")!;
    expect(chip.style.width).toBe("16px");
    expect(chip.style.height).toBe("16px");
    expect(chip.style.background).toContain("rgb(0, 176, 80)");
  });

  it("sm: a 24px row (28x24 bar, 3px bar; 24x24 swatch, 14px chip)", () => {
    render(
      <>
        <ColorSwatch size="sm" variant="bar" icon={<Icon />} color="#000000" onChange={() => {}} label="A" />
        <ColorSwatch size="sm" color="#000000" onChange={() => {}} label="B" />
      </>,
    );
    const [bar, swatch] = Array.from(container.querySelectorAll("button"));
    expect(bar.style.width).toBe("28px");
    expect(bar.style.height).toBe("24px");
    expect(bar.querySelector<HTMLElement>("[data-colour-data]")!.style.height).toBe("3px");
    expect(swatch.style.width).toBe("24px");
    expect(swatch.querySelector<HTMLElement>("[data-colour-data]")!.style.width).toBe("14px");
  });

  it("a chevron grows the button sideways (min-width kept, no fixed width)", () => {
    render(<ColorSwatch variant="bar" chevron icon={<Icon />} color="#000000" onChange={() => {}} label="Fill colour" />);
    const btn = container.querySelector("button")!;
    expect(btn.style.minWidth).toBe("32px");
    expect(btn.style.width).toBe("");
    expect(btn.querySelectorAll("svg")).toHaveLength(2);
  });

  it("null paints no guessed colour", () => {
    render(<ColorSwatch color={null} onChange={() => {}} label="Fill colour" />);
    const chip = container.querySelector<HTMLElement>("[data-colour-data]")!;
    expect(chip.style.background).toBe("transparent");
  });

  it("passes testId and HTML props to the button, and a caller's onClick runs first", async () => {
    const onClick = vi.fn((e: React.MouseEvent) => e.preventDefault());
    render(
      <ColorSwatch testId="fmt-textColor" title="Font Color" color="#000000" onChange={() => {}} label="Font colour" onClick={onClick} />,
    );
    const btn = container.querySelector("[data-testid='fmt-textColor']")!;
    expect(btn.tagName).toBe("BUTTON");
    expect(btn.getAttribute("title")).toBe("Font Color");
    await click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
    // preventDefault() in the caller's handler keeps the popover shut.
    expect(flyout()).toBeNull();
  });

  it.each([
    ["band", bandLayout()],
    ["panel", panelLayout(300)],
  ])("paints no hardcoded colour in the %s (the colours are data)", (_name, layout) => {
    render(
      <>
        <ColorSwatch variant="bar" icon={<Icon />} color="#c0392b" onChange={() => {}} label="Font colour" />
        <ColorSwatch color="#ffd966" chevron onChange={() => {}} label="Fill colour" />
        <ColorSwatch native color="#123456" onChange={() => {}} label="Series colour" />
      </>,
      layout,
    );
    expect(hardcodedColours(container)).toEqual([]);
  });

  it("the scan has teeth: without data-colour-data the literals are reported", () => {
    render(<ColorSwatch variant="bar" icon={<Icon />} color="#c0392b" onChange={() => {}} label="Font colour" />);
    expect(hardcodedColours(container)).toEqual([]);
    container.querySelectorAll("[data-colour-data]").forEach((el) => el.removeAttribute("data-colour-data"));
    expect(hardcodedColours(container).length).toBeGreaterThan(0);
  });
});

// ============================================================================
// ColorSwatch — native (OS picker)
// ============================================================================

describe("ColorSwatch — native", () => {
  it("keeps a real <input type=color> named by the label, carrying the colour", () => {
    render(<ColorSwatch native color="#123456" onChange={() => {}} label="Colour" />);
    const input = container.querySelector<HTMLInputElement>('input[type="color"]')!;
    expect(input).not.toBeNull();
    expect(input.getAttribute("aria-label")).toBe("Colour");
    expect(input.value).toBe("#123456");
    // No <button>: an input may not sit inside one, and the face is not a
    // second tab stop.
    expect(container.querySelector("button")).toBeNull();
  });

  it("the input covers the face transparently, so a click opens the OS picker", () => {
    render(<ColorSwatch native color="#123456" onChange={() => {}} label="Colour" />);
    const input = container.querySelector<HTMLInputElement>('input[type="color"]')!;
    const cs = getComputedStyle(input);
    expect(cs.position).toBe("absolute");
    expect(cs.opacity).toBe("0");
    expect(getComputedStyle(input.parentElement!).position).toBe("relative");
  });

  it("a change on the input calls onChange with the hex", () => {
    const onChange = vi.fn();
    render(<ColorSwatch native color="#123456" onChange={onChange} label="Colour" />);
    setInputValue(container.querySelector<HTMLInputElement>('input[type="color"]')!, "#abcdef");
    expect(onChange).toHaveBeenCalledWith("#abcdef");
  });

  it("a colour the input cannot speak falls back to black instead of throwing", () => {
    render(<ColorSwatch native color="rgb(1, 2, 3)" onChange={() => {}} label="Colour" />);
    expect(container.querySelector<HTMLInputElement>('input[type="color"]')!.value).toBe("#000000");
  });

  it("disabled disables the input and dims the face", () => {
    render(<ColorSwatch native disabled color="#123456" onChange={() => {}} label="Colour" testId="nat" />);
    const input = container.querySelector<HTMLInputElement>("[data-testid='nat']")!;
    expect(input.disabled).toBe(true);
    expect(input.parentElement!.hasAttribute("data-disabled")).toBe(true);
  });

  it("HTML props and a caller's onClick reach the input (it is the control)", async () => {
    const onClick = vi.fn();
    render(<ColorSwatch native title="Series colour" onClick={onClick} color="#123456" onChange={() => {}} label="Colour" />);
    const input = container.querySelector<HTMLInputElement>('input[type="color"]')!;
    expect(input.getAttribute("title")).toBe("Series colour");
    await click(input);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("never opens the palette popover", async () => {
    render(<ColorSwatch native color="#123456" onChange={() => {}} label="Colour" />);
    await click(container.querySelector('input[type="color"]')!);
    expect(flyout()).toBeNull();
    expect(paletteMock).not.toHaveBeenCalled();
  });
});

// ============================================================================
// ColorPopover via ColorSwatch
// ============================================================================

describe("ColorPopover — content", () => {
  it("opens a card popover with the theme grid (base row + tints) and the standard row", async () => {
    render(<ColorSwatch color="#ff0000" onChange={() => {}} label="Font colour" />);
    await click(container.querySelector("button")!);
    await settle();

    const pop = flyout()!;
    expect(pop).not.toBeNull();
    expect(pop.getAttribute("aria-label")).toBe("Font colour");
    expect(container.querySelector("button")!.getAttribute("aria-expanded")).toBe("true");
    expect(paletteMock).toHaveBeenCalledTimes(1);
    expect(pop.textContent).toContain("Theme colours");
    expect(pop.textContent).toContain("Standard colours");
    expect(pop.textContent).toContain("More colours...");
    // 10 base + 10 tints + 10 standard.
    expect(swatches()).toHaveLength(30);
    expect(swatchNamed("Dark red")).toBeDefined();
    expect(swatchNamed("Theme accent1, lighter 80%")).toBeDefined();
    // Every swatch is data, named, and paints its own colour.
    for (const s of swatches()) {
      expect(s.hasAttribute("data-colour-data")).toBe(true);
      expect(s.getAttribute("aria-label")).toBeTruthy();
      expect(s.style.background).not.toBe("");
    }
  });

  it("marks the standard swatch matching the value (shorthand-insensitive)", async () => {
    render(<ColorSwatch color="#F00" onChange={() => {}} label="Font colour" />);
    await click(container.querySelector("button")!);
    await settle();
    const pressed = swatches().filter((s) => s.getAttribute("aria-pressed") === "true");
    expect(pressed.map((s) => s.getAttribute("aria-label"))).toEqual(["Red"]);
  });

  it("a theme slot selects by slot+tint, and then no standard swatch is marked", async () => {
    render(
      <ColorSwatch color="#ff0000" themeSlot="accent1" themeTint={800} onChange={() => {}} label="Fill colour" />,
    );
    await click(container.querySelector("button")!);
    await settle();
    const pressed = swatches().filter((s) => s.getAttribute("aria-pressed") === "true");
    expect(pressed.map((s) => s.getAttribute("aria-label"))).toEqual(["Theme accent1, lighter 80%"]);
  });

  it("a custom colours list replaces the standard row, ten per row", async () => {
    render(
      <ColorSwatch colors={QUICK_COLORS} showTheme={false} colorsHeading="Colours" color={null} onChange={() => {}} label="Fill colour" />,
    );
    await click(container.querySelector("button")!);
    await settle();
    expect(paletteMock).not.toHaveBeenCalled();
    expect(swatches()).toHaveLength(20);
    expect(flyout()!.textContent).not.toContain("Theme colours");
    expect(flyout()!.textContent).toContain("Colours");
  });

  it("keeps working without a theme when the palette cannot load (and says so)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    paletteMock.mockRejectedValue(new Error("no document"));
    render(<ColorSwatch color="#ff0000" onChange={() => {}} label="Font colour" />);
    await click(container.querySelector("button")!);
    await settle();
    expect(swatches()).toHaveLength(10);
    expect(flyout()!.textContent).not.toContain("Theme colours");
    expect(warn).toHaveBeenCalled();
  });

  it.each([
    ["band", bandLayout()],
    ["panel", panelLayout(300)],
  ])("the open popover paints no hardcoded colour in the %s", async (_name, layout) => {
    render(
      <ColorSwatch
        variant="bar"
        icon={<Icon />}
        color="#ff0000"
        allowAutomatic
        moreAction={{ label: "More fill options...", onSelect: () => {} }}
        onChange={() => {}}
        label="Fill colour"
      />,
      layout,
    );
    await click(container.querySelector("button")!);
    await settle();
    expect(hardcodedColours(flyout()!)).toEqual([]);
    expect(hardcodedColours(container)).toEqual([]);
  });

  it("the popover scan has teeth: stripping data-colour-data exposes the swatches", async () => {
    render(<ColorSwatch color="#ff0000" onChange={() => {}} label="Font colour" />);
    await click(container.querySelector("button")!);
    await settle();
    const pop = flyout()!;
    pop.querySelectorAll("[data-colour-data]").forEach((el) => el.removeAttribute("data-colour-data"));
    expect(hardcodedColours(pop).length).toBeGreaterThan(0);
  });
});

describe("ColorPopover — picking", () => {
  it("a standard swatch calls onChange with its hex and closes", async () => {
    const onChange = vi.fn();
    render(<ColorSwatch color="#000000" onChange={onChange} label="Font colour" />);
    await click(container.querySelector("button")!);
    await settle();
    await click(swatchNamed("Red"));
    expect(onChange).toHaveBeenCalledWith("#ff0000");
    expect(flyout()).toBeNull();
    expect(container.querySelector("button")!.getAttribute("aria-expanded")).toBe("false");
  });

  it("a theme swatch calls onThemeColorChange(slot, tint, hex) and NOT onChange", async () => {
    const onChange = vi.fn();
    const onTheme = vi.fn();
    render(<ColorSwatch color="#000000" onChange={onChange} onThemeColorChange={onTheme} label="Fill colour" />);
    await click(container.querySelector("button")!);
    await settle();
    await click(swatchNamed("Theme accent2, lighter 80%"));
    expect(onTheme).toHaveBeenCalledWith("accent2", 800, "#fbe5d5");
    expect(onChange).not.toHaveBeenCalled();
    expect(flyout()).toBeNull();
  });

  it("without onThemeColorChange a theme pick flattens to onChange(resolved hex)", async () => {
    const onChange = vi.fn();
    render(<ColorSwatch color="#000000" onChange={onChange} label="Fill colour" />);
    await click(container.querySelector("button")!);
    await settle();
    await click(swatchNamed("Theme accent1"));
    expect(onChange).toHaveBeenCalledWith("#4472c4");
  });

  it("Automatic: offered only when allowed, marked when the value is null, calls onAutomatic", async () => {
    const onAutomatic = vi.fn();
    render(<ColorSwatch color={null} allowAutomatic onAutomatic={onAutomatic} onChange={() => {}} label="Font colour" />);
    await click(container.querySelector("button")!);
    await settle();
    const auto = Array.from(flyout()!.querySelectorAll("button")).find((b) => b.textContent === "Automatic")!;
    expect(auto).toBeDefined();
    expect(auto.getAttribute("aria-pressed")).toBe("true");
    await click(auto);
    expect(onAutomatic).toHaveBeenCalledTimes(1);
    expect(flyout()).toBeNull();
  });

  it("automaticLabel renames the row ('No fill')", async () => {
    render(<ColorSwatch color="#ff0000" allowAutomatic automaticLabel="No fill" onChange={() => {}} label="Fill colour" />);
    await click(container.querySelector("button")!);
    await settle();
    const row = Array.from(flyout()!.querySelectorAll("button")).find((b) => b.textContent === "No fill")!;
    expect(row.getAttribute("aria-pressed")).toBe("false");
  });

  it("no Automatic row unless allowed", async () => {
    render(<ColorSwatch color={null} onChange={() => {}} label="Font colour" />);
    await click(container.querySelector("button")!);
    await settle();
    expect(flyout()!.textContent).not.toContain("Automatic");
  });

  it("More colours...: an inline <input type=color> that reports live and keeps the popover open", async () => {
    const onChange = vi.fn();
    render(<ColorSwatch color="#ff0000" onChange={onChange} label="Font colour" />);
    await click(container.querySelector("button")!);
    await settle();
    const custom = flyout()!.querySelector<HTMLInputElement>('input[type="color"]')!;
    expect(custom.getAttribute("aria-label")).toBe("More colours...");
    expect(custom.value).toBe("#ff0000");
    setInputValue(custom, "#336699");
    expect(onChange).toHaveBeenCalledWith("#336699");
    expect(flyout()).not.toBeNull();
  });

  it("customLabel renames the custom row", async () => {
    render(<ColorSwatch color="#ff0000" customLabel="Custom..." onChange={() => {}} label="Font colour" />);
    await click(container.querySelector("button")!);
    await settle();
    expect(flyout()!.querySelector('input[type="color"]')!.getAttribute("aria-label")).toBe("Custom...");
  });

  it("the hex field commits a valid colour on Enter and closes", async () => {
    const onChange = vi.fn();
    render(<ColorSwatch color="#ff0000" onChange={onChange} label="Font colour" />);
    await click(container.querySelector("button")!);
    await settle();
    const hex = flyout()!.querySelector<HTMLInputElement>('input[aria-label="Hex colour"]')!;
    expect(hex.value).toBe("#ff0000");
    setInputValue(hex, "12ab34");
    expect(onChange).not.toHaveBeenCalled();
    key(hex, "Enter");
    expect(onChange).toHaveBeenCalledWith("#12ab34");
    expect(flyout()).toBeNull();
  });

  it("the hex field refuses an invalid colour (aria-invalid, no onChange, stays open)", async () => {
    const onChange = vi.fn();
    render(<ColorSwatch color="#ff0000" onChange={onChange} label="Font colour" />);
    await click(container.querySelector("button")!);
    await settle();
    const hex = flyout()!.querySelector<HTMLInputElement>('input[aria-label="Hex colour"]')!;
    setInputValue(hex, "#12zz34");
    expect(hex.getAttribute("aria-invalid")).toBe("true");
    key(hex, "Enter");
    expect(onChange).not.toHaveBeenCalled();
    expect(flyout()).not.toBeNull();
  });

  it("moreAction closes the popover, then runs", async () => {
    const onSelect = vi.fn();
    render(
      <ColorSwatch
        color="#ff0000"
        moreAction={{ label: "More fill options...", onSelect, testId: "more-fill" }}
        onChange={() => {}}
        label="Fill colour"
      />,
    );
    await click(container.querySelector("button")!);
    await settle();
    await click(document.querySelector("[data-testid='more-fill']")!);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(flyout()).toBeNull();
  });

  it("moreAction asks to close BEFORE the action runs (it usually opens a dialog)", async () => {
    const anchor = document.createElement("button");
    document.body.appendChild(anchor);
    const onClose = vi.fn();
    const onSelect = vi.fn();
    render(
      <ColorPopover
        anchorEl={anchor}
        open
        onClose={onClose}
        value="#ff0000"
        onChange={() => {}}
        moreAction={{ label: "More fill options...", onSelect, testId: "more-fill" }}
      />,
    );
    await settle();
    await click(document.querySelector("[data-testid='more-fill']")!);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(onSelect.mock.invocationCallOrder[0]);
  });
});

describe("ColorPopover — keyboard and focus", () => {
  it("opens with focus on the selected swatch", async () => {
    render(<ColorSwatch color="#0070c0" onChange={() => {}} label="Font colour" />);
    await click(container.querySelector("button")!);
    await settle();
    expect(document.activeElement).toBe(swatchNamed("Blue"));
    // Roving tabindex: exactly one swatch is a tab stop.
    expect(swatches().filter((s) => s.tabIndex === 0)).toEqual([swatchNamed("Blue")]);
  });

  it("with nothing selected, focus starts on the first swatch", async () => {
    render(<ColorSwatch color="#123456" onChange={() => {}} label="Font colour" />);
    await click(container.querySelector("button")!);
    await settle();
    expect(document.activeElement).toBe(swatches()[0]);
  });

  it("arrows walk the swatches as one ten-wide grid; Home/End jump", async () => {
    render(<ColorSwatch color="#123456" onChange={() => {}} label="Font colour" />);
    await click(container.querySelector("button")!);
    await settle();
    const all = swatches();
    key(document.activeElement!, "ArrowRight");
    expect(document.activeElement).toBe(all[1]);
    key(document.activeElement!, "ArrowDown");
    expect(document.activeElement).toBe(all[11]); // base row -> first tint row
    key(document.activeElement!, "ArrowDown");
    expect(document.activeElement).toBe(all[21]); // tints -> standard row
    key(document.activeElement!, "ArrowDown");
    expect(document.activeElement).toBe(all[21]); // bottom edge: stays
    key(document.activeElement!, "ArrowLeft");
    expect(document.activeElement).toBe(all[20]);
    key(document.activeElement!, "Home");
    expect(document.activeElement).toBe(all[0]);
    key(document.activeElement!, "End");
    expect(document.activeElement).toBe(all[29]);
    // The roving stop follows focus.
    expect(all[29].tabIndex).toBe(0);
    expect(all[0].tabIndex).toBe(-1);
  });

  it("Escape closes and returns focus to the swatch button", async () => {
    render(<ColorSwatch color="#0070c0" onChange={() => {}} label="Font colour" />);
    const btn = container.querySelector("button")!;
    await click(btn);
    await settle();
    key(document.activeElement!, "Escape");
    expect(flyout()).toBeNull();
    expect(document.activeElement).toBe(btn);
  });

  it("a pick returns focus to the swatch button", async () => {
    render(<ColorSwatch color="#0070c0" onChange={() => {}} label="Font colour" />);
    const btn = container.querySelector("button")!;
    await click(btn);
    await settle();
    await click(document.activeElement!);
    expect(flyout()).toBeNull();
    expect(document.activeElement).toBe(btn);
  });

  it("reopening starts on the selected swatch again, not where focus last was", async () => {
    render(<ColorSwatch color="#0070c0" onChange={() => {}} label="Font colour" />);
    const btn = container.querySelector("button")!;
    await click(btn);
    await settle();
    key(document.activeElement!, "Home");
    key(document.activeElement!, "Escape");
    await click(btn);
    await settle();
    expect(document.activeElement).toBe(swatchNamed("Blue"));
  });
});

describe("ColorPopover — standalone", () => {
  it("is controlled by open/onClose and reloads the palette on every open", async () => {
    const anchor = document.createElement("button");
    document.body.appendChild(anchor);
    const onClose = vi.fn();
    render(<ColorPopover anchorEl={anchor} open onClose={onClose} value="#ff0000" onChange={() => {}} />);
    await settle();
    expect(flyout()!.getAttribute("aria-label")).toBe("Colours");
    expect(swatches()).toHaveLength(30);
    render(<ColorPopover anchorEl={anchor} open={false} onClose={onClose} value="#ff0000" onChange={() => {}} />);
    expect(flyout()).toBeNull();
    render(<ColorPopover anchorEl={anchor} open onClose={onClose} value="#ff0000" onChange={() => {}} />);
    await settle();
    expect(paletteMock).toHaveBeenCalledTimes(2);
    key(document.activeElement!, "Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
