// Tests for the @api/layout Tile and TileGallery, and the keyboard-grid
// helpers (gridRows / gridKeyTarget) every gallery primitive shares. Sizes are
// pinned in px because the tall tile IS the cluster's 61px content box (the
// fill rule): a tile one pixel off breaks the band. Selection semantics are
// pinned per role, because what a screen reader announces and what the user
// sees must be the same attribute. Every render is scanned for hardcoded
// colours under band AND panel geometry.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SurfaceLayoutProvider, bandLayout, panelLayout, type SurfaceLayout } from "../context";
import { TOOLTIP_DELAY_MS } from "../tokens";
import { findHardcodedColours } from "../testing";
import {
  Tile,
  TileGallery,
  gridKeyTarget,
  gridRows,
  selectionAttribute,
  type TileGalleryItem,
} from "../primitives/Tile";

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

/**
 * The value `el` is DECLARED to have for `prop` by the stylesheet rules that
 * match it (last match wins). jsdom's getComputedStyle drops shorthands
 * written with var(), so the token a rule paints with is read from the rule.
 */
function declared(el: Element, prop: string): string {
  let value = "";
  const decl = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`);
  for (const style of Array.from(document.querySelectorAll("style"))) {
    const text = style.textContent ?? "";
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      let matches = false;
      try {
        matches = el.matches(m[1].trim());
      } catch {
        matches = false;
      }
      if (!matches) continue;
      const hit = decl.exec(m[2]);
      if (hit) value = hit[1].trim();
    }
  }
  return value;
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
  vi.useRealTimers();
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

const Pic = ({ id }: { id: string }): React.ReactElement => (
  <svg data-testid={`pic-${id}`} width="30" height="30" viewBox="0 0 24 24">
    <rect x="3" y="3" width="18" height="18" rx="2" fill="currentColor" />
  </svg>
);

// ============================================================================
// Grid helpers
// ============================================================================

describe("gridRows / gridKeyTarget", () => {
  it("chunks each group into rows; a group always starts a new row", () => {
    expect(gridRows([6, 3], 4)).toEqual([[0, 1, 2, 3], [4, 5], [6, 7, 8]]);
    expect(gridRows([0, 2], 4)).toEqual([[0, 1]]);
    expect(gridRows([3], 0)).toEqual([[0], [1], [2]]);
  });

  const rows = gridRows([6, 3], 4); // [[0,1,2,3],[4,5],[6,7,8]]

  it("Left/Right step through reading order and stop at the ends", () => {
    expect(gridKeyTarget(rows, 3, "ArrowRight")).toBe(4);
    expect(gridKeyTarget(rows, 5, "ArrowRight")).toBe(6);
    expect(gridKeyTarget(rows, 8, "ArrowRight")).toBe(8);
    expect(gridKeyTarget(rows, 0, "ArrowLeft")).toBe(0);
    expect(gridKeyTarget(rows, 6, "ArrowLeft")).toBe(5);
  });

  it("Up/Down keep the column and clamp into a shorter row", () => {
    expect(gridKeyTarget(rows, 3, "ArrowDown")).toBe(5); // col 3 -> short row's last
    expect(gridKeyTarget(rows, 1, "ArrowDown")).toBe(5);
    expect(gridKeyTarget(rows, 5, "ArrowDown")).toBe(7); // crosses into the next group
    expect(gridKeyTarget(rows, 7, "ArrowUp")).toBe(5);
    expect(gridKeyTarget(rows, 2, "ArrowUp")).toBe(2);
    expect(gridKeyTarget(rows, 8, "ArrowDown")).toBe(8);
  });

  it("Home/End go to the ends; other keys are not navigation", () => {
    expect(gridKeyTarget(rows, 4, "Home")).toBe(0);
    expect(gridKeyTarget(rows, 4, "End")).toBe(8);
    expect(gridKeyTarget(rows, 4, "Enter")).toBeNull();
    expect(gridKeyTarget([], 0, "ArrowRight")).toBeNull();
  });

  it("selectionAttribute follows the role", () => {
    expect(selectionAttribute("radio")).toBe("checked");
    expect(selectionAttribute("option")).toBe("selected");
    expect(selectionAttribute(undefined)).toBe("pressed");
  });
});

// ============================================================================
// Tile — tall
// ============================================================================

describe("Tile — tall", () => {
  it("is a 44x61 button named by its label, with the icon fitted to 30px", () => {
    render(<Tile icon={<Pic id="col" />} label="Column chart" onClick={() => {}} />);
    const btn = container.querySelector("button")!;
    expect(btn.style.width).toBe("44px");
    expect(btn.style.height).toBe("61px");
    expect(btn.getAttribute("aria-label")).toBe("Column chart");
    // The name lives in aria-label and the tooltip, never as visible text.
    expect(btn.textContent).toBe("");
    const svg = container.querySelector("[data-testid='pic-col']")!;
    expect(getComputedStyle(svg).width).toBe("30px");
    expect(getComputedStyle(svg).height).toBe("30px");
  });

  it("a toggle tile announces aria-pressed only when selected is defined", () => {
    render(
      <>
        <Tile icon={<Pic id="a" />} label="A" selected onClick={() => {}} />
        <Tile icon={<Pic id="b" />} label="B" selected={false} onClick={() => {}} />
        <Tile icon={<Pic id="c" />} label="C" onClick={() => {}} />
      </>,
    );
    const [a, b, c] = Array.from(container.querySelectorAll("button"));
    expect(a.getAttribute("aria-pressed")).toBe("true");
    expect(b.getAttribute("aria-pressed")).toBe("false");
    expect(c.hasAttribute("aria-pressed")).toBe(false);
  });

  it("role=radio carries aria-checked, never aria-pressed", () => {
    render(<Tile role="radio" icon={<Pic id="a" />} label="Bar chart" selected onClick={() => {}} />);
    const btn = container.querySelector("button")!;
    expect(btn.getAttribute("role")).toBe("radio");
    expect(btn.getAttribute("aria-checked")).toBe("true");
    expect(btn.hasAttribute("aria-pressed")).toBe(false);
  });

  it("role=option carries aria-selected, and aria-selected paints the pressed tokens", () => {
    render(<Tile role="option" icon={<Pic id="a" />} label="Pie chart" selected onClick={() => {}} />);
    const btn = container.querySelector("button")!;
    expect(btn.getAttribute("aria-selected")).toBe("true");
    expect(btn.hasAttribute("aria-pressed")).toBe(false);
    expect(declared(btn, "background")).toContain("--button-pressed-bg");
    expect(declared(btn, "border-color")).toContain("--button-pressed-border");
  });

  it("a chevron stacks under the icon inside the same 44x61 box", () => {
    render(<Tile chevron icon={<Pic id="a" />} label="More chart types" onClick={() => {}} />);
    const btn = container.querySelector("button")!;
    expect(btn.style.width).toBe("44px");
    expect(btn.style.height).toBe("61px");
    expect(btn.querySelectorAll("svg")).toHaveLength(2);
  });

  it("clicks, testId, HTML props and the ref reach the button", () => {
    const onClick = vi.fn();
    const ref = createRef<HTMLButtonElement>();
    render(<Tile ref={ref} testId="tile-col" title="Column" icon={<Pic id="a" />} label="Column" onClick={onClick} />);
    const btn = container.querySelector("[data-testid='tile-col']")!;
    expect(ref.current).toBe(btn);
    expect(btn.getAttribute("title")).toBe("Column");
    click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("disabled uses the one disabled idiom", () => {
    render(<Tile disabled icon={<Pic id="a" />} label="Column" onClick={() => {}} />);
    const btn = container.querySelector("button")!;
    expect(btn.disabled).toBe(true);
  });

  it("names itself in a tooltip on hover (the label is not visible)", () => {
    vi.useFakeTimers();
    render(<Tile icon={<Pic id="a" />} label="Column chart" onClick={() => {}} />);
    const btn = container.querySelector("button")!;
    act(() => {
      btn.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null }));
    });
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    });
    expect(document.querySelector("[role='tooltip']")?.textContent).toBe("Column chart");
  });

  it.each([
    ["band", bandLayout()],
    ["panel", panelLayout(300)],
  ])("paints no hardcoded colour in the %s", (_name, layout) => {
    render(
      <>
        <Tile icon={<Pic id="a" />} label="A" selected onClick={() => {}} />
        <Tile role="radio" icon={<Pic id="b" />} label="B" selected={false} onClick={() => {}} />
        <Tile chevron icon={<Pic id="c" />} label="C" onClick={() => {}} />
      </>,
      layout,
    );
    expect(hardcodedColours(container)).toEqual([]);
  });
});

// ============================================================================
// Tile — popover
// ============================================================================

describe("Tile — popover", () => {
  it("is 64x60 with the icon fitted to 24px over a caption", () => {
    render(<Tile size="popover" icon={<Pic id="a" />} label="Clustered column" onClick={() => {}} />);
    const btn = container.querySelector("button")!;
    expect(btn.style.width).toBe("64px");
    expect(btn.style.height).toBe("60px");
    expect(btn.getAttribute("aria-label")).toBe("Clustered column");
    expect(btn.textContent).toBe("Clustered column");
    expect(getComputedStyle(btn).flexDirection).toBe("column");
    const svg = container.querySelector("[data-testid='pic-a']")!;
    expect(getComputedStyle(svg).width).toBe("24px");
  });

  it("a visible caption needs no tooltip", () => {
    vi.useFakeTimers();
    render(<Tile size="popover" icon={<Pic id="a" />} label="Clustered column" onClick={() => {}} />);
    act(() => {
      container.querySelector("button")!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    });
    expect(document.querySelector("[role='tooltip']")).toBeNull();
  });

  it("caption={false}: a 44x44 icon square that names itself in a tooltip", () => {
    vi.useFakeTimers();
    render(<Tile size="popover" caption={false} icon={<Pic id="a" />} label="Stacked" onClick={() => {}} />);
    const btn = container.querySelector("button")!;
    expect(btn.style.width).toBe("44px");
    expect(btn.style.height).toBe("44px");
    expect(btn.textContent).toBe("");
    act(() => {
      btn.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    });
    expect(document.querySelector("[role='tooltip']")?.textContent).toBe("Stacked");
  });

  it.each([
    ["band", bandLayout()],
    ["panel", panelLayout(300)],
  ])("paints no hardcoded colour in the %s", (_name, layout) => {
    render(
      <>
        <Tile size="popover" role="option" selected icon={<Pic id="a" />} label="A" onClick={() => {}} />
        <Tile size="popover" caption={false} icon={<Pic id="b" />} label="B" onClick={() => {}} />
      </>,
      layout,
    );
    expect(hardcodedColours(container)).toEqual([]);
  });
});

// ============================================================================
// TileGallery
// ============================================================================

const ITEMS: TileGalleryItem[] = [
  { value: "col", label: "Clustered column", icon: <Pic id="col" />, group: "Column" },
  { value: "stk", label: "Stacked column", icon: <Pic id="stk" />, group: "Column" },
  { value: "s100", label: "100% stacked column", icon: <Pic id="s100" />, group: "Column" },
  { value: "col3", label: "Column 3", icon: <Pic id="col3" />, group: "Column" },
  { value: "col4", label: "Column 4", icon: <Pic id="col4" />, group: "Column" },
  { value: "line", label: "Line", icon: <Pic id="line" />, group: "Line" },
  { value: "lmk", label: "Line with markers", icon: <Pic id="lmk" />, group: "Line" },
  { value: "pie", label: "Pie", icon: <Pic id="pie" /> },
];

function options(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("[role='option']"));
}

describe("TileGallery", () => {
  it("is a listbox of captioned popover tiles, grouped under headings in first-seen order", () => {
    render(<TileGallery items={ITEMS} value="line" onChange={() => {}} ariaLabel="Chart types" />, panelLayout(300));
    const list = container.querySelector("[role='listbox']")!;
    expect(list.getAttribute("aria-label")).toBe("Chart types");
    const groups = Array.from(list.querySelectorAll("[role='group']"));
    expect(groups).toHaveLength(3);
    const labelled = groups.map((g) => {
      const id = g.getAttribute("aria-labelledby");
      return id ? document.getElementById(id)?.textContent : null;
    });
    expect(labelled).toEqual(["Column", "Line", null]);
    expect(options().map((o) => o.textContent)).toEqual(ITEMS.map((i) => i.label));
    for (const o of options()) {
      expect(o.style.width).toBe("64px");
      expect(o.style.height).toBe("60px");
    }
  });

  it("marks the value aria-selected and makes it the one tab stop", () => {
    render(<TileGallery items={ITEMS} value="line" onChange={() => {}} />);
    const selected = options().filter((o) => o.getAttribute("aria-selected") === "true");
    expect(selected.map((o) => o.textContent)).toEqual(["Line"]);
    expect(options().filter((o) => o.tabIndex === 0)).toEqual(selected);
  });

  it("with no value the first tile is the tab stop", () => {
    render(<TileGallery items={ITEMS} value={null} onChange={() => {}} />);
    expect(options()[0].tabIndex).toBe(0);
    expect(options().filter((o) => o.getAttribute("aria-selected") === "true")).toHaveLength(0);
  });

  it("a click chooses", () => {
    const onChange = vi.fn();
    render(<TileGallery items={ITEMS} value="line" onChange={onChange} />);
    click(options()[2]);
    expect(onChange).toHaveBeenCalledWith("s100");
  });

  it("arrows move focus in 2-D across groups without choosing; Home/End jump", () => {
    const onChange = vi.fn();
    render(<TileGallery items={ITEMS} value={null} onChange={onChange} columns={4} />);
    const o = options();
    act(() => o[0].focus());
    key(o[0], "ArrowRight");
    expect(document.activeElement).toBe(o[1]);
    key(o[1], "ArrowDown");
    expect(document.activeElement).toBe(o[4]); // col 1 -> short second row clamps to its only tile
    key(o[4], "ArrowDown");
    expect(document.activeElement).toBe(o[5]); // into the Line group, clamped to col 0
    key(o[5], "ArrowDown");
    expect(document.activeElement).toBe(o[7]); // into the ungrouped Pie
    key(o[7], "Home");
    expect(document.activeElement).toBe(o[0]);
    key(o[0], "End");
    expect(document.activeElement).toBe(o[7]);
    expect(onChange).not.toHaveBeenCalled();
    // The roving tab stop followed focus.
    expect(o[7].tabIndex).toBe(0);
    expect(options().filter((x) => x.tabIndex === 0)).toHaveLength(1);
  });

  it("the grid honours `columns`", () => {
    render(<TileGallery items={ITEMS} value={null} onChange={() => {}} columns={3} />);
    const grid = options()[0].parentElement as HTMLElement;
    expect(grid.style.gridTemplateColumns).toBe("repeat(3, 64px)");
  });

  it("showLabels={false}: 44x44 tiles without captions", () => {
    render(<TileGallery items={ITEMS} value={null} onChange={() => {}} showLabels={false} />);
    for (const o of options()) {
      expect(o.style.width).toBe("44px");
      expect(o.textContent).toBe("");
      expect(o.getAttribute("aria-label")).toBeTruthy();
    }
    expect((options()[0].parentElement as HTMLElement).style.gridTemplateColumns).toBe("repeat(4, 44px)");
  });

  it("testIdPrefix names the list and every tile", () => {
    render(<TileGallery items={ITEMS} value={null} onChange={() => {}} testIdPrefix="chart-type" />);
    expect(container.querySelector("[data-testid='chart-type']")!.getAttribute("role")).toBe("listbox");
    expect(container.querySelector("[data-testid='chart-type-pie']")!.textContent).toBe("Pie");
  });

  it.each([
    ["band", bandLayout()],
    ["panel", panelLayout(300)],
  ])("paints no hardcoded colour in the %s", (_name, layout) => {
    render(<TileGallery items={ITEMS} value="stk" onChange={() => {}} />, layout);
    expect(hardcodedColours(container)).toEqual([]);
  });
});
