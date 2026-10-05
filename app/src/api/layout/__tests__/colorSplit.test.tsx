// Tests for ColorSwatch's SPLIT mode (CONTRACT 6.7): Excel's Font Color / Fill
// Color button. The face half APPLIES the colour shown on its bar (`onApply`;
// the caller passes the LAST colour applied as `color`), a separate chevron
// half opens the palette. Pinned here, half by half:
//
//   - two named halves in one `.split` wrapper: the face is `testId` and is
//     NOT a popup trigger; the chevron is `chevronTestId`, "<label> options",
//     aria-haspopup="dialog" + aria-expanded;
//   - the palette drops under the WHOLE control (the wrapper is the anchor),
//     and a press on either half while it is open is not an outside press;
//   - keyboard: both halves are tab stops, Enter on the face is a native click,
//     ArrowDown/ArrowUp on either half open the palette, and Escape or a pick
//     hand focus back to the HALF THAT OPENED IT (SplitMenuButton's rule);
//   - "No Fill" / "Automatic": the palette's automatic row, first, with its own
//     test id, never confused with an apply;
//   - disabled is SplitMenuButton's aria-disabled idiom: both halves stay
//     focusable (so a tooltip can say why), look disabled, and do nothing;
//     the colour bar is data and keeps its hue.
//
// The default (non-split) ColorSwatch is pinned by color.test.tsx; the one
// structural fact checked here is that it did NOT turn into a split.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const { paletteMock } = vi.hoisted(() => ({ paletteMock: vi.fn() }));

// The theme palette is a Tauri round-trip in the app (see color.test.tsx).
vi.mock("../../theme", () => ({ getThemeColorPalette: paletteMock }));

import { SurfaceLayoutProvider, bandLayout, panelLayout, type SurfaceLayout } from "../context";
import { DISABLED_OPACITY } from "../primitives/disabled";
import { ColorSwatch, type ColorSwatchProps } from "../primitives/Color";
import { declared, hardcodedColours, ruleBodies } from "./formControlsKit";

// ============================================================================
// Fixtures + harness
// ============================================================================

const SLOTS = ["bg1", "tx1", "bg2", "tx2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6"];
const BASE_HEX = ["#ffffff", "#000000", "#e7e6e6", "#44546a", "#4472c4", "#ed7d31", "#a5a5a5", "#ffc000", "#5b9bd5", "#70ad47"];
const THEME_PALETTE = SLOTS.map((slot, i) => ({ slot, tint: 0, resolvedColor: BASE_HEX[i], label: `Theme ${slot}` }));

const GREY = "grayscale(1)";
const FADED = String(DISABLED_OPACITY);

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

function render(node: React.ReactNode, layout: SurfaceLayout = bandLayout()): void {
  act(() => {
    root.render(<SurfaceLayoutProvider value={layout}>{node}</SurfaceLayoutProvider>);
  });
}

/**
 * Flush the palette promise and the deferred focus-on-open, inside act. TWO
 * acts: a palette opened by a key press or a mount (a synchronous act) resolves
 * its theme promise inside the first one, whose render React flushes only when
 * that act ends -- and only that render schedules the focus timer, which the
 * second act then lets fire.
 */
async function settle(): Promise<void> {
  for (let round = 0; round < 2; round++) {
    await act(async () => {
      for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

/** A press that precedes a click (what the Popover's outside-press check hears). */
function mouseDown(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  });
}

function key(el: Element, k: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
  act(() => {
    el.dispatchEvent(event);
  });
  return event;
}

function byTestId<T extends HTMLElement = HTMLButtonElement>(id: string): T {
  const el = document.querySelector<T>(`[data-testid='${id}']`);
  if (!el) throw new Error(`no element with data-testid "${id}"`);
  return el;
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

/** Pin an element's box, so a test can tell WHICH element the palette was
 *  positioned against (jsdom lays nothing out: every rect is zeros). */
function pinRect(el: Element, left: number, width: number): void {
  Object.defineProperty(el, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ left, right: left + width, top: 10, bottom: 38, width, height: 28, x: left, y: 10, toJSON: () => ({}) }),
  });
}

const Icon = (): React.ReactElement => (
  <svg data-testid="fc-icon" width="20" height="20" viewBox="0 0 24 24">
    <rect x="4" y="4" width="16" height="16" fill="currentColor" />
  </svg>
);

/** Excel's Fill Color: the bar shows the last fill applied (yellow by default). */
function FillColor(props: Partial<ColorSwatchProps>): React.ReactElement {
  return (
    <>
      <ColorSwatch
        split
        variant="bar"
        icon={<Icon />}
        color="#ffff00"
        label="Fill Color"
        testId="fill"
        chevronTestId="fill-options"
        onApply={() => undefined}
        onChange={() => undefined}
        {...props}
      />
      <input data-testid="elsewhere" />
    </>
  );
}

// ============================================================================
// Structure
// ============================================================================

describe("ColorSwatch split — structure", () => {
  it("is two named halves in one wrapper: the face applies, the chevron opens the palette", () => {
    render(<FillColor />);
    const main = byTestId("fill");
    const chevron = byTestId("fill-options");
    expect(main.tagName).toBe("BUTTON");
    expect(chevron.tagName).toBe("BUTTON");
    expect(main.parentElement).toBe(chevron.parentElement);
    expect(main.parentElement!.classList.contains("split")).toBe(true);

    expect(main.getAttribute("aria-label")).toBe("Fill Color");
    // The face does not open anything, so it must not announce a popup.
    expect(main.hasAttribute("aria-haspopup")).toBe(false);
    expect(main.hasAttribute("aria-expanded")).toBe(false);

    expect(chevron.getAttribute("aria-label")).toBe("Fill Color options");
    expect(chevron.getAttribute("aria-haspopup")).toBe("dialog");
    expect(chevron.getAttribute("aria-expanded")).toBe("false");
  });

  it("the face carries the bar of `color` (the caller's LAST applied colour); the chevron carries none", () => {
    render(<FillColor color="#c00000" />);
    const bar = byTestId("fill").querySelector<HTMLElement>("[data-colour-data]")!;
    expect(bar).not.toBeNull();
    expect(bar.style.background).toContain("rgb(192, 0, 0)");
    expect(byTestId("fill").querySelector("[data-testid='fc-icon']")).not.toBeNull();
    expect(byTestId("fill-options").querySelector("[data-colour-data]")).toBeNull();
  });

  it("null (No Fill last applied) paints no guessed colour on the bar", () => {
    render(<FillColor color={null} />);
    const bar = byTestId("fill").querySelector<HTMLElement>("[data-colour-data]")!;
    expect(bar.style.background).toBe("transparent");
  });

  it("geometry: the face keeps the bar's 32x28 (md) / 28x24 (sm); the chevron half is 16px wide", () => {
    render(
      <>
        <ColorSwatch split variant="bar" icon={<Icon />} color="#000000" label="A" testId="a" chevronTestId="a-o" onApply={() => {}} onChange={() => {}} />
        <ColorSwatch split size="sm" variant="bar" icon={<Icon />} color="#000000" label="B" testId="b" chevronTestId="b-o" onApply={() => {}} onChange={() => {}} />
        <ColorSwatch split color="#000000" label="C" testId="c" chevronTestId="c-o" onApply={() => {}} onChange={() => {}} />
      </>,
    );
    expect(byTestId("a").style.width).toBe("32px");
    expect(byTestId("a").style.height).toBe("28px");
    expect(byTestId("a-o").style.width).toBe("16px");
    expect(byTestId("a-o").style.height).toBe("28px");
    expect(byTestId("b").style.width).toBe("28px");
    expect(byTestId("b").style.height).toBe("24px");
    expect(byTestId("b-o").style.height).toBe("24px");
    expect(byTestId("b").querySelector<HTMLElement>("[data-colour-data]")!.style.height).toBe("3px");
    // The chip face splits too.
    expect(byTestId("c").style.width).toBe("28px");
    expect(byTestId("c").querySelector<HTMLElement>("[data-colour-data]")!.style.width).toBe("16px");
  });

  it("chevronLabel renames the chevron half", () => {
    render(<FillColor chevronLabel="More fill colours" />);
    expect(byTestId("fill-options").getAttribute("aria-label")).toBe("More fill colours");
  });

  it("without `split` it is still ONE button that opens the palette (the default is untouched)", async () => {
    const onApply = vi.fn();
    render(<ColorSwatch variant="bar" icon={<Icon />} color="#ffff00" label="Fill Color" testId="fill" onApply={onApply} onChange={() => {}} />);
    expect(container.querySelector(".split")).toBeNull();
    expect(container.querySelectorAll("button")).toHaveLength(1);
    await click(byTestId("fill"));
    expect(flyout()).not.toBeNull();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("`native` wins over `split`: the OS picker input, no halves", () => {
    render(<FillColor native />);
    expect(container.querySelector('input[type="color"]')).not.toBeNull();
    expect(container.querySelector(".split")).toBeNull();
  });

  it.each([
    ["band", bandLayout()],
    ["panel", panelLayout(300)],
  ])("paints no hardcoded colour in the %s, closed or open (the colours are data)", async (_name, layout) => {
    render(<FillColor allowAutomatic automaticLabel="No Fill" automaticChip="none" />, layout);
    expect(hardcodedColours(container)).toEqual([]);
    await click(byTestId("fill-options"));
    await settle();
    expect(hardcodedColours(flyout()!)).toEqual([]);
    expect(hardcodedColours(container)).toEqual([]);
  });
});

// ============================================================================
// Pointer
// ============================================================================

describe("ColorSwatch split — pointer", () => {
  it("the face runs onApply and opens nothing (the palette is not even loaded)", async () => {
    const onApply = vi.fn();
    const onChange = vi.fn();
    render(<FillColor onApply={onApply} onChange={onChange} />);
    await click(byTestId("fill"));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
    expect(flyout()).toBeNull();
    expect(paletteMock).not.toHaveBeenCalled();
  });

  it("the chevron opens the palette, with Excel's words, and does not apply", async () => {
    const onApply = vi.fn();
    render(<FillColor onApply={onApply} />);
    await click(byTestId("fill-options"));
    await settle();
    const pop = flyout()!;
    expect(pop).not.toBeNull();
    expect(pop.getAttribute("aria-label")).toBe("Fill Color");
    expect(byTestId("fill-options").getAttribute("aria-expanded")).toBe("true");
    expect(pop.textContent).toContain("Theme Colors");
    expect(pop.textContent).toContain("Standard Colors");
    expect(pop.textContent).toContain("More Colors...");
    expect(onApply).not.toHaveBeenCalled();
    // The popover body's test id follows the FACE's id, like every swatch's.
    expect(document.querySelector("[data-testid='fill-popover']")).not.toBeNull();
  });

  it("the palette drops under the WHOLE control, not under the chevron", async () => {
    render(<FillColor />);
    const wrapper = byTestId("fill").parentElement!;
    pinRect(wrapper, 100, 48);
    pinRect(byTestId("fill"), 100, 32);
    pinRect(byTestId("fill-options"), 132, 16);
    await click(byTestId("fill-options"));
    await settle();
    expect(flyout()!.style.left).toBe("100px");
  });

  it("a second click on the chevron closes it", async () => {
    render(<FillColor />);
    await click(byTestId("fill-options"));
    await settle();
    mouseDown(byTestId("fill-options"));
    await click(byTestId("fill-options"));
    expect(flyout()).toBeNull();
    expect(byTestId("fill-options").getAttribute("aria-expanded")).toBe("false");
  });

  it("a click on the face while the palette is open closes it and applies", async () => {
    const onApply = vi.fn();
    render(<FillColor onApply={onApply} />);
    await click(byTestId("fill-options"));
    await settle();
    // Not an outside press: the face is part of the anchor.
    mouseDown(byTestId("fill"));
    expect(flyout()).not.toBeNull();
    await click(byTestId("fill"));
    expect(flyout()).toBeNull();
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it("an outside press dismisses it without applying", async () => {
    const onApply = vi.fn();
    render(<FillColor onApply={onApply} />);
    await click(byTestId("fill-options"));
    await settle();
    mouseDown(byTestId("elsewhere"));
    expect(flyout()).toBeNull();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("a pick reports onChange (the caller records it as the new LAST colour) and never onApply", async () => {
    const onApply = vi.fn();
    const onChange = vi.fn();
    render(<FillColor onApply={onApply} onChange={onChange} />);
    await click(byTestId("fill-options"));
    await settle();
    await click(swatchNamed("Red"));
    expect(onChange).toHaveBeenCalledWith("#ff0000");
    expect(onApply).not.toHaveBeenCalled();
    expect(flyout()).toBeNull();
  });

  it("a theme pick keeps the SLOT and tint (onThemeColorChange), never flattened", async () => {
    const onChange = vi.fn();
    const onTheme = vi.fn();
    render(<FillColor onChange={onChange} onThemeColorChange={onTheme} />);
    await click(byTestId("fill-options"));
    await settle();
    await click(swatchNamed("Theme accent2"));
    expect(onTheme).toHaveBeenCalledWith("accent2", 0, "#ed7d31");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("a caller's onClick runs first on the face; preventDefault() keeps it from applying", async () => {
    const onApply = vi.fn();
    const onClick = vi.fn((e: React.MouseEvent) => e.preventDefault());
    render(<FillColor onApply={onApply} onClick={onClick} />);
    await click(byTestId("fill"));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
  });

  it("controlled: `open` shows the palette, and the chevron ASKS to close through onOpenChange", async () => {
    const onOpenChange = vi.fn();
    render(<FillColor open onOpenChange={onOpenChange} />);
    await settle();
    expect(flyout()).not.toBeNull();
    expect(byTestId("fill-options").getAttribute("aria-expanded")).toBe("true");
    await click(byTestId("fill-options"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

// ============================================================================
// "No Fill" / "Automatic" — the palette's automatic row
// ============================================================================

describe("ColorSwatch split — No Fill / Automatic", () => {
  it("'No Fill' is the FIRST row, outlined (no colour), with its own test id, and runs onAutomatic only", async () => {
    const onAutomatic = vi.fn();
    const onApply = vi.fn();
    const onChange = vi.fn();
    render(
      <FillColor
        allowAutomatic
        automaticLabel="No Fill"
        automaticChip="none"
        onAutomatic={onAutomatic}
        onApply={onApply}
        onChange={onChange}
      />,
    );
    await click(byTestId("fill-options"));
    await settle();
    const row = byTestId("fill-popover-automatic");
    expect(row.textContent).toBe("No Fill");
    expect(row.getAttribute("aria-pressed")).toBe("false");
    // First in the palette, ahead of Theme Colors.
    expect(byTestId("fill-popover").firstElementChild).toBe(row);
    await click(row);
    expect(onAutomatic).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(flyout()).toBeNull();
  });

  it("after No Fill the caller passes color=null: the bar is empty and the row shows as the current choice", async () => {
    render(<FillColor color={null} allowAutomatic automaticLabel="No Fill" automaticChip="none" />);
    expect(byTestId("fill").querySelector<HTMLElement>("[data-colour-data]")!.style.background).toBe("transparent");
    await click(byTestId("fill-options"));
    await settle();
    expect(byTestId("fill-popover-automatic").getAttribute("aria-pressed")).toBe("true");
    expect(swatches().filter((s) => s.getAttribute("aria-pressed") === "true")).toEqual([]);
  });

  // Live Excel 365, 2026-10-04 (a fresh hidden instance, menus opened through
  // UI Automation): Font Color lists "Automatic" FIRST, above Theme Colors,
  // but Fill Color lists "No Fill" AFTER Standard Colors, just above "More
  // Colors...". The default stays first (CONTRACT 6.7 / 3.5); afterColors is
  // Excel's Fill Color order, for the caller to choose.
  it("automaticPlacement='afterColors' puts No Fill after Standard Colors and before More Colors... (Excel's Fill Color)", async () => {
    const onAutomatic = vi.fn();
    render(
      <FillColor
        allowAutomatic
        automaticLabel="No Fill"
        automaticChip="none"
        automaticPlacement="afterColors"
        onAutomatic={onAutomatic}
      />,
    );
    await click(byTestId("fill-options"));
    await settle();
    const body = byTestId("fill-popover");
    const row = byTestId("fill-popover-automatic");
    const standard = Array.from(body.querySelectorAll("[role='group']")).find((g) =>
      g.textContent?.includes("Standard Colors"),
    )!;
    const custom = byTestId<HTMLInputElement>("fill-popover-custom");
    expect(body.firstElementChild).not.toBe(row);
    expect(standard.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(row.compareDocumentPosition(custom) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Focus still opens on the swatches, and the row still works.
    expect(document.activeElement?.hasAttribute("data-colour-swatch")).toBe(true);
    await click(row);
    expect(onAutomatic).toHaveBeenCalledTimes(1);
    expect(flyout()).toBeNull();
  });

  it("automaticPlacement='first' (the default) keeps Automatic above Theme Colors (Excel's Font Color)", async () => {
    render(<FillColor allowAutomatic automaticPlacement="first" />);
    await click(byTestId("fill-options"));
    await settle();
    expect(byTestId("fill-popover").firstElementChild).toBe(byTestId("fill-popover-automatic"));
  });

  it("'Automatic' (Font Color) keeps the text-coloured chip", async () => {
    render(
      <ColorSwatch
        split
        variant="bar"
        icon={<Icon />}
        color="#ff0000"
        label="Font Color"
        testId="font"
        chevronTestId="font-options"
        allowAutomatic
        onApply={() => {}}
        onChange={() => {}}
      />,
    );
    await click(byTestId("font-options"));
    await settle();
    const row = byTestId("font-popover-automatic");
    expect(row.textContent).toBe("Automatic");
    const chip = row.querySelector("span")!;
    expect(declared(chip, "background")).toMatch(/currentcolor/i);
  });
});

// ============================================================================
// Keyboard and focus
// ============================================================================

describe("ColorSwatch split — keyboard", () => {
  it("both halves are tab stops (native, enabled buttons)", () => {
    render(<FillColor />);
    for (const half of [byTestId("fill"), byTestId("fill-options")]) {
      expect(half.tabIndex).toBe(0);
      expect((half as HTMLButtonElement).disabled).toBe(false);
    }
  });

  it("Enter on the face is left to the native button (it applies) and opens nothing", () => {
    render(<FillColor />);
    const enter = key(byTestId("fill"), "Enter");
    expect(enter.defaultPrevented).toBe(false);
    expect(flyout()).toBeNull();
  });

  it("ArrowDown on the FACE opens the palette in it; Escape hands focus back to the face", async () => {
    render(<FillColor color="#ff0000" />);
    act(() => byTestId("fill").focus());
    const down = key(byTestId("fill"), "ArrowDown");
    expect(down.defaultPrevented).toBe(true);
    await settle();
    expect(flyout()).not.toBeNull();
    expect(document.activeElement).toBe(swatchNamed("Red"));
    key(document.activeElement!, "Escape");
    expect(flyout()).toBeNull();
    expect(document.activeElement).toBe(byTestId("fill"));
  });

  it("ArrowDown or ArrowUp on the chevron opens it too", async () => {
    render(<FillColor />);
    key(byTestId("fill-options"), "ArrowUp");
    await settle();
    expect(flyout()).not.toBeNull();
    key(document.activeElement!, "Escape");
    key(byTestId("fill-options"), "ArrowDown");
    await settle();
    expect(flyout()).not.toBeNull();
  });

  it("Escape from a chevron-opened palette returns focus to the CHEVRON, not the face", async () => {
    render(<FillColor />);
    await click(byTestId("fill-options"));
    await settle();
    expect(flyout()!.contains(document.activeElement)).toBe(true);
    key(document.activeElement!, "Escape");
    expect(flyout()).toBeNull();
    expect(document.activeElement).toBe(byTestId("fill-options"));
  });

  it("a pick from a chevron-opened palette returns focus to the chevron", async () => {
    render(<FillColor />);
    await click(byTestId("fill-options"));
    await settle();
    await click(document.activeElement!);
    expect(flyout()).toBeNull();
    expect(document.activeElement).toBe(byTestId("fill-options"));
  });

  it("No Fill from a chevron-opened palette returns focus to the chevron too", async () => {
    render(<FillColor allowAutomatic automaticLabel="No Fill" automaticChip="none" />);
    await click(byTestId("fill-options"));
    await settle();
    await click(byTestId("fill-popover-automatic"));
    expect(flyout()).toBeNull();
    expect(document.activeElement).toBe(byTestId("fill-options"));
  });

  it("a palette opened by the caller (controlled) returns focus to the chevron on Escape", async () => {
    function Controlled(): React.ReactElement {
      const [open, setOpen] = React.useState(true);
      return <FillColor open={open} onOpenChange={setOpen} />;
    }
    render(<Controlled />);
    await settle();
    expect(flyout()!.contains(document.activeElement)).toBe(true);
    key(document.activeElement!, "Escape");
    expect(flyout()).toBeNull();
    expect(document.activeElement).toBe(byTestId("fill-options"));
  });
});

// ============================================================================
// Disabled — SplitMenuButton's aria-disabled idiom
// ============================================================================

describe("ColorSwatch split — disabled", () => {
  it("both halves announce it, apply nothing and open nothing -- but stay reachable", async () => {
    const onApply = vi.fn();
    render(<FillColor disabled onApply={onApply} />);
    const main = byTestId("fill");
    const chevron = byTestId("fill-options");
    expect(main.getAttribute("aria-disabled")).toBe("true");
    expect(chevron.getAttribute("aria-disabled")).toBe("true");
    // NOT natively disabled: a native disabled button shows no tooltip and
    // cannot be focused, so the REASON it is disabled could never be read.
    expect((main as HTMLButtonElement).disabled).toBe(false);
    expect((chevron as HTMLButtonElement).disabled).toBe(false);
    await click(main);
    expect(onApply).not.toHaveBeenCalled();
    await click(chevron);
    expect(flyout()).toBeNull();
    key(main, "ArrowDown");
    key(chevron, "ArrowDown");
    await settle();
    expect(flyout()).toBeNull();
    expect(paletteMock).not.toHaveBeenCalled();
  });

  it("both halves fade and grey their icons; the colour bar is data and keeps its hue", () => {
    render(<FillColor disabled color="#c00000" />);
    const main = byTestId("fill");
    const chevron = byTestId("fill-options");
    expect(getComputedStyle(main).opacity).toBe(FADED);
    expect(getComputedStyle(chevron).opacity).toBe(FADED);
    expect(getComputedStyle(main).cursor).toBe("default");
    expect(getComputedStyle(main.querySelector("[data-testid='fc-icon']")!).filter).toBe(GREY);
    expect(getComputedStyle(chevron.querySelector("svg")!).filter).toBe(GREY);
    const bar = main.querySelector<HTMLElement>("[data-colour-data]")!;
    for (let n: Element | null = bar; n && n !== container; n = n.parentElement) {
      expect(getComputedStyle(n).filter).not.toBe(GREY);
    }
    expect(bar.style.background).toContain("rgb(192, 0, 0)");
  });

  it("a disabled half shows no hover or press tint (the soft-disabled rule resets it)", () => {
    render(<FillColor disabled />);
    for (const half of [byTestId("fill"), byTestId("fill-options")]) {
      const bodies = ruleBodies(half, '[aria-disabled="true"]:hover');
      expect(bodies.length).toBeGreaterThan(0);
      expect(bodies.join(" ")).toContain("--button-bg");
    }
  });

  it("an enabled split carries no aria-disabled and full strength", () => {
    render(<FillColor />);
    for (const half of [byTestId("fill"), byTestId("fill-options")]) {
      expect(half.hasAttribute("aria-disabled")).toBe(false);
      expect(getComputedStyle(half).opacity).not.toBe(FADED);
    }
  });

  it("without onApply the FACE is aria-disabled (never a live button that does nothing); the chevron still works", async () => {
    render(<FillColor onApply={undefined} />);
    expect(byTestId("fill").getAttribute("aria-disabled")).toBe("true");
    expect(byTestId("fill-options").hasAttribute("aria-disabled")).toBe(false);
    await click(byTestId("fill"));
    expect(flyout()).toBeNull();
    await click(byTestId("fill-options"));
    await settle();
    expect(flyout()).not.toBeNull();
  });
});

// ============================================================================
// Disabled WHILE open (fix-kit review, 2026-10-04)
// ============================================================================

describe("ColorSwatch split — disabled while its palette is open", () => {
  it("the palette closes, aria-expanded stays false, and re-enabling does not reopen it", async () => {
    render(<FillColor />);
    await click(byTestId("fill-options"));
    await settle();
    expect(flyout()).not.toBeNull();

    render(<FillColor disabled />);
    await settle();
    expect(flyout()).toBeNull();
    expect(byTestId("fill-options").getAttribute("aria-expanded")).toBe("false");

    render(<FillColor />);
    await settle();
    // The defect: `open` was still true, so the palette popped back by itself.
    expect(flyout()).toBeNull();
    expect(byTestId("fill-options").getAttribute("aria-expanded")).toBe("false");

    // Positive control: enabled again, the chevron opens it as usual.
    await click(byTestId("fill-options"));
    await settle();
    expect(flyout()).not.toBeNull();
  });

  it("controlled: disabling asks the caller to close through onOpenChange(false)", async () => {
    const onOpenChange = vi.fn();
    render(<FillColor open onOpenChange={onOpenChange} />);
    await settle();
    expect(flyout()).not.toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();

    render(<FillColor open disabled onOpenChange={onOpenChange} />);
    await settle();
    expect(flyout()).toBeNull();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(byTestId("fill-options").getAttribute("aria-expanded")).toBe("false");
  });

  it("the one-button form: disabling while open closes it and re-enabling does not reopen it", async () => {
    const one = (disabled: boolean) => (
      <ColorSwatch color="#ff0000" label="Tab Color" testId="tab" onChange={() => undefined} disabled={disabled} />
    );
    render(one(false));
    await click(byTestId("tab"));
    await settle();
    expect(flyout()).not.toBeNull();
    render(one(true));
    await settle();
    expect(flyout()).toBeNull();
    expect(byTestId("tab").getAttribute("aria-expanded")).toBe("false");
    render(one(false));
    await settle();
    expect(flyout()).toBeNull();
    expect(byTestId("tab").getAttribute("aria-expanded")).toBe("false");
  });
});
