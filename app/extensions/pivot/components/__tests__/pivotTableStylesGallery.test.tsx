//! FILENAME: app/extensions/Pivot/components/__tests__/pivotTableStylesGallery.test.tsx
// PURPOSE: The PivotTable Styles gallery on the @api StyleGallery: a 61px
//          thumbnail strip + expand popover in the band, the grouped grid inline
//          in a panel, a Clear command, live preview through onStylePreview,
//          and the names Pivot/index.ts imports from this module.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@api/gridOverlays", () => ({ requestOverlayRedraw: vi.fn() }));

import {
  SurfaceLayoutProvider,
  bandLayout,
  panelLayout,
  findHardcodedColours,
  type SurfaceLayout,
} from "@api/layout";
import {
  PivotTableStylesGallery,
  PivotStyleThumbnail,
  DEFAULT_PIVOT_STYLE_ID,
  PIVOT_STYLES,
  PIVOT_STYLES_BY_ID,
  getThemeOverridesForStyle,
} from "../PivotTableStylesGallery";
import * as styleData from "../../lib/pivotStyles";

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
  vi.clearAllMocks();
});

function render(node: React.ReactNode, layout: SurfaceLayout = bandLayout()): void {
  act(() => {
    root.render(<SurfaceLayoutProvider value={layout}>{node}</SurfaceLayoutProvider>);
  });
}

function props(overrides: Partial<React.ComponentProps<typeof PivotTableStylesGallery>> = {}) {
  return {
    selectedStyleId: DEFAULT_PIVOT_STYLE_ID,
    onStyleSelect: vi.fn(),
    onStyleClear: vi.fn(),
    onStylePreview: vi.fn(),
    ...overrides,
  };
}

function click(el: Element): void {
  act(() => {
    (el as HTMLElement).click();
  });
}

describe("PivotTableStylesGallery — module contract", () => {
  it("re-exports the style data names Pivot/index.ts imports from here", () => {
    expect(DEFAULT_PIVOT_STYLE_ID).toBe(styleData.DEFAULT_PIVOT_STYLE_ID);
    expect(PIVOT_STYLES).toBe(styleData.PIVOT_STYLES);
    expect(PIVOT_STYLES_BY_ID).toBe(styleData.PIVOT_STYLES_BY_ID);
    expect(getThemeOverridesForStyle).toBe(styleData.getThemeOverridesForStyle);
  });
});

describe("PivotTableStylesGallery — band", () => {
  it("renders a thumbnail strip, an expand button and Clear, with no hardcoded chrome colour", () => {
    render(<PivotTableStylesGallery {...props()} />);
    const strip = container.querySelector('[data-testid="pivot-style"]')!;
    expect(strip).not.toBeNull();
    const options = strip.querySelectorAll('[role="option"]');
    expect(options.length).toBe(3);
    // The applied style is always visible in the strip, and selected.
    const selected = strip.querySelector('[aria-selected="true"]');
    expect(selected?.getAttribute("data-testid")).toBe(`pivot-style-${DEFAULT_PIVOT_STYLE_ID}`);
    expect(container.querySelector('[data-testid="pivot-style-expand"]')?.getAttribute("aria-label"))
      .toBe("More PivotTable Styles");
    expect(container.querySelector('[data-testid="pivot-style-clear"]')?.textContent).toBe("Clear");
    expect(findHardcodedColours(container)).toEqual([]);
  });

  it("draws each thumbnail as SVG colour DATA, never a canvas", () => {
    render(<PivotTableStylesGallery {...props()} />);
    expect(container.querySelector("canvas")).toBeNull();
    const thumbs = container.querySelectorAll("svg[data-pivot-style]");
    expect(thumbs.length).toBe(3);
    for (const svg of Array.from(thumbs)) {
      expect(svg.closest("[data-colour-data]")).not.toBeNull();
      expect(svg.getAttribute("width")).toBe("56");
      expect(svg.getAttribute("height")).toBe("40");
    }
  });

  it("commits a style on click, after ending the preview", () => {
    const p = props();
    render(<PivotTableStylesGallery {...p} />);
    const first = container.querySelector('[data-testid="pivot-style"] [role="option"]')!;
    const id = first.getAttribute("data-testid")!.replace("pivot-style-", "");
    act(() => {
      first.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(p.onStylePreview).toHaveBeenLastCalledWith(id);
    click(first);
    expect(p.onStylePreview).toHaveBeenLastCalledWith(null);
    expect(p.onStyleSelect).toHaveBeenCalledWith(id);
  });

  it("ends a preview when the pointer leaves", () => {
    const p = props();
    render(<PivotTableStylesGallery {...p} />);
    const option = container.querySelectorAll('[data-testid="pivot-style"] [role="option"]')[1];
    act(() => {
      option.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(p.onStylePreview).toHaveBeenLastCalledWith(
      option.getAttribute("data-testid")!.replace("pivot-style-", ""),
    );
    act(() => {
      option.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
    });
    expect(p.onStylePreview).toHaveBeenLastCalledWith(null);
    expect(p.onStyleSelect).not.toHaveBeenCalled();
  });

  it("Clear runs onStyleClear", () => {
    const p = props();
    render(<PivotTableStylesGallery {...p} />);
    click(container.querySelector('[data-testid="pivot-style-clear"]')!);
    expect(p.onStyleClear).toHaveBeenCalledTimes(1);
    expect(p.onStyleSelect).not.toHaveBeenCalled();
  });

  it("a cleared style selects nothing", () => {
    render(<PivotTableStylesGallery {...props({ selectedStyleId: "" })} />);
    expect(container.querySelector('[aria-selected="true"]')).toBeNull();
  });

  it("the expand button opens every style grouped Light / Medium / Dark, and a choice commits", () => {
    const p = props();
    render(<PivotTableStylesGallery {...p} />);
    click(container.querySelector('[data-testid="pivot-style-expand"]')!);
    const popoverOptions = document.body.querySelectorAll('[data-testid^="pivot-style-option-"]');
    expect(popoverOptions.length).toBe(PIVOT_STYLES.length);
    const headings = Array.from(document.body.querySelectorAll('[role="group"]'))
      .map((g) => g.textContent?.match(/^(Light|Medium|Dark)/)?.[1])
      .filter(Boolean);
    expect(headings).toEqual(["Light", "Medium", "Dark"]);
    const target = document.body.querySelector('[data-testid="pivot-style-option-PivotStyleDark3"]')!;
    expect(target.getAttribute("aria-label")).toBe("Pivot Style Dark 3");
    click(target);
    expect(p.onStyleSelect).toHaveBeenCalledWith("PivotStyleDark3");
    expect(document.body.querySelector('[data-testid^="pivot-style-option-"]')).toBeNull();
  });
});

describe("PivotTableStylesGallery — panel", () => {
  it("renders the whole grouped grid inline with Clear, and no hardcoded chrome colour", () => {
    const p = props();
    render(<PivotTableStylesGallery {...p} />, panelLayout(320));
    const options = container.querySelectorAll('[role="option"]');
    expect(options.length).toBe(PIVOT_STYLES.length);
    expect(container.querySelector('[data-testid="pivot-style-expand"]')).toBeNull();
    expect(container.querySelector('[data-testid="pivot-style-clear"]')).not.toBeNull();
    expect(findHardcodedColours(container)).toEqual([]);
    click(container.querySelector('[data-testid="pivot-style-PivotStyleMedium4"]')!);
    expect(p.onStyleSelect).toHaveBeenCalledWith("PivotStyleMedium4");
  });
});

describe("PivotStyleThumbnail", () => {
  it("paints the style's header colour in its first row", () => {
    const style = PIVOT_STYLES_BY_ID.get("PivotStyleMedium2")!;
    render(<PivotStyleThumbnail style={style} width={56} height={40} />);
    const rects = container.querySelectorAll("rect");
    const colours = styleData.getPivotThumbColors(style);
    // rects[0] is the ground, rects[1] the header row.
    expect(rects[1].getAttribute("fill")).toBe(colours.headerBg);
    const outline = rects[rects.length - 1];
    expect(outline.getAttribute("stroke")).toBe(colours.accentColor);
    expect(outline.getAttribute("fill")).toBe("none");
  });
});
