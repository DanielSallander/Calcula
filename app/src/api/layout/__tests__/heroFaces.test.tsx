// Tests for the Excel Home-tab button shapes added on 2026-10-04 (CONTRACT
// 6.1 / 6.2): CommandButton `labelLines={2}` (Excel's "Conditional /
// Formatting v"), and SplitMenuButton's two new faces -- "labelled" (Excel's
// MEDIUM split: icon + label | chevron, e.g. "Merge & Center v") and "hero"
// (Excel's LARGE split: the picture on top runs the command, the label +
// chevron below opens the menu, e.g. Paste / Insert / Delete).
//
// The ribbon's fill rule is arithmetic (everything in a cluster is 61px or
// 28 + 5 + 28), so every height is pinned in px AND the token chain is added
// up: a hero one pixel off clips in the band or sits off the row of heroes
// beside it. The SplitMenuButton keyboard / aria-disabled / anchoring model is
// pinned for the icon face in menu.test.tsx; the cases here prove the new
// faces did not lose any of it.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SurfaceLayoutProvider, bandLayout, panelLayout, type SurfaceLayout } from "../context";
import { CommandButton, splitHeroLabel } from "../primitives/Button";
import { MenuItem, SplitMenuButton } from "../primitives/Menu";
import { DISABLED_OPACITY } from "../primitives/disabled";
import {
  HERO_ICON_SIZE,
  HERO_ICON_SLOT,
  HERO_LABEL_GAP,
  HERO_LABEL_LINE_HEIGHT,
  HERO_PAD_Y,
  HERO_SPLIT_TOP_HEIGHT,
  HERO_SPLIT_TOP_HEIGHT_TWO_LINE,
  HERO_TWO_LINE_GAP,
  HERO_TWO_LINE_PAD_Y,
  TALL_CONTROL_HEIGHT,
} from "../tokens";
import { declared, hardcodedColours } from "./colourScan";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
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

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function mouseDown(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  });
}

function key(el: Element, k: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
  act(() => {
    el.dispatchEvent(event);
  });
  return event;
}

function byTestId<T extends Element = HTMLElement>(id: string): T {
  const el = document.querySelector(`[data-testid='${id}']`);
  if (!el) throw new Error(`no element for ${id}`);
  return el as T;
}

function menu(): HTMLElement | null {
  return document.querySelector("[role='menu']");
}

function px(value: string): number {
  return Number.parseFloat(value);
}

function tooltip(): HTMLElement | null {
  return document.querySelector("[role='tooltip']");
}

/** React derives onMouseEnter from a bubbling mouseover (from outside). */
function hover(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null }));
  });
}

function unhover(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
  });
}

function wait(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

const Icon = ({ size = 30 }: { size?: number }) => (
  <svg data-testid="icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden>
    <rect x="3" y="3" width="18" height="18" rx="2" fill="currentColor" />
  </svg>
);

// ============================================================================
// The token chain
// ============================================================================

describe("hero geometry tokens", () => {
  it("every hero shape adds up to the 61px content box", () => {
    // One-line hero, unchanged since the Clusters redesign.
    expect(HERO_PAD_Y + HERO_ICON_SLOT + HERO_LABEL_GAP + HERO_LABEL_LINE_HEIGHT + HERO_PAD_Y).toBe(
      TALL_CONTROL_HEIGHT,
    );
    // Two-line hero: the 30px icon is kept, the 34px slot is not.
    expect(HERO_ICON_SIZE).toBe(30);
    expect(HERO_TWO_LINE_PAD_Y).toBe(2);
    expect(
      HERO_TWO_LINE_PAD_Y +
        HERO_ICON_SIZE +
        HERO_TWO_LINE_GAP +
        2 * HERO_LABEL_LINE_HEIGHT +
        HERO_TWO_LINE_PAD_Y,
    ).toBe(TALL_CONTROL_HEIGHT);
    // The split's two parts meet in the middle of the gap.
    expect(HERO_SPLIT_TOP_HEIGHT).toBe(41);
    expect(HERO_SPLIT_TOP_HEIGHT_TWO_LINE).toBe(32);
  });
});

// ============================================================================
// splitHeroLabel -- where Excel breaks a large button's label
// ============================================================================

describe("splitHeroLabel", () => {
  it.each([
    ["Conditional Formatting", true, ["Conditional", "Formatting"]],
    ["Format as Table", true, ["Format as", "Table"]],
    ["Cell Styles", true, ["Cell", "Styles"]],
    ["Sort & Filter", true, ["Sort &", "Filter"]],
    ["Find & Select", true, ["Find &", "Select"]],
    // One word: the word on line 1, the chevron alone on line 2 (Excel's Paste).
    ["Paste", true, ["Paste", ""]],
    ["  Insert  ", true, ["Insert", ""]],
  ] as const)("%s -> %j", (label, chevron, expected) => {
    expect(splitHeroLabel(label, chevron)).toEqual(expected);
  });

  it("balances the two lines, counting the chevron on the second", () => {
    // "Insert Sheet Rows": "Insert" / "Sheet Rows v" (12) ties "Insert Sheet" /
    // "Rows v" (12); the tie goes to the SHORTER second line, which carries
    // the chevron.
    expect(splitHeroLabel("Insert Sheet Rows", true)).toEqual(["Insert Sheet", "Rows"]);
    // Without a chevron nothing is added to line 2, so the balance moves.
    expect(splitHeroLabel("Format as Table", false)).toEqual(["Format", "as Table"]);
  });
});

// ============================================================================
// CommandButton labelLines
// ============================================================================

describe("CommandButton labelLines={2}", () => {
  it("band: icon 30 over two 13px lines inside 61 (pad 2, gap 1)", () => {
    render(
      <CommandButton
        icon={<Icon />}
        label="Conditional Formatting"
        chevron
        labelLines={2}
        data-testid="hero"
      />,
      bandLayout(),
    );
    const b = byTestId("hero");
    const cs = getComputedStyle(b);
    expect(cs.flexDirection).toBe("column");
    expect(cs.height).toBe("61px");
    expect(cs.padding).toBe("2px 10px");
    expect(cs.gap).toBe("1px");

    const [slot, label] = Array.from(b.children) as HTMLElement[];
    expect(slot.getAttribute("aria-hidden")).toBe("true");
    expect(getComputedStyle(slot).width).toBe("30px");
    expect(getComputedStyle(slot).height).toBe("30px");

    const lines = Array.from(label.querySelectorAll<HTMLElement>("[data-hero-line]"));
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(getComputedStyle(line).height).toBe("13px");
      expect(getComputedStyle(line).lineHeight).toBe("13px");
      expect(getComputedStyle(line).maxWidth).toBe("92px");
    }
    // The box adds up: padding + slot + gap + two lines + padding = 61.
    expect(
      px(cs.paddingTop) +
        px(getComputedStyle(slot).height) +
        px(cs.gap) +
        lines.reduce((sum, l) => sum + px(getComputedStyle(l).height), 0) +
        px(cs.paddingBottom),
    ).toBe(TALL_CONTROL_HEIGHT);
  });

  it("band: Excel's break, with the chevron after the LAST word", () => {
    render(
      <CommandButton icon={<Icon />} label="Conditional Formatting" chevron labelLines={2} data-testid="hero" />,
      bandLayout(),
    );
    const lines = Array.from(byTestId("hero").querySelectorAll<HTMLElement>("[data-hero-line]"));
    expect(lines[0].textContent?.trim()).toBe("Conditional");
    expect(lines[0].querySelector("svg")).toBeNull();
    expect(lines[1].textContent).toBe("Formatting");
    expect(lines[1].querySelector("svg")).not.toBeNull();
  });

  it("band: the button's text is still the WHOLE label, with its space", () => {
    // Its accessible name (and every E2E text match) must read
    // "Conditional Formatting", never "ConditionalFormatting".
    render(
      <CommandButton icon={<Icon />} label="Format as Table" chevron labelLines={2} data-testid="hero" />,
      bandLayout(),
    );
    expect(byTestId("hero").textContent).toBe("Format as Table");
  });

  it("band: a one-word label keeps BOTH lines (the chevron alone on the second)", () => {
    render(<CommandButton icon={<Icon />} label="Styles" chevron labelLines={2} data-testid="hero" />, bandLayout());
    const lines = Array.from(byTestId("hero").querySelectorAll<HTMLElement>("[data-hero-line]"));
    expect(lines).toHaveLength(2);
    expect(lines[0].textContent).toBe("Styles");
    expect(lines[1].textContent).toBe("");
    expect(lines[1].querySelector("svg")).not.toBeNull();
  });

  it("band: labelLines={1} and the default are the unchanged one-line hero", () => {
    render(
      <>
        <CommandButton icon={<Icon />} label="Paste" data-testid="default" />
        <CommandButton icon={<Icon />} label="Paste" labelLines={1} data-testid="one" />
      </>,
      bandLayout(),
    );
    for (const id of ["default", "one"]) {
      const b = byTestId(id);
      expect(getComputedStyle(b).padding).toBe("6px 10px");
      expect(getComputedStyle(b).gap).toBe("2px");
      expect(getComputedStyle(b.firstElementChild as HTMLElement).width).toBe("34px");
      expect(b.querySelectorAll("[data-hero-line]")).toHaveLength(0);
      expect(b.textContent).toBe("Paste");
    }
  });

  it("panel: labelLines changes nothing -- a standard 28px button", () => {
    render(<CommandButton icon={<Icon />} label="Conditional Formatting" chevron labelLines={2} data-testid="hero" />);
    const b = byTestId("hero");
    expect(b.style.height).toBe("28px");
    expect(b.textContent).toBe("Conditional Formatting");
    expect(b.querySelectorAll("[data-hero-line]")).toHaveLength(0);
  });

  it("band: a badge still sits in the (smaller) slot", () => {
    render(
      <CommandButton icon={<Icon />} label="Sort & Filter" badge={2} labelLines={2} chevron data-testid="hero" />,
      bandLayout(),
    );
    const slot = byTestId("hero").firstElementChild as HTMLElement;
    expect(slot.querySelector("[data-tone]")?.textContent).toBe("2");
  });

  it.each([
    ["band", bandLayout()],
    ["panel", panelLayout(300)],
  ])("paints no hardcoded colour in the %s", (_name, layout) => {
    render(
      <>
        <CommandButton icon={<Icon />} label="Conditional Formatting" chevron labelLines={2} />
        <CommandButton icon={<Icon />} label="Cell Styles" chevron labelLines={2} disabled />
      </>,
      layout,
    );
    expect(hardcodedColours(container)).toEqual([]);
  });
});

// ============================================================================
// SplitMenuButton face="hero" -- Excel's large split
// ============================================================================

function Paste({
  face = "hero",
  labelLines,
  disabled,
  onRun = () => undefined,
  onPick = () => undefined,
  label = "Paste",
}: {
  face?: "icon" | "labelled" | "hero";
  labelLines?: 1 | 2;
  disabled?: boolean;
  onRun?: () => void;
  onPick?: (id: string) => void;
  label?: string;
}): React.ReactElement {
  return (
    <>
      <SplitMenuButton
        face={face}
        labelLines={labelLines}
        icon={<Icon />}
        label={label}
        disabled={disabled}
        data-testid="main"
        chevronTestId="chevron"
        onClick={onRun}
      >
        <MenuItem testId="values" onSelect={() => onPick("values")}>
          Values
        </MenuItem>
        <MenuItem testId="formulas" onSelect={() => onPick("formulas")}>
          Formulas
        </MenuItem>
      </SplitMenuButton>
      <input data-testid="elsewhere" />
    </>
  );
}

describe("SplitMenuButton face='hero' in the band", () => {
  it("is one column: the picture part on top, the label + chevron part below", () => {
    render(<Paste />, bandLayout());
    const main = byTestId("main");
    const chevron = byTestId("chevron");
    const wrap = main.parentElement as HTMLElement;
    expect(chevron.parentElement).toBe(wrap);
    expect(wrap.tagName).toBe("SPAN");
    expect(wrap.classList.contains("split")).toBe(true);
    expect(getComputedStyle(wrap).flexDirection).toBe("column");
    expect(getComputedStyle(wrap).minWidth).toBe("58px");
    expect(main.classList.contains("split-main")).toBe(true);
    expect(chevron.classList.contains("split-chevron")).toBe(true);

    // The top part carries only the picture; its name is the command.
    expect(main.querySelector("[data-testid='icon']")).not.toBeNull();
    expect(main.textContent).toBe("");
    expect(main.getAttribute("aria-label")).toBe("Paste");
    // The bottom part shows the label and the chevron, and opens the menu.
    expect(chevron.textContent).toBe("Paste");
    expect(chevron.querySelector("svg")).not.toBeNull();
    expect(chevron.getAttribute("aria-label")).toBe("Paste options");
    expect(chevron.getAttribute("aria-haspopup")).toBe("menu");
  });

  it("one-line: 41 + 20 = 61, the icon and label on a plain hero's pixels", () => {
    render(<Paste />, bandLayout());
    const main = byTestId("main");
    const chevron = byTestId("chevron");
    const top = getComputedStyle(main);
    const bottom = getComputedStyle(chevron);
    expect(top.height).toBe("41px");
    expect(top.padding).toBe("6px 10px 1px");
    expect(bottom.height).toBe("20px");
    expect(bottom.padding).toBe("1px 10px 6px");
    expect(px(top.height) + px(bottom.height)).toBe(TALL_CONTROL_HEIGHT);
    // The icon slot is the plain hero's 34; the label line is its 13.
    const slot = main.firstElementChild as HTMLElement;
    expect(getComputedStyle(slot).height).toBe("34px");
    const line = chevron.querySelector<HTMLElement>("[data-hero-line]")!;
    expect(getComputedStyle(line).lineHeight).toBe("13px");
  });

  it("one hairline between the parts, and only the outer corners are round", () => {
    render(<Paste />, bandLayout());
    const main = byTestId("main");
    const chevron = byTestId("chevron");
    expect(declared(chevron, "box-shadow")).toContain("--control-divider");
    expect(declared(chevron, "box-shadow")).toContain("inset 0 1px 0");
    expect(declared(main, "border-bottom-left-radius")).toBe("0");
    expect(declared(main, "border-bottom-right-radius")).toBe("0");
    expect(declared(chevron, "border-top-left-radius")).toBe("0");
    expect(declared(chevron, "border-top-right-radius")).toBe("0");
  });

  it("each part is its own button, so each is highlighted on its own", () => {
    render(<Paste />, bandLayout());
    const main = byTestId("main");
    const chevron = byTestId("chevron");
    expect(main.tagName).toBe("BUTTON");
    expect(chevron.tagName).toBe("BUTTON");
    expect(main.contains(chevron)).toBe(false);
    // Both carry the shared control recipe, whose :hover tint is per element.
    expect(declared(main, "cursor")).toBe("pointer");
    expect(declared(chevron, "cursor")).toBe("pointer");
  });

  it("two-line: 32 + 29 = 61; a one-word label puts the chevron alone on line 2", () => {
    render(<Paste labelLines={2} />, bandLayout());
    const main = byTestId("main");
    const chevron = byTestId("chevron");
    expect(getComputedStyle(main).height).toBe("32px");
    expect(getComputedStyle(main).padding).toBe("2px 10px 0px");
    expect(getComputedStyle(chevron).height).toBe("29px");
    expect(getComputedStyle(chevron).padding).toBe("1px 10px 2px");
    expect(getComputedStyle(main.firstElementChild as HTMLElement).height).toBe("30px");
    const lines = Array.from(chevron.querySelectorAll<HTMLElement>("[data-hero-line]"));
    expect(lines).toHaveLength(2);
    expect(lines[0].textContent).toBe("Paste");
    expect(lines[1].textContent).toBe("");
    expect(lines[1].querySelector("svg")).not.toBeNull();
  });

  it("two-line with two words: Excel's break", () => {
    render(<Paste labelLines={2} label="Delete Cells" />, bandLayout());
    const lines = Array.from(byTestId("chevron").querySelectorAll<HTMLElement>("[data-hero-line]"));
    expect(lines[0].textContent?.trim()).toBe("Delete");
    expect(lines[1].textContent).toBe("Cells");
    expect(byTestId("chevron").textContent).toBe("Delete Cells");
  });

  it("the top part runs onClick; the bottom part opens the menu and focuses its first row", () => {
    const onRun = vi.fn();
    render(<Paste onRun={onRun} />, bandLayout());
    click(byTestId("main"));
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();
    click(byTestId("chevron"));
    expect(menu()).not.toBeNull();
    expect(byTestId("chevron").getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(byTestId("values"));
    expect(onRun).toHaveBeenCalledTimes(1);
  });

  it("keeps the split keyboard model: ArrowDown on the top part opens, Escape returns to it, Enter runs", () => {
    render(<Paste />, bandLayout());
    key(byTestId("main"), "ArrowDown");
    expect(document.activeElement).toBe(byTestId("values"));
    key(byTestId("values"), "Escape");
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(byTestId("main"));
    expect(key(byTestId("main"), "Enter").defaultPrevented).toBe(false);
    expect(menu()).toBeNull();
    key(byTestId("chevron"), "ArrowUp");
    expect(document.activeElement).toBe(byTestId("formulas"));
  });

  it("a row runs AFTER the menu closed and focus went back to the part that opened it", () => {
    let focusedAtRun: Element | null = null;
    const onPick = vi.fn(() => {
      focusedAtRun = document.activeElement;
    });
    render(<Paste onPick={onPick} />, bandLayout());
    click(byTestId("chevron"));
    click(byTestId("formulas"));
    expect(onPick).toHaveBeenCalledWith("formulas");
    expect(menu()).toBeNull();
    expect(focusedAtRun).toBe(byTestId("chevron"));
  });

  it("a press on the top part while the menu is open closes it and runs", () => {
    const onRun = vi.fn();
    render(<Paste onRun={onRun} />, bandLayout());
    click(byTestId("chevron"));
    mouseDown(byTestId("main"));
    click(byTestId("main"));
    expect(menu()).toBeNull();
    expect(onRun).toHaveBeenCalledTimes(1);
  });

  it("disabled: both parts aria-disabled (never native), faded, inert", () => {
    const onRun = vi.fn();
    render(<Paste disabled onRun={onRun} />, bandLayout());
    const main = byTestId<HTMLButtonElement>("main");
    const chevron = byTestId<HTMLButtonElement>("chevron");
    expect(main.getAttribute("aria-disabled")).toBe("true");
    expect(chevron.getAttribute("aria-disabled")).toBe("true");
    expect(main.disabled).toBe(false);
    expect(chevron.disabled).toBe(false);
    expect(getComputedStyle(main).opacity).toBe(String(DISABLED_OPACITY));
    expect(getComputedStyle(chevron).opacity).toBe(String(DISABLED_OPACITY));
    click(main);
    click(chevron);
    key(main, "ArrowDown");
    expect(onRun).not.toHaveBeenCalled();
    expect(menu()).toBeNull();
  });
});

describe("SplitMenuButton face='hero' outside the band falls back to 'labelled'", () => {
  it.each([
    ["panel", panelLayout(300)],
    ["popover", { ...panelLayout(200), container: "popover" as const }],
  ])("%s: a 28px icon + label main half beside a 16px chevron", (_name, layout) => {
    render(<Paste labelLines={2} />, layout);
    const main = byTestId("main");
    const chevron = byTestId("chevron");
    const wrap = main.parentElement as HTMLElement;
    expect(getComputedStyle(wrap).flexDirection).not.toBe("column");
    expect(main.style.height).toBe("28px");
    expect(main.textContent).toBe("Paste");
    expect(chevron.style.width).toBe("16px");
    expect(chevron.style.height).toBe("28px");
    expect(chevron.textContent).toBe("");
    // A band-sized (30px) picture is fitted to the 28px row's 20.
    expect(getComputedStyle(main.querySelector("svg")!).width).toBe("20px");
    expect(main.querySelectorAll("[data-hero-line]")).toHaveLength(0);
  });
});

// ============================================================================
// SplitMenuButton face="labelled" -- Excel's medium split
// ============================================================================

describe("SplitMenuButton face='labelled'", () => {
  it.each([
    ["band", bandLayout()],
    ["panel", panelLayout(300)],
  ])("%s: span.split > [icon + label 28px] [16x28 chevron]", (_name, layout) => {
    render(<Paste face="labelled" label="Merge & Center" />, layout);
    const main = byTestId("main");
    const chevron = byTestId("chevron");
    const wrap = main.parentElement as HTMLElement;
    expect(wrap.tagName).toBe("SPAN");
    expect(wrap.classList.contains("split")).toBe(true);
    expect(wrap.children).toHaveLength(2);
    expect(main.classList.contains("split-main")).toBe(true);
    expect(chevron.classList.contains("split-chevron")).toBe(true);
    expect(main.style.height).toBe("28px");
    expect(main.textContent).toBe("Merge & Center");
    expect(main.getAttribute("aria-label")).toBe("Merge & Center");
    const iconSlot = main.firstElementChild as HTMLElement;
    expect(iconSlot.getAttribute("aria-hidden")).toBe("true");
    expect(getComputedStyle(iconSlot.querySelector("svg")!).width).toBe("20px");
    expect([chevron.style.width, chevron.style.height]).toEqual(["16px", "28px"]);
    expect(chevron.getAttribute("aria-label")).toBe("Merge & Center options");
    expect(declared(chevron, "box-shadow")).toContain("--control-divider");
  });

  it("size sm is a 24px row with a 16px picture", () => {
    render(
      <SplitMenuButton
        face="labelled"
        size="sm"
        icon={<Icon size={20} />}
        label="AutoSum"
        data-testid="main"
        chevronTestId="chevron"
        onClick={() => undefined}
      >
        <MenuItem onSelect={() => undefined}>Sum</MenuItem>
      </SplitMenuButton>,
    );
    expect(byTestId("main").style.height).toBe("24px");
    expect(byTestId("chevron").style.height).toBe("24px");
    expect(getComputedStyle(byTestId("main").querySelector("svg")!).width).toBe("16px");
  });

  it("keeps pressed, the keyboard model and the menu", () => {
    const onRun = vi.fn();
    render(
      <SplitMenuButton
        face="labelled"
        icon={<Icon size={20} />}
        label="Merge & Center"
        pressed
        data-testid="main"
        chevronTestId="chevron"
        onClick={onRun}
      >
        <MenuItem testId="across" onSelect={() => undefined}>
          Merge Across
        </MenuItem>
      </SplitMenuButton>,
      bandLayout(),
    );
    const main = byTestId("main");
    expect(main.getAttribute("aria-pressed")).toBe("true");
    click(main);
    expect(onRun).toHaveBeenCalledTimes(1);
    key(main, "ArrowDown");
    expect(document.activeElement).toBe(byTestId("across"));
    key(byTestId("across"), "Escape");
    expect(document.activeElement).toBe(main);
  });

  it("a visible label means no tooltip on the main half unless one is asked for; the chevron is named", () => {
    vi.useFakeTimers();
    try {
      render(<Paste face="labelled" label="Merge & Center" />, bandLayout());
      hover(byTestId("main"));
      wait(1000);
      expect(tooltip()).toBeNull();
      unhover(byTestId("main"));
      hover(byTestId("chevron"));
      wait(1000);
      expect(tooltip()?.textContent).toBe("Merge & Center options");
      unhover(byTestId("chevron"));
      wait(1000);

      render(
        <SplitMenuButton
          face="labelled"
          icon={<Icon size={20} />}
          label="Merge & Center"
          tooltip="Combine and center the contents"
          data-testid="main"
          onClick={() => undefined}
        >
          <MenuItem onSelect={() => undefined}>Merge Across</MenuItem>
        </SplitMenuButton>,
        bandLayout(),
      );
      hover(byTestId("main"));
      wait(1000);
      expect(tooltip()?.textContent).toBe("Combine and center the contents");
    } finally {
      vi.useRealTimers();
    }
  });

  it("hero: the picture part is described by the caller's tooltip (Excel: 'Paste (Ctrl+V)')", () => {
    vi.useFakeTimers();
    try {
      render(
        <SplitMenuButton
          face="hero"
          icon={<Icon />}
          label="Paste"
          tooltip="Paste"
          shortcut="Ctrl+V"
          data-testid="main"
          chevronTestId="chevron"
          onClick={() => undefined}
        >
          <MenuItem onSelect={() => undefined}>Values</MenuItem>
        </SplitMenuButton>,
        bandLayout(),
      );
      hover(byTestId("main"));
      wait(1000);
      expect(tooltip()?.textContent).toContain("Paste");
      expect(tooltip()?.textContent).toContain("Ctrl+V");
    } finally {
      vi.useRealTimers();
    }
  });

  it("disabled: aria-disabled on both halves, never native", () => {
    render(<Paste face="labelled" disabled />);
    expect(byTestId("main").getAttribute("aria-disabled")).toBe("true");
    expect(byTestId("chevron").getAttribute("aria-disabled")).toBe("true");
    expect(byTestId<HTMLButtonElement>("main").disabled).toBe(false);
    click(byTestId("chevron"));
    expect(menu()).toBeNull();
  });
});

describe("split faces: colours", () => {
  it.each([
    ["band", bandLayout()],
    ["panel", panelLayout(300)],
  ])("paint no hardcoded colour in the %s, closed and open", (_name, layout) => {
    render(
      <>
        <Paste />
        <SplitMenuButton
          face="labelled"
          icon={<Icon size={20} />}
          label="AutoSum"
          chevronTestId="auto"
          onClick={() => undefined}
        >
          <MenuItem onSelect={() => undefined}>Sum</MenuItem>
        </SplitMenuButton>
        <SplitMenuButton face="hero" labelLines={2} disabled icon={<Icon />} label="Insert" onClick={() => undefined}>
          <MenuItem onSelect={() => undefined}>Insert Cells...</MenuItem>
        </SplitMenuButton>
      </>,
      layout,
    );
    expect(hardcodedColours(document.body)).toEqual([]);
    click(byTestId("chevron"));
    expect(menu()).not.toBeNull();
    expect(hardcodedColours(document.body)).toEqual([]);
  });
});
