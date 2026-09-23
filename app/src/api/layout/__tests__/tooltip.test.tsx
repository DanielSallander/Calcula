// Tests for the @api/layout Tooltip: no wrapper element, the hover delay, the
// keyboard-only focus rule (and its guard for engines that do not know
// :focus-visible), the global off switch, the live shortcut chip, and the
// portal's identity (role="tooltip", pointer-events none, never ribbon content).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// The chip is read from the live keybinding registry. Mocked so the test pins
// the contract (keybinding id first, then the command it runs) rather than
// whatever the default binding table says today.
vi.mock("../../keybindings", () => {
  const bindings = [
    { id: "core.copy", combo: "ctrl+c", commandId: "core.clipboard.copy" },
    { id: "core.bold", combo: "ctrl+b", commandId: "format.bold" },
  ];
  return {
    getEffectiveCombo: vi.fn((id: string) => {
      if (id === "explode") throw new Error("registry not initialised");
      return bindings.find((b) => b.id === id)?.combo ?? "";
    }),
    getAllKeybindings: vi.fn(() => bindings),
    formatCombo: vi.fn((combo: string) =>
      combo
        .split("+")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join("+"),
    ),
  };
});

import { SurfaceLayoutProvider, bandLayout, panelLayout, type SurfaceLayout } from "../context";
import { TOOLTIP_DELAY_MS } from "../tokens";
import { findHardcodedColours } from "../testing";
import {
  Tooltip,
  computeTooltipPosition,
  isKeyboardFocus,
  resolveShortcutLabel,
} from "../primitives/Tooltip";
import { IconButton } from "../primitives/Button";

/**
 * findHardcodedColours with its one known false positive neutralised. The
 * colour-name alternation in testing.ts is `\b(?:white|...)\b`, and `\b`
 * matches between "white" and "-", so every `white-space: nowrap` reports
 * "-> white". Filtering those findings out is NOT safe: the helper reports only
 * the FIRST hit per rule, so a real `#333` after a white-space declaration in
 * the same rule is dropped with it (measured: a sabotaged Badge passed). So the
 * white-space declarations are removed from the stylesheet text for the
 * duration of the scan instead, and every real colour stays visible. Reported
 * to the owner of testing.ts (fix: `(?<![\w-])white(?![\w-])`); once fixed this
 * is a harmless no-op.
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
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete document.documentElement.dataset.tooltips;
  document.body.innerHTML = "";
});

function render(node: React.ReactNode, layout: SurfaceLayout = panelLayout(300)): void {
  act(() => {
    root.render(<SurfaceLayoutProvider value={layout}>{node}</SurfaceLayoutProvider>);
  });
}

function button(): HTMLButtonElement {
  return container.querySelector("button") as HTMLButtonElement;
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

function keyboardFocus(el: HTMLElement, visible: boolean | "throw"): void {
  const original = el.matches.bind(el);
  vi.spyOn(el, "matches").mockImplementation((selector: string) => {
    if (selector === ":focus-visible") {
      if (visible === "throw") throw new SyntaxError("unknown pseudo-class");
      return visible;
    }
    return original(selector);
  });
  act(() => {
    el.focus();
  });
}

describe("Tooltip — no wrapper", () => {
  it("renders the child alone: no wrapper element and no added text", () => {
    render(
      <Tooltip content="Bold">
        <button data-testid="b">B</button>
      </Tooltip>,
    );
    expect(container.children).toHaveLength(1);
    expect(container.firstElementChild?.tagName).toBe("BUTTON");
    expect(container.textContent).toBe("B");
  });

  it("chains the child's own handlers instead of replacing them", () => {
    const onMouseEnter = vi.fn();
    const onMouseLeave = vi.fn();
    const onMouseDown = vi.fn();
    const onFocus = vi.fn();
    const onBlur = vi.fn();
    render(
      <Tooltip content="Bold">
        <button
          onMouseEnter={onMouseEnter}
          onMouseLeave={onMouseLeave}
          onMouseDown={onMouseDown}
          onFocus={onFocus}
          onBlur={onBlur}
        >
          B
        </button>
      </Tooltip>,
    );
    const b = button();
    hover(b);
    unhover(b);
    act(() => {
      b.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    act(() => b.focus());
    act(() => b.blur());
    expect(onMouseEnter).toHaveBeenCalledTimes(1);
    expect(onMouseLeave).toHaveBeenCalledTimes(1);
    expect(onMouseDown).toHaveBeenCalledTimes(1);
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(onBlur).toHaveBeenCalledTimes(1);
  });
});

describe("Tooltip — hover", () => {
  it("opens only after the delay", () => {
    render(
      <Tooltip content="Bold">
        <button>B</button>
      </Tooltip>,
    );
    hover(button());
    wait(TOOLTIP_DELAY_MS - 1);
    expect(tooltip()).toBeNull();
    wait(1);
    expect(tooltip()).not.toBeNull();
    expect(tooltip()!.textContent).toBe("Bold");
  });

  it("honours a custom delay", () => {
    render(
      <Tooltip content="Bold" delay={50}>
        <button>B</button>
      </Tooltip>,
    );
    hover(button());
    wait(50);
    expect(tooltip()).not.toBeNull();
  });

  it("portals to body with role tooltip, pointer-events none, and is never ribbon content", () => {
    render(
      <Tooltip content="Bold">
        <button>B</button>
      </Tooltip>,
      bandLayout(),
    );
    hover(button());
    wait(TOOLTIP_DELAY_MS);
    const tip = tooltip()!;
    expect(tip.parentElement).toBe(document.body);
    expect(container.contains(tip)).toBe(false);
    expect(getComputedStyle(tip).pointerEvents).toBe("none");
    expect(getComputedStyle(tip).position).toBe("fixed");
    expect(tip.hasAttribute("data-ribbon-content")).toBe(false);
    expect(tip.closest("[data-ribbon-content]")).toBeNull();
    expect(tip.hasAttribute("data-section-flyout")).toBe(false);
  });

  it("describes the anchor only while open", () => {
    render(
      <Tooltip content="Bold">
        <button aria-describedby="hint">B</button>
      </Tooltip>,
    );
    const b = button();
    expect(b.getAttribute("aria-describedby")).toBe("hint");
    hover(b);
    wait(TOOLTIP_DELAY_MS);
    const id = tooltip()!.id;
    expect(id).not.toBe("");
    expect(b.getAttribute("aria-describedby")).toBe(`hint ${id}`);
    unhover(b);
    expect(tooltip()).toBeNull();
    expect(b.getAttribute("aria-describedby")).toBe("hint");
  });

  it("closes on leave, on press, and on Escape", () => {
    render(
      <Tooltip content="Bold">
        <button>B</button>
      </Tooltip>,
    );
    const b = button();

    hover(b);
    wait(TOOLTIP_DELAY_MS);
    unhover(b);
    expect(tooltip()).toBeNull();

    hover(b);
    wait(TOOLTIP_DELAY_MS);
    act(() => {
      b.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(tooltip()).toBeNull();

    unhover(b);
    hover(b);
    wait(TOOLTIP_DELAY_MS);
    expect(tooltip()).not.toBeNull();
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(tooltip()).toBeNull();
  });

  it("a press during the delay cancels the pending open", () => {
    render(
      <Tooltip content="Bold">
        <button>B</button>
      </Tooltip>,
    );
    const b = button();
    hover(b);
    wait(100);
    act(() => {
      b.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    wait(TOOLTIP_DELAY_MS);
    expect(tooltip()).toBeNull();
  });

  it("is inert when the content is empty", () => {
    render(
      <Tooltip content="">
        <button>B</button>
      </Tooltip>,
    );
    hover(button());
    wait(TOOLTIP_DELAY_MS);
    expect(tooltip()).toBeNull();
    expect(button().hasAttribute("aria-describedby")).toBe(false);
  });

  it("clears its timer on unmount", () => {
    render(
      <Tooltip content="Bold">
        <button>B</button>
      </Tooltip>,
    );
    hover(button());
    expect(vi.getTimerCount()).toBe(1);
    act(() => root.render(<div />));
    expect(vi.getTimerCount()).toBe(0);
    wait(TOOLTIP_DELAY_MS);
    expect(tooltip()).toBeNull();
  });
});

describe("Tooltip — off switch", () => {
  it("never renders while html[data-tooltips=off]", () => {
    document.documentElement.dataset.tooltips = "off";
    render(
      <Tooltip content="Bold">
        <button>B</button>
      </Tooltip>,
    );
    hover(button());
    wait(TOOLTIP_DELAY_MS * 3);
    expect(tooltip()).toBeNull();
  });

  it("an open tooltip disappears when the switch flips off", () => {
    render(
      <Tooltip content="Bold">
        <button>B</button>
      </Tooltip>,
    );
    hover(button());
    wait(TOOLTIP_DELAY_MS);
    expect(tooltip()).not.toBeNull();
    document.documentElement.dataset.tooltips = "off";
    // Any re-render reads the switch.
    render(
      <Tooltip content="Bold!">
        <button>B</button>
      </Tooltip>,
    );
    expect(tooltip()).toBeNull();
  });
});

describe("Tooltip — keyboard focus", () => {
  it("opens on focus that matches :focus-visible", () => {
    render(
      <Tooltip content="Bold">
        <button>B</button>
      </Tooltip>,
    );
    keyboardFocus(button(), true);
    wait(TOOLTIP_DELAY_MS);
    expect(tooltip()).not.toBeNull();
    act(() => button().blur());
    expect(tooltip()).toBeNull();
  });

  it("never opens on a click's focus (not :focus-visible)", () => {
    render(
      <Tooltip content="Bold">
        <button>B</button>
      </Tooltip>,
    );
    keyboardFocus(button(), false);
    wait(TOOLTIP_DELAY_MS);
    expect(tooltip()).toBeNull();
  });

  it("treats an engine that throws on :focus-visible as not keyboard focus", () => {
    render(
      <Tooltip content="Bold">
        <button>B</button>
      </Tooltip>,
    );
    keyboardFocus(button(), "throw");
    wait(TOOLTIP_DELAY_MS);
    expect(tooltip()).toBeNull();
  });

  it("isKeyboardFocus swallows the throw", () => {
    const el = document.createElement("button");
    el.matches = () => {
      throw new SyntaxError("unknown pseudo-class");
    };
    expect(isKeyboardFocus(el)).toBe(false);
  });
});

describe("Tooltip — shortcut chip", () => {
  function openWith(
    props: { shortcut?: string; commandId?: string },
    layout: SurfaceLayout = panelLayout(300),
  ): HTMLElement {
    render(
      <Tooltip content="Copy" {...props}>
        <button>C</button>
      </Tooltip>,
      layout,
    );
    hover(button());
    wait(TOOLTIP_DELAY_MS);
    return tooltip()!;
  }

  it("shows a literal shortcut in a kbd chip", () => {
    const tip = openWith({ shortcut: "Ctrl+Z" });
    const kbd = tip.querySelector("kbd");
    expect(kbd?.textContent).toBe("Ctrl+Z");
    expect(tip.textContent).toBe("CopyCtrl+Z");
  });

  it("resolves a keybinding id through the live registry", () => {
    const tip = openWith({ commandId: "core.bold" });
    expect(tip.querySelector("kbd")?.textContent).toBe("Ctrl+B");
  });

  it("resolves a command id through the binding that runs it", () => {
    const tip = openWith({ commandId: "core.clipboard.copy" });
    expect(tip.querySelector("kbd")?.textContent).toBe("Ctrl+C");
  });

  it("shows no chip for an unknown id", () => {
    const tip = openWith({ commandId: "nothing.bound" });
    expect(tip.querySelector("kbd")).toBeNull();
    expect(tip.textContent).toBe("Copy");
  });

  it("swallows a registry error (no chip, tooltip still shows)", () => {
    const tip = openWith({ commandId: "explode" });
    expect(tip).not.toBeNull();
    expect(tip.querySelector("kbd")).toBeNull();
  });

  it("resolveShortcutLabel prefers the literal shortcut", () => {
    expect(resolveShortcutLabel("F9", "core.bold")).toBe("F9");
    expect(resolveShortcutLabel(undefined, undefined)).toBeNull();
  });

  it.each([
    ["band", bandLayout()],
    ["panel", panelLayout(300)],
  ])("paints no hardcoded colour in the %s (chip included)", (_name, layout) => {
    const tip = openWith({ shortcut: "Ctrl+Z" }, layout);
    expect(hardcodedColours(tip)).toEqual([]);
    expect(hardcodedColours(container)).toEqual([]);
  });
});

describe("Tooltip — placement", () => {
  const anchor = { left: 100, top: 100, right: 128, bottom: 128, width: 28, height: 28 };

  it("centres below the anchor by default", () => {
    expect(computeTooltipPosition(anchor, 60, 22, "bottom", 1000, 800)).toEqual({
      left: 84,
      top: 134,
    });
  });

  it("flips above when there is no room below", () => {
    const low = { ...anchor, top: 770, bottom: 798 };
    expect(computeTooltipPosition(low, 60, 22, "bottom", 1000, 800).top).toBe(770 - 6 - 22);
  });

  it("clamps into the viewport horizontally", () => {
    const edge = { ...anchor, left: 0, right: 28 };
    expect(computeTooltipPosition(edge, 120, 22, "bottom", 1000, 800).left).toBe(4);
  });

  it("places right of the anchor, flipping left at the edge", () => {
    expect(computeTooltipPosition(anchor, 60, 22, "right", 1000, 800).left).toBe(134);
    const edge = { ...anchor, left: 960, right: 988 };
    expect(computeTooltipPosition(edge, 60, 22, "right", 1000, 800).left).toBe(960 - 6 - 60);
  });

  it("prefers above for placement top", () => {
    expect(computeTooltipPosition(anchor, 60, 22, "top", 1000, 800).top).toBe(100 - 6 - 22);
  });
});

describe("Tooltip — through IconButton", () => {
  it("names an icon-only control on hover with its label", () => {
    render(<IconButton icon={<svg />} label="Gridlines" />, bandLayout());
    hover(button());
    wait(TOOLTIP_DELAY_MS);
    expect(tooltip()?.textContent).toBe("Gridlines");
  });

  it("tooltip={false} suppresses it", () => {
    render(<IconButton icon={<svg />} label="Gridlines" tooltip={false} />, bandLayout());
    hover(button());
    wait(TOOLTIP_DELAY_MS);
    expect(tooltip()).toBeNull();
  });

  it("an explicit tooltip replaces the label, with the live chip", () => {
    render(
      <IconButton icon={<svg />} label="Copy" tooltip="Copy the selection" commandId="core.copy" />,
      bandLayout(),
    );
    hover(button());
    wait(TOOLTIP_DELAY_MS);
    expect(tooltip()?.textContent).toBe("Copy the selectionCtrl+C");
  });
});
