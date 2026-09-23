//! FILENAME: app/extensions/_standard/conditional-formatting/__tests__/colorPicker.test.tsx
// PURPOSE: The conditional-formatting rule editor's ColorPicker is a thin
//          adapter over the ONE @api colour picker, with its old props and its
//          old behaviour: the preset colours, a way to clear the colour
//          (onChange(undefined)), a hex entry, and the current value shown as
//          text ("None" or the hex).
// CONTEXT: No theme grid on purpose — a rule stores a flat hex, so a theme
//          colour picked here would not follow a theme change.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const { paletteMock } = vi.hoisted(() => ({ paletteMock: vi.fn() }));
vi.mock("@api/theme", () => ({ getThemeColorPalette: paletteMock }));

import {
  ColorSwatch,
  SurfaceLayoutProvider,
  bandLayout,
  panelLayout,
  findHardcodedColours,
  type SurfaceLayout,
} from "@api/layout";
import { ColorPicker } from "../components/ColorPicker";
import { RuleEditor } from "../components/RuleEditor";
import type { ConditionalRule } from "../types";

const LAYOUTS: Array<[string, SurfaceLayout]> = [
  ["band", bandLayout()],
  ["panel", panelLayout(300)],
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  paletteMock.mockReset();
  paletteMock.mockResolvedValue([]);
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

function trigger(): HTMLButtonElement {
  const btn = container.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]');
  if (!btn) throw new Error("no swatch button");
  return btn;
}

function popover(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>("[data-section-flyout]");
}

/** Every declaration of every stylesheet rule that matches `el` (emotion's
 *  injected rules included). jsdom drops some shorthands from
 *  getComputedStyle, so the declared text is what can be asserted. */
function declaredRuleText(el: Element): string {
  let text = "";
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSStyleRule)) continue;
      try {
        if (el.matches(rule.selectorText)) text += rule.style.cssText;
      } catch {
        // A selector jsdom cannot parse (a pseudo-class it lacks) matches nothing.
      }
    }
  }
  return text;
}

/** The chip span of the popover's automatic row (the row whose text is `label`). */
function automaticRowChip(label: string): HTMLElement {
  const row = Array.from(popover()!.querySelectorAll("button")).find((b) => b.textContent === label);
  if (!row) throw new Error(`no '${label}' row`);
  const chip = row.querySelector<HTMLElement>("span[aria-hidden]");
  if (!chip) throw new Error(`no chip in the '${label}' row`);
  return chip;
}

function cfRule(): ConditionalRule {
  return {
    id: "r1",
    enabled: true,
    condition: { type: "cellValue", operator: "greaterThan", value1: 0 },
    style: { backgroundColor: "#ffc7ce", textColor: "#9c0006" },
    range: { startRow: 0, startCol: 0, endRow: 9, endCol: 0 },
  };
}

describe("conditional-formatting ColorPicker (adapter over @api ColorSwatch/ColorPopover)", () => {
  it.each(LAYOUTS)("paints only with tokens in the %s layout, trigger and open popover", async (_n, layout) => {
    render(<ColorPicker value="#ffc7ce" onChange={() => {}} />, layout);
    expect(findHardcodedColours(container)).toEqual([]);
    await click(trigger());
    await settle();
    expect(popover()).not.toBeNull();
    expect(findHardcodedColours(popover()!)).toEqual([]);
  });

  it("shows the value as text, as the old trigger did", () => {
    render(<ColorPicker value="#9c0006" onChange={() => {}} />);
    expect(container.textContent).toContain("#9c0006");
    render(<ColorPicker value={undefined} onChange={() => {}} />);
    expect(container.textContent).toContain("None");
    // The old ^/v text glyphs are gone.
    expect(container.textContent).not.toMatch(/\bv\b|\^/);
  });

  it("offers the 24 preset colours and no theme grid", async () => {
    render(<ColorPicker value="#ffc7ce" onChange={() => {}} />);
    await click(trigger());
    await settle();
    expect(paletteMock).not.toHaveBeenCalled();
    const swatches = popover()!.querySelectorAll<HTMLButtonElement>("[data-colour-swatch]");
    expect(swatches.length).toBe(24);
    // The current colour is the selected preset.
    const pressed = Array.from(swatches).filter((s) => s.getAttribute("aria-pressed") === "true");
    expect(pressed).toHaveLength(1);
    expect(pressed[0].style.background).toMatch(/rgb\(255, 199, 206\)|#ffc7ce/i);
  });

  it("a preset pick calls onChange with its hex and closes", async () => {
    const onChange = vi.fn();
    render(<ColorPicker value={undefined} onChange={onChange} />);
    await click(trigger());
    await settle();
    const swatches = popover()!.querySelectorAll<HTMLButtonElement>("[data-colour-swatch]");
    await click(swatches[2]);
    expect(onChange).toHaveBeenCalledWith("#ffc7ce");
    expect(popover()).toBeNull();
  });

  it("'None' clears the colour (the old Clear button)", async () => {
    const onChange = vi.fn();
    render(<ColorPicker value="#ff0000" onChange={onChange} />);
    await click(trigger());
    await settle();
    const none = Array.from(popover()!.querySelectorAll("button")).find((b) => b.textContent === "None");
    expect(none).toBeDefined();
    await click(none!);
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it("names the swatch from the optional label", () => {
    render(<ColorPicker value="#ff0000" onChange={() => {}} label="Background colour" />);
    expect(trigger().getAttribute("aria-label")).toBe("Background colour");
    render(<ColorPicker value="#ff0000" onChange={() => {}} />);
    expect(trigger().getAttribute("aria-label")).toBe("Colour");
  });

  it("'None' wears an empty outline chip, not the text-coloured 'Automatic' chip", async () => {
    // Positive control first: the default automatic row IS painted with the
    // text colour, so the helper can see the paint the None row must lack.
    render(
      <ColorSwatch color="#ff0000" onChange={() => {}} label="Font colour" allowAutomatic showTheme={false} />,
    );
    await click(trigger());
    await settle();
    expect(declaredRuleText(automaticRowChip("Automatic"))).toMatch(/currentcolor/i);
    act(() => root.unmount());
    root = createRoot(container);

    render(<ColorPicker value="#ff0000" onChange={() => {}} />);
    await click(trigger());
    await settle();
    const chip = automaticRowChip("None");
    const declared = declaredRuleText(chip);
    expect(declared).not.toMatch(/currentcolor/i);
    // Still outlined, so the row shows an empty box rather than nothing.
    expect(declared).toMatch(/box-shadow/i);
  });
});

describe("conditional-formatting RuleEditor colour pickers", () => {
  it("names its two pickers apart: 'Background colour' and 'Text colour'", () => {
    render(<RuleEditor rule={cfRule()} onChange={() => {}} isNew={false} />);
    const names = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="dialog"]'),
    ).map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual(["Background colour", "Text colour"]);
  });

  it("each picker writes its own style field", async () => {
    const onChange = vi.fn();
    render(<RuleEditor rule={cfRule()} onChange={onChange} isNew={false} />);
    const text = container.querySelector<HTMLButtonElement>('button[aria-label="Text colour"]')!;
    await click(text);
    await settle();
    const none = Array.from(popover()!.querySelectorAll("button")).find((b) => b.textContent === "None")!;
    await click(none);
    expect(onChange).toHaveBeenCalledWith({
      style: { backgroundColor: "#ffc7ce", textColor: undefined },
    });
  });
});
