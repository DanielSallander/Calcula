// Tests for the @api/layout Popover: the default (plain) mode must render the
// exact DOM the pre-Clusters Popover rendered — a dozen callers and the visual
// goldens depend on it — while `card` adds the Clusters chrome. Dismissal
// (Escape, outside mousedown) and focus return on Escape are pinned too.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SurfaceLayoutProvider, bandLayout, panelLayout, type SurfaceLayout } from "../context";
import { findHardcodedColours } from "../testing";
import {
  Popover,
  computePopoverPosition,
  firstFocusable,
  type PopoverProps,
} from "../primitives/Popover";

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

function flyout(): HTMLElement | null {
  return document.querySelector("[data-section-flyout]");
}

function pressEscape(): void {
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
}

function mouseDown(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  });
}

/** A trigger + popover pair whose open state lives in the harness, the way
 *  real callers hold it. `anchorAs` picks whether the anchor IS the button or
 *  a wrapper around it (the HomeTab idiom). */
function Harness(
  props: Partial<PopoverProps> & {
    initiallyOpen?: boolean;
    anchorAs?: "button" | "wrapper";
    onClosed?: () => void;
  },
): React.ReactElement {
  const { initiallyOpen = true, anchorAs = "wrapper", onClosed, ...popoverProps } = props;
  const [open, setOpen] = useState(initiallyOpen);
  // Callback refs into state: the anchor element arrives with a re-render, the
  // way a real caller's anchor does.
  const [wrapperEl, setWrapperEl] = useState<HTMLDivElement | null>(null);
  const [buttonEl, setButtonEl] = useState<HTMLButtonElement | null>(null);
  const anchorEl = anchorAs === "button" ? buttonEl : wrapperEl;
  return (
    <>
      <div ref={setWrapperEl} data-testid="anchor-wrap">
        <button ref={setButtonEl} data-testid="trigger" onClick={() => setOpen((o) => !o)}>
          Open
        </button>
      </div>
      <input data-testid="elsewhere" />
      <Popover
        anchorEl={anchorEl}
        open={open}
        onClose={() => {
          setOpen(false);
          onClosed?.();
        }}
        {...popoverProps}
      >
        <button data-testid="inside">Inside</button>
      </Popover>
    </>
  );
}

// ============================================================================
// Plain mode — byte-identical to the historical Popover
// ============================================================================

describe("Popover — plain (default)", () => {
  it("renders the historical DOM exactly: no class, same style, same three attributes", () => {
    render(<Harness />);
    const el = flyout()!;
    expect(el).not.toBeNull();
    expect(el.parentElement).toBe(document.body);
    expect(el.getAttributeNames().sort()).toEqual(
      ["data-ribbon-content", "data-section-flyout", "role", "style"].sort(),
    );
    expect(el.getAttribute("role")).toBe("dialog");
    expect(el.getAttribute("data-ribbon-content")).toBe("");
    expect(el.getAttribute("data-section-flyout")).toBe("");
    // jsdom lays out nothing: the anchor rect is all zeros, so left clamps to
    // 4 and top is anchor.bottom (0) + the historical 2px offset.
    expect(el.getAttribute("style")).toBe(
      "position: fixed; left: 4px; top: 2px; z-index: 1100; max-height: 80vh; " +
        "max-width: calc(100vw - 8px); overflow: auto; visibility: visible;",
    );
  });

  it("renders nothing while closed", () => {
    render(<Harness initiallyOpen={false} />);
    expect(flyout()).toBeNull();
  });

  it("an explicit width is the only opt-in addition to the style", () => {
    render(<Harness width={260} />);
    expect(flyout()!.style.width).toBe("260px");
    expect(flyout()!.hasAttribute("class")).toBe(false);
  });

  it("role and ariaLabel override the defaults", () => {
    render(<Harness role="menu" ariaLabel="Trendline" />);
    expect(flyout()!.getAttribute("role")).toBe("menu");
    expect(flyout()!.getAttribute("aria-label")).toBe("Trendline");
  });

  it.each([
    ["band", bandLayout()],
    ["panel", panelLayout(300)],
  ])("paints no hardcoded colour in the %s", (_name, layout) => {
    render(<Harness />, layout);
    expect(hardcodedColours(flyout()!)).toEqual([]);
    expect(hardcodedColours(container)).toEqual([]);
  });
});

// ============================================================================
// Card mode — the Clusters chrome
// ============================================================================

describe("Popover — card", () => {
  it("adds the card chrome and keeps the ribbon tags", () => {
    render(<Harness card />);
    const el = flyout()!;
    expect(el.hasAttribute("class")).toBe(true);
    expect(el.hasAttribute("data-ribbon-content")).toBe(true);
    expect(el.hasAttribute("data-section-flyout")).toBe(true);
    const cs = getComputedStyle(el);
    expect(cs.padding).toBe("8px");
    expect(cs.borderRadius).toContain("--radius-popover");
    expect(cs.boxShadow).toContain("--shadow-popover");
    expect(cs.animation || cs.animationDuration).toContain("--motion-popover");
  });

  it("keeps the plain positioning style underneath the chrome", () => {
    render(<Harness card />);
    const el = flyout()!;
    expect(el.style.position).toBe("fixed");
    expect(el.style.zIndex).toBe("1100");
    expect(el.style.maxHeight).toBe("80vh");
  });

  it("renders a heading that also names the popover", () => {
    render(<Harness card heading="Data labels" />);
    const el = flyout()!;
    expect(el.getAttribute("aria-label")).toBe("Data labels");
    const heading = el.firstElementChild as HTMLElement;
    expect(heading.textContent).toBe("Data labels");
    expect(getComputedStyle(heading).fontSize).toBe("11px");
    expect(getComputedStyle(heading).fontWeight).toBe("600");
    expect(getComputedStyle(heading).padding).toBe("4px 6px 8px");
  });

  it("ariaLabel wins over heading", () => {
    render(<Harness card heading="Data labels" ariaLabel="Label options" />);
    expect(flyout()!.getAttribute("aria-label")).toBe("Label options");
  });

  it.each([
    ["band", bandLayout()],
    ["panel", panelLayout(300)],
  ])("paints no hardcoded colour in the %s", (_name, layout) => {
    render(<Harness card heading="Actions" />, layout);
    expect(hardcodedColours(flyout()!)).toEqual([]);
  });
});

// ============================================================================
// Dismissal + focus return
// ============================================================================

describe("Popover — dismissal", () => {
  it("closes on Escape", () => {
    const onClosed = vi.fn();
    render(<Harness onClosed={onClosed} />);
    pressEscape();
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(flyout()).toBeNull();
  });

  it("closes on a mousedown outside, not inside or on the anchor", () => {
    const onClosed = vi.fn();
    render(<Harness onClosed={onClosed} />);
    mouseDown(document.querySelector("[data-testid='inside']")!);
    mouseDown(document.querySelector("[data-testid='trigger']")!);
    expect(onClosed).not.toHaveBeenCalled();
    expect(flyout()).not.toBeNull();
    mouseDown(document.querySelector("[data-testid='elsewhere']")!);
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(flyout()).toBeNull();
  });

  it("Escape returns focus to the anchor's first focusable (wrapper anchor)", () => {
    render(<Harness />);
    const inside = document.querySelector<HTMLButtonElement>("[data-testid='inside']")!;
    act(() => inside.focus());
    expect(document.activeElement).toBe(inside);
    pressEscape();
    expect(flyout()).toBeNull();
    expect(document.activeElement).toBe(document.querySelector("[data-testid='trigger']"));
  });

  it("Escape returns focus to the anchor itself when it is focusable", () => {
    render(<Harness anchorAs="button" card />);
    const inside = document.querySelector<HTMLButtonElement>("[data-testid='inside']")!;
    act(() => inside.focus());
    pressEscape();
    expect(document.activeElement).toBe(document.querySelector("[data-testid='trigger']"));
  });

  it("returnFocus={false} leaves focus alone", () => {
    render(<Harness returnFocus={false} />);
    const inside = document.querySelector<HTMLButtonElement>("[data-testid='inside']")!;
    act(() => inside.focus());
    pressEscape();
    expect(flyout()).toBeNull();
    expect(document.activeElement).not.toBe(document.querySelector("[data-testid='trigger']"));
  });

  it("never steals focus from an unrelated field", () => {
    render(<Harness />);
    const field = document.querySelector<HTMLInputElement>("[data-testid='elsewhere']")!;
    act(() => field.focus());
    pressEscape();
    expect(flyout()).toBeNull();
    expect(document.activeElement).toBe(field);
  });

  it("an outside mousedown does not move focus to the anchor", () => {
    render(<Harness />);
    const inside = document.querySelector<HTMLButtonElement>("[data-testid='inside']")!;
    act(() => inside.focus());
    mouseDown(document.querySelector("[data-testid='elsewhere']")!);
    expect(flyout()).toBeNull();
    expect(document.activeElement).not.toBe(document.querySelector("[data-testid='trigger']"));
  });
});

// ============================================================================
// Placement
// ============================================================================

describe("Popover — placement", () => {
  const anchor = { left: 100, top: 50, right: 200, bottom: 78 };

  it("bottom-start keeps the historical computation", () => {
    expect(computePopoverPosition(anchor, 240, 300, "bottom-start", 2, 1200, 800)).toEqual({
      left: 100,
      top: 80,
    });
    // Clamped at the right edge exactly as before.
    expect(
      computePopoverPosition({ ...anchor, left: 1100, right: 1180 }, 240, 300, "bottom-start", 2, 1200, 800)
        .left,
    ).toBe(1200 - 240 - 4);
  });

  it("bottom-end aligns right edges", () => {
    expect(computePopoverPosition(anchor, 240, 300, "bottom-end", 2, 1200, 800)).toEqual({
      left: 4,
      top: 80,
    });
    expect(
      computePopoverPosition({ ...anchor, left: 600, right: 700 }, 240, 300, "bottom-end", 2, 1200, 800)
        .left,
    ).toBe(460);
  });

  it("right-start opens beside the anchor, flipping left when there is no room", () => {
    expect(computePopoverPosition(anchor, 240, 300, "right-start", 4, 1200, 800)).toEqual({
      left: 204,
      top: 50,
    });
    const nearEdge = { left: 1000, top: 50, right: 1100, bottom: 78 };
    expect(computePopoverPosition(nearEdge, 240, 300, "right-start", 4, 1200, 800).left).toBe(
      1000 - 4 - 240,
    );
  });

  it("right-start clamps its top into the viewport", () => {
    const low = { left: 100, top: 700, right: 200, bottom: 728 };
    expect(computePopoverPosition(low, 240, 300, "right-start", 2, 1200, 800).top).toBe(800 - 300 - 4);
  });

  it("offset is honoured", () => {
    expect(computePopoverPosition(anchor, 240, 300, "bottom-start", 8, 1200, 800).top).toBe(86);
  });

  it("firstFocusable prefers the anchor, then its first enabled focusable", () => {
    const wrap = document.createElement("div");
    wrap.innerHTML = '<button disabled>a</button><button id="b">b</button>';
    expect(firstFocusable(wrap)?.id).toBe("b");
    const btn = document.createElement("button");
    expect(firstFocusable(btn)).toBe(btn);
  });
});
