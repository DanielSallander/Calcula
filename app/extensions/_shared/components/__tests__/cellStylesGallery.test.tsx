//! FILENAME: app/extensions/_shared/components/__tests__/cellStylesGallery.test.tsx
// PURPOSE: The Cell Styles gallery (Home "Cell Styles" hero popover, Format
//          menu) is the ONE @api StyleGallery over the CELL_STYLES catalog:
//          every style is a keyboard-operable option in a grouped grid, a
//          choice applies the style's formatting and closes the host, and the
//          chrome paints with tokens only while each thumbnail — a drawing of
//          a cell in that style — is marked as colour DATA.
// CONTEXT: The gallery is hosted inside a popover portalled OUT of the ribbon
//          band, so it inherits the band's surface layout through context. It
//          must still render as the grid, never as the band's 61px strip.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import {
  SurfaceLayoutProvider,
  bandLayout,
  panelLayout,
  findHardcodedColours,
  type SurfaceLayout,
} from "@api/layout";
import {
  CELL_STYLES,
  CELL_STYLES_BY_ID,
  CellStylesGallery,
  cellStyleThumbStyle,
} from "../CellStylesGallery";

const LAYOUTS: Array<[string, SurfaceLayout]> = [
  ["band", bandLayout()],
  ["panel", panelLayout(300)],
];

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

function render(node: React.ReactNode, layout: SurfaceLayout): void {
  act(() => {
    root.render(<SurfaceLayoutProvider value={layout}>{node}</SurfaceLayoutProvider>);
  });
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

function options(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('[role="option"]'));
}

describe("CellStylesGallery on the @api StyleGallery", () => {
  it.each(LAYOUTS)("renders every style as an option, tokens-only chrome, in the %s layout", (_n, layout) => {
    render(<CellStylesGallery onApplyStyle={() => {}} onClose={() => {}} />, layout);
    expect(options()).toHaveLength(CELL_STYLES.length);
    expect(findHardcodedColours(container)).toEqual([]);
    // The inline (menu) variant too.
    render(<CellStylesGallery onApplyStyle={() => {}} onClose={() => {}} inline />, layout);
    expect(findHardcodedColours(container)).toEqual([]);
  });

  it("stays a grid even when its host sits in the ribbon band (no strip, no expand button)", () => {
    render(<CellStylesGallery onApplyStyle={() => {}} onClose={() => {}} />, bandLayout());
    expect(container.querySelector('[data-testid="cell-style-expand"]')).toBeNull();
    expect(container.querySelector('[role="listbox"][aria-orientation="horizontal"]')).toBeNull();
    expect(container.querySelector('[role="listbox"][aria-label="Cell styles"]')).not.toBeNull();
  });

  it("groups the styles under the category headings, in catalog order", () => {
    render(<CellStylesGallery onApplyStyle={() => {}} onClose={() => {}} />, panelLayout(300));
    const groups = Array.from(container.querySelectorAll('[role="group"]')).map(
      (g) => document.getElementById(g.getAttribute("aria-labelledby") ?? "")?.textContent,
    );
    expect(groups).toEqual([
      "Good, Bad and Neutral",
      "Data and Model",
      "Titles and Headings",
      "Themed Cell Styles",
      "Number Format",
    ]);
  });

  it("lays the themed block out as one accent per column (six columns)", () => {
    render(<CellStylesGallery onApplyStyle={() => {}} onClose={() => {}} />, panelLayout(1000));
    const grid = container.querySelector<HTMLElement>('[role="group"] > div[style*="grid-template-columns"]');
    expect(grid?.style.gridTemplateColumns).toMatch(/^repeat\(6,/);
  });

  it("a choice applies the style's formatting and closes the host", async () => {
    const apply = vi.fn();
    const close = vi.fn();
    render(<CellStylesGallery onApplyStyle={apply} onClose={close} />, panelLayout(300));
    const bad = container.querySelector('[data-testid="cell-style-bad"]');
    expect(bad).not.toBeNull();
    await click(bad!);
    expect(apply).toHaveBeenCalledWith(CELL_STYLES_BY_ID.get("bad")!.formatting);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("'Normal' resets every property to the workbook default", async () => {
    const apply = vi.fn();
    render(<CellStylesGallery onApplyStyle={apply} onClose={() => {}} />, panelLayout(300));
    await click(container.querySelector('[data-testid="cell-style-normal"]')!);
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({
        bold: false,
        italic: false,
        underline: "none",
        fontSize: 11,
        numberFormat: "General",
        borderTop: { style: "none", color: "#000000" },
      }),
    );
  });

  it("every thumbnail is colour DATA and carries the style's name", () => {
    render(<CellStylesGallery onApplyStyle={() => {}} onClose={() => {}} />, panelLayout(300));
    for (const opt of options()) {
      const thumb = opt.querySelector("[data-colour-data]");
      expect(thumb).not.toBeNull();
      expect(opt.getAttribute("aria-label")).toBe(thumb!.textContent);
    }
  });

  it("the whole grid is one roving tab stop, and arrows move between styles", () => {
    render(<CellStylesGallery onApplyStyle={() => {}} onClose={() => {}} />, panelLayout(300));
    const opts = options();
    expect(opts.filter((o) => o.tabIndex === 0)).toHaveLength(1);
    act(() => opts[0].focus());
    act(() => {
      opts[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(document.activeElement).toBe(opts[1]);
  });
});

describe("cellStyleThumbStyle — a thumbnail is a drawing of the cell", () => {
  it("paints the style's own fill and text colour", () => {
    const s = cellStyleThumbStyle(CELL_STYLES_BY_ID.get("bad")!);
    expect(s.background).toBe("#ffc7ce");
    expect(s.color).toBe("#9c0006");
  });

  it("uses the grid's own colours where the style sets none (or sets the automatic ones)", () => {
    const normal = cellStyleThumbStyle(CELL_STYLES_BY_ID.get("normal")!);
    expect(normal.background).toBe("var(--grid-bg, #ffffff)");
    expect(normal.color).toBe("var(--grid-text, #000000)");
    const comma = cellStyleThumbStyle(CELL_STYLES_BY_ID.get("comma")!);
    expect(comma.background).toBe("var(--grid-bg, #ffffff)");
    // A borderless, fill-less cell still has an edge on a white popover.
    expect(comma.boxShadow).toContain("var(--grid-line");
  });

  it("draws the style's borders and scales heading sizes down", () => {
    const h1 = cellStyleThumbStyle(CELL_STYLES_BY_ID.get("heading1")!);
    expect(h1.borderBottom).toBe("2px solid #4472c4");
    expect(h1.fontSize).toBe(13);
    expect(h1.fontWeight).toBe(700);
    const total = cellStyleThumbStyle(CELL_STYLES_BY_ID.get("total")!);
    expect(total.borderBottom).toBe("3px double #4472c4");
    expect(total.borderTop).toBe("1px solid #4472c4");
    const calc = cellStyleThumbStyle(CELL_STYLES_BY_ID.get("calculation")!);
    expect(calc.borderLeft).toBe("1px solid #7f7f7f");
    expect(calc.borderRight).toBe("1px solid #7f7f7f");
  });
});
