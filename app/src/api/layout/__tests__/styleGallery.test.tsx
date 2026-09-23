// Tests for the @api/layout StyleGallery: the band strip that FILLS the 61px
// content box (thumbnails + a full-height expand button), the expanded card
// popover and the inline panel grid (grouped listboxes, 2-D arrows that move
// without choosing), and the live-preview seam: onHover(id) while a style is
// hovered/focused, onHover(null) on every way out — leave, blur, choose (null
// BEFORE onChange), close, unmount. Thumbnails are caller-drawn colour DATA
// (data-colour-data); the chrome around them is scanned for literals under
// band AND panel geometry.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SurfaceLayoutProvider, bandLayout, panelLayout, type SurfaceLayout } from "../context";
import { findHardcodedColours } from "../testing";
import { StyleGallery, stripItems, type StyleGalleryItem } from "../primitives/StyleGallery";

/**
 * findHardcodedColours with its one known false positive neutralised (the
 * helper's colour-name alternation matches the "white" of `white-space`).
 * Same helper as buttons.test.tsx; a harmless no-op once testing.ts is fixed.
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

const FILLS = ["#4472c4", "#ed7d31", "#a5a5a5", "#ffc000", "#5b9bd5", "#70ad47", "#264478", "#9e480e"];

const thumbSpy = vi.fn();

/** Eight styles: Light 1-4, Dark 1-3, and one ungrouped. Each thumbnail
 *  paints a literal fill, the way a real style preview does. */
const ITEMS: StyleGalleryItem[] = FILLS.map((fill, i) => ({
  id: `s${i + 1}`,
  name: i < 4 ? `Light ${i + 1}` : i < 7 ? `Dark ${i - 3}` : "Custom",
  group: i < 4 ? "Light" : i < 7 ? "Dark" : undefined,
  renderThumb: (size) => {
    thumbSpy(size);
    return (
      <svg width={size.w} height={size.h} data-testid={`thumb-${i + 1}`}>
        <rect width={size.w} height={size.h} fill={fill} />
      </svg>
    );
  },
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  thumbSpy.mockReset();
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

function key(el: Element, k: string): void {
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

/** React derives onMouseEnter/Leave from bubbling mouseover/mouseout. */
function hover(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
  });
}

function unhover(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 2; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

function flyout(): HTMLElement | null {
  return document.querySelector("[data-section-flyout]");
}

function stripOptions(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("[role='option']"));
}

function popoverOptions(): HTMLButtonElement[] {
  return Array.from(flyout()?.querySelectorAll<HTMLButtonElement>("[role='option']") ?? []);
}

// ============================================================================
// stripItems
// ============================================================================

describe("stripItems", () => {
  it("shows the first N, and the selected one in the last slot when it is not among them", () => {
    expect(stripItems(ITEMS, "s1", 3).map((i) => i.id)).toEqual(["s1", "s2", "s3"]);
    expect(stripItems(ITEMS, "s7", 3).map((i) => i.id)).toEqual(["s1", "s2", "s7"]);
    expect(stripItems(ITEMS, null, 3).map((i) => i.id)).toEqual(["s1", "s2", "s3"]);
  });
});

// ============================================================================
// Band
// ============================================================================

describe("StyleGallery — band strip", () => {
  it("fills the 61px content box: `visible` thumbnails and a full-height expand button", () => {
    render(<StyleGallery items={ITEMS} value="s2" onChange={() => {}} label="Chart styles" testIdPrefix="cs" />);
    const strip = container.querySelector<HTMLElement>("[data-testid='cs']")!;
    expect(getComputedStyle(strip).height).toBe("61px");

    const opts = stripOptions();
    expect(opts).toHaveLength(3);
    for (const o of opts) {
      // 56x40 thumbnail + 3px padding all round.
      expect(o.style.width).toBe("62px");
      expect(o.style.height).toBe("46px");
      const thumb = o.querySelector<HTMLElement>("[data-colour-data]")!;
      expect(thumb.style.width).toBe("56px");
      expect(thumb.style.height).toBe("40px");
    }
    expect(thumbSpy).toHaveBeenCalledWith({ w: 56, h: 40 });

    const expand = container.querySelector<HTMLButtonElement>("[data-testid='cs-expand']")!;
    expect(expand.getAttribute("aria-label")).toBe("More Chart styles");
    expect(expand.style.height).toBe("61px");
    expect(expand.style.width).toBe("20px");
    expect(expand.getAttribute("aria-haspopup")).toBe("dialog");
    expect(expand.getAttribute("aria-expanded")).toBe("false");
  });

  it("is a named horizontal listbox; the value is aria-selected and the one tab stop", () => {
    render(<StyleGallery items={ITEMS} value="s2" onChange={() => {}} label="Chart styles" />);
    const list = container.querySelector("[role='listbox']")!;
    expect(list.getAttribute("aria-label")).toBe("Chart styles");
    expect(list.getAttribute("aria-orientation")).toBe("horizontal");
    const opts = stripOptions();
    expect(opts.map((o) => o.getAttribute("aria-label"))).toEqual(["Light 1", "Light 2", "Light 3"]);
    expect(opts.map((o) => o.getAttribute("aria-selected"))).toEqual(["false", "true", "false"]);
    expect(opts.map((o) => o.tabIndex)).toEqual([-1, 0, -1]);
  });

  it("the selected style is always visible (it takes the last slot)", () => {
    render(<StyleGallery items={ITEMS} value="s6" onChange={() => {}} label="Chart styles" />);
    expect(stripOptions().map((o) => o.getAttribute("aria-label"))).toEqual(["Light 1", "Light 2", "Dark 2"]);
  });

  it("thumbSize and visible are honoured", () => {
    render(
      <StyleGallery items={ITEMS} value={null} onChange={() => {}} label="Styles" visible={2} thumbSize={{ w: 48, h: 36 }} />,
    );
    const opts = stripOptions();
    expect(opts).toHaveLength(2);
    expect(opts[0].style.width).toBe("54px");
    expect(thumbSpy).toHaveBeenCalledWith({ w: 48, h: 36 });
  });

  it("no expand button when every style already shows", () => {
    render(<StyleGallery items={ITEMS.slice(0, 3)} value={null} onChange={() => {}} label="Styles" testIdPrefix="cs" />);
    expect(container.querySelector("[data-testid='cs-expand']")).toBeNull();
    expect(getComputedStyle(container.querySelector("[data-testid='cs']")!).height).toBe("61px");
  });

  it("a click chooses; Left/Right/Home/End move focus without choosing", () => {
    const onChange = vi.fn();
    render(<StyleGallery items={ITEMS} value="s1" onChange={onChange} label="Styles" />);
    const opts = stripOptions();
    act(() => opts[0].focus());
    key(opts[0], "ArrowRight");
    expect(document.activeElement).toBe(opts[1]);
    key(opts[1], "End");
    expect(document.activeElement).toBe(opts[2]);
    key(opts[2], "Home");
    expect(document.activeElement).toBe(opts[0]);
    expect(onChange).not.toHaveBeenCalled();
    click(opts[2]);
    expect(onChange).toHaveBeenCalledWith("s3");
  });
});

// ============================================================================
// Live preview
// ============================================================================

describe("StyleGallery — live preview", () => {
  it("hover previews, leaving ends it", () => {
    const onHover = vi.fn();
    render(<StyleGallery items={ITEMS} value="s1" onChange={() => {}} onHover={onHover} label="Styles" />);
    const opts = stripOptions();
    hover(opts[1]);
    expect(onHover).toHaveBeenLastCalledWith("s2");
    unhover(opts[1]);
    expect(onHover).toHaveBeenLastCalledWith(null);
  });

  it("focus previews, blur ends it (keyboard users see the preview too)", () => {
    const onHover = vi.fn();
    render(<StyleGallery items={ITEMS} value="s1" onChange={() => {}} onHover={onHover} label="Styles" />);
    const opts = stripOptions();
    act(() => opts[2].focus());
    expect(onHover).toHaveBeenLastCalledWith("s3");
    act(() => opts[2].blur());
    expect(onHover).toHaveBeenLastCalledWith(null);
  });

  it("choosing ends the preview BEFORE it commits", () => {
    const calls: string[] = [];
    render(
      <StyleGallery
        items={ITEMS}
        value="s1"
        label="Styles"
        onHover={(id) => calls.push(`hover:${id}`)}
        onChange={(id) => calls.push(`change:${id}`)}
      />,
    );
    const opts = stripOptions();
    hover(opts[1]);
    click(opts[1]);
    expect(calls).toEqual(["hover:s2", "hover:null", "change:s2"]);
  });

  it("an idle gallery never reports a spurious end", () => {
    const onHover = vi.fn();
    render(<StyleGallery items={ITEMS} value="s1" onChange={() => {}} onHover={onHover} label="Styles" />);
    unhover(stripOptions()[0]);
    act(() => root.unmount());
    root = createRoot(container);
    expect(onHover).not.toHaveBeenCalled();
  });

  it("unmounting mid-preview ends it", () => {
    const onHover = vi.fn();
    render(<StyleGallery items={ITEMS} value="s1" onChange={() => {}} onHover={onHover} label="Styles" />);
    hover(stripOptions()[1]);
    act(() => root.unmount());
    root = createRoot(container);
    expect(onHover).toHaveBeenLastCalledWith(null);
  });
});

// ============================================================================
// Expanded popover
// ============================================================================

describe("StyleGallery — expanded popover", () => {
  it("opens a card popover with every style, grouped, the selected focused", async () => {
    render(<StyleGallery items={ITEMS} value="s6" onChange={() => {}} label="Chart styles" testIdPrefix="cs" />);
    const expand = container.querySelector<HTMLButtonElement>("[data-testid='cs-expand']")!;
    click(expand);
    await settle();
    const pop = flyout()!;
    expect(pop).not.toBeNull();
    expect(pop.getAttribute("aria-label")).toBe("Chart styles");
    expect(expand.getAttribute("aria-expanded")).toBe("true");
    const groups = Array.from(pop.querySelectorAll("[role='group']"));
    expect(
      groups.map((g) => {
        const id = g.getAttribute("aria-labelledby");
        return id ? document.getElementById(id)?.textContent : null;
      }),
    ).toEqual(["Light", "Dark", null]);
    const opts = popoverOptions();
    expect(opts).toHaveLength(8);
    expect(opts.filter((o) => o.getAttribute("aria-selected") === "true").map((o) => o.getAttribute("aria-label"))).toEqual(["Dark 2"]);
    expect(document.activeElement).toBe(document.querySelector("[data-testid='cs-option-s6']"));
    for (const o of opts) expect(o.querySelector("[data-colour-data]")).not.toBeNull();
  });

  it("arrows move in 2-D across groups (columns honoured) without choosing", async () => {
    const onChange = vi.fn();
    render(<StyleGallery items={ITEMS} value="s1" onChange={onChange} label="Styles" columns={3} testIdPrefix="cs" />);
    click(container.querySelector("[data-testid='cs-expand']")!);
    await settle();
    const opts = popoverOptions();
    expect(document.activeElement).toBe(opts[0]);
    key(opts[0], "ArrowDown");
    expect(document.activeElement).toBe(opts[3]); // Light row 2 (Light 4)
    key(opts[3], "ArrowDown");
    expect(document.activeElement).toBe(opts[4]); // Dark 1
    key(opts[4], "ArrowRight");
    expect(document.activeElement).toBe(opts[5]);
    key(opts[5], "ArrowDown");
    expect(document.activeElement).toBe(opts[7]); // ungrouped Custom, clamped
    key(opts[7], "Home");
    expect(document.activeElement).toBe(opts[0]);
    expect(onChange).not.toHaveBeenCalled();
    const grid = opts[0].parentElement as HTMLElement;
    expect(grid.style.gridTemplateColumns).toBe("repeat(3, 62px)");
  });

  it("choosing ends the preview, closes, commits, and returns focus to the expand button", async () => {
    const calls: string[] = [];
    render(
      <StyleGallery
        items={ITEMS}
        value="s1"
        label="Styles"
        testIdPrefix="cs"
        onHover={(id) => calls.push(`hover:${id}`)}
        onChange={(id) => calls.push(`change:${id}`)}
      />,
    );
    const expand = container.querySelector<HTMLButtonElement>("[data-testid='cs-expand']")!;
    click(expand);
    await settle();
    calls.length = 0;
    const dark3 = document.querySelector<HTMLButtonElement>("[data-testid='cs-option-s7']")!;
    hover(dark3);
    act(() => dark3.focus());
    click(dark3);
    expect(flyout()).toBeNull();
    expect(document.activeElement).toBe(expand);
    expect(calls[calls.length - 1]).toBe("change:s7");
    expect(calls.indexOf("hover:null")).toBeGreaterThan(-1);
    expect(calls.indexOf("hover:null")).toBeLessThan(calls.indexOf("change:s7"));
  });

  it("Escape closes, ends the preview, and returns focus to the expand button", async () => {
    const onHover = vi.fn();
    render(<StyleGallery items={ITEMS} value="s1" onChange={() => {}} onHover={onHover} label="Styles" testIdPrefix="cs" />);
    const expand = container.querySelector<HTMLButtonElement>("[data-testid='cs-expand']")!;
    click(expand);
    await settle();
    hover(popoverOptions()[4]);
    expect(onHover).toHaveBeenLastCalledWith("s5");
    key(document.activeElement!, "Escape");
    expect(flyout()).toBeNull();
    expect(onHover).toHaveBeenLastCalledWith(null);
    expect(document.activeElement).toBe(expand);
  });

  it("the expand button toggles the popover closed again", async () => {
    render(<StyleGallery items={ITEMS} value="s1" onChange={() => {}} label="Styles" testIdPrefix="cs" />);
    const expand = container.querySelector<HTMLButtonElement>("[data-testid='cs-expand']")!;
    click(expand);
    await settle();
    expect(flyout()).not.toBeNull();
    click(expand);
    expect(flyout()).toBeNull();
  });
});

// ============================================================================
// Panel
// ============================================================================

describe("StyleGallery — panel", () => {
  it("renders the grouped grid inline, sized to the panel width, with no expand button", () => {
    render(
      <StyleGallery items={ITEMS} value="s3" onChange={() => {}} label="Chart styles" testIdPrefix="cs" />,
      panelLayout(300),
    );
    expect(container.querySelector("[data-testid='cs-expand']")).toBeNull();
    expect(flyout()).toBeNull();
    const opts = stripOptions();
    expect(opts).toHaveLength(8);
    expect(container.querySelector("[data-testid='cs-s3']")!.getAttribute("aria-selected")).toBe("true");
    // (300 + 4) / (62 + 4) -> 4 columns of 62px.
    expect((opts[0].parentElement as HTMLElement).style.gridTemplateColumns).toBe("repeat(4, 62px)");
  });

  it("falls back to `columns` before the panel is measured", () => {
    render(<StyleGallery items={ITEMS} value="s3" onChange={() => {}} label="Styles" columns={2} />, panelLayout(0));
    expect((stripOptions()[0].parentElement as HTMLElement).style.gridTemplateColumns).toBe("repeat(2, 62px)");
  });

  it("previews and chooses like the band", () => {
    const onHover = vi.fn();
    const onChange = vi.fn();
    render(
      <StyleGallery items={ITEMS} value="s3" onChange={onChange} onHover={onHover} label="Styles" />,
      panelLayout(300),
    );
    const opts = stripOptions();
    hover(opts[5]);
    expect(onHover).toHaveBeenLastCalledWith("s6");
    click(opts[5]);
    expect(onHover).toHaveBeenLastCalledWith(null);
    expect(onChange).toHaveBeenCalledWith("s6");
  });
});

// ============================================================================
// Colours
// ============================================================================

describe("StyleGallery — colours", () => {
  it.each([
    ["band", bandLayout()],
    ["panel", panelLayout(300)],
  ])("paints no hardcoded colour in the %s (the thumbnails are data)", (_name, layout) => {
    render(<StyleGallery items={ITEMS} value="s2" onChange={() => {}} label="Styles" />, layout);
    expect(hardcodedColours(container)).toEqual([]);
  });

  it("the open popover paints no hardcoded colour", async () => {
    render(<StyleGallery items={ITEMS} value="s2" onChange={() => {}} label="Styles" testIdPrefix="cs" />);
    click(container.querySelector("[data-testid='cs-expand']")!);
    await settle();
    expect(hardcodedColours(flyout()!)).toEqual([]);
  });

  it("the scan has teeth: without data-colour-data the thumbnails' fills are reported", () => {
    render(<StyleGallery items={ITEMS} value="s2" onChange={() => {}} label="Styles" />);
    container.querySelectorAll("[data-colour-data]").forEach((el) => el.removeAttribute("data-colour-data"));
    expect(hardcodedColours(container).length).toBeGreaterThan(0);
  });
});
