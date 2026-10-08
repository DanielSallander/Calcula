//! FILENAME: app/extensions/CanvasSheet/__tests__/canvasElementsSection.test.tsx
// PURPOSE: The Canvas tab's ELEMENTS group, rendered (CONTRACT-CANVAS sections
//          1 and 3; Power BI's Insert > Elements): Text Box, Buttons v, Shapes v,
//          Image, Floating Grid -- five heroes in that order, each with the
//          picture the icon lanes drew for it. Buttons and Shapes are SPLIT:
//          the face inserts the everyday one (a blank button, a rectangle) and
//          keeps the old Insert id (`canvas-insert-button`,
//          `canvas-insert-shape`, pressed by live E2E specs); the chevron
//          (`canvas-buttons`, `canvas-shapes`) opens Power BI's menu.
//
//          Buttons: Blank, Run Macro..., then Page Navigator, Back, Clear All
//          Slicers -- the last three DECLARATIVE actions (@api/buttonControlService),
//          never code. Shapes: "Basic shapes" and "Arrows" with a picture of
//          each shape drawn from the catalog's OWN geometry (the seam's
//          `thumbnail`), then More Shapes > the whole catalog by category.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";

const h = vi.hoisted(() => ({
  snapshot: { active: null as unknown, activeSubscribed: false, activeIndex: 2, version: 1 },
  calls: [] as unknown[][],
  navigator: 0,
  catalog: [] as unknown[],
}));

vi.mock("../lib/canvasSheetStore", () => ({
  getCanvasSheetSnapshot: () => h.snapshot,
  subscribeCanvasSheets: () => () => {},
}));
vi.mock("../lib/insertOnCanvas", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/insertOnCanvas")>()),
  insertOnCanvas: async (...a: unknown[]) => {
    h.calls.push(a);
  },
}));
vi.mock("../lib/pageNavigator", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/pageNavigator")>()),
  insertPageNavigator: async () => {
    h.navigator += 1;
  },
}));
vi.mock("@api/controlsService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/controlsService")>()),
  getControlsProvider: () => ({ listShapeCatalog: () => h.catalog }),
}));

import type { PanelSectionProps } from "@api/uiTypes";
import { CommandRegistry } from "@api/commands";
import { CanvasElementsSection } from "../components/CanvasElementsSection";
import { BASIC_SHAPE_ROWS, ARROW_SHAPE_ROWS, MACRO_LIBRARY_COMMAND } from "../lib/canvasElements";
import { SUBSCRIBED_NOTE } from "../lib/canvasNotes";
import { renderToStaticMarkup } from "react-dom/server";
import { ShapeThumbnail } from "../components/tabParts";
import { byTestId, click, drawsIcon, flush, maybeTestId, mountHarness, rowLabel, testIdsWithPrefix, type Harness } from "./tabHarness";

const PROPS = { placement: "ribbon" } as unknown as PanelSectionProps;

/** A catalog row as Controls lists it, with a thumbnail of its own. */
function entry(id: string, categoryId: string, categoryLabel: string, isLine = false) {
  return {
    id,
    label: `Catalog ${id}`,
    categoryId,
    categoryLabel,
    defaultWidth: 160,
    defaultHeight: 100,
    isLine,
    // A path of its own per shape, so a row drawing a NEIGHBOUR's picture fails.
    thumbnail: { viewBox: "-0.05 -0.05 1.1 1.1", d: `M0 0 L1 0 L1 1 Z M${id} 0` },
  };
}

const CONTRACT_BASIC = [
  "rectangle", "roundedRectangle", "oval", "line", "isoscelesTriangle", "rightTriangle", "parallelogram",
  "trapezoid", "diamond", "pentagon", "hexagon", "octagon", "heart", "roundedRectangularCallout",
  "roundSameSide", "snipSameSide",
];
const CONTRACT_ARROWS = ["rightArrow", "leftArrow", "upArrow", "downArrow", "homePentagon", "chevron"];

function fullCatalog() {
  return [
    entry("line", "lines", "Lines", true),
    entry("curvedConnector", "lines", "Lines", true),
    entry("rectangle", "rectangles", "Rectangles"),
    entry("roundedRectangle", "rectangles", "Rectangles"),
    entry("roundSameSide", "rectangles", "Rectangles"),
    entry("snipSameSide", "rectangles", "Rectangles"),
    ...["oval", "isoscelesTriangle", "rightTriangle", "parallelogram", "trapezoid", "diamond", "pentagon", "hexagon", "octagon", "heart", "textBox"].map((id) =>
      entry(id, "basicShapes", "Basic Shapes"),
    ),
    ...CONTRACT_ARROWS.map((id) => entry(id, "blockArrows", "Block Arrows")),
    entry("roundedRectangularCallout", "callouts", "Callouts"),
    entry("star5", "starsAndBanners", "Stars and Banners"),
  ];
}

let hn: Harness;
const cleanups: Array<() => void> = [];

beforeEach(() => {
  h.snapshot = { active: { index: 2, name: "Report", layout: {} }, activeSubscribed: false, activeIndex: 2, version: 1 };
  h.calls = [];
  h.navigator = 0;
  h.catalog = fullCatalog();
  hn = mountHarness();
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  if (CommandRegistry.has(MACRO_LIBRARY_COMMAND)) CommandRegistry.unregister(MACRO_LIBRARY_COMMAND);
  hn.unmount();
});

function render(surface: "band" | "panel" = "band"): void {
  hn.render(<CanvasElementsSection {...PROPS} />, surface);
}

const HEROES: ReadonlyArray<[string, string, Parameters<typeof drawsIcon>[1]]> = [
  ["canvas-insert-textBox", "Text Box", "Text"],
  ["canvas-insert-button", "Buttons", "ButtonControl"],
  ["canvas-insert-shape", "Shapes", "Shapes"],
  ["canvas-insert-picture", "Image", "Image"],
  ["canvas-insert-floatingGrid", "Floating Grid", "FloatingGrid"],
];

describe("the five heroes", () => {
  it("in Power BI's order, each with its own picture", () => {
    render();
    expect(testIdsWithPrefix("canvas-insert-", hn.container)).toEqual(HEROES.map(([id]) => id));
    for (const [id, label, icon] of HEROES) {
      const el = byTestId(id, hn.container);
      const named = el.getAttribute("aria-label") ?? el.textContent ?? "";
      expect(named, id).toContain(label);
      expect(drawsIcon(el, icon), `${id} draws ${icon}`).toBe(true);
    }
  });

  it("the faces insert the everyday object", () => {
    render();
    for (const [id] of HEROES) click(byTestId(id, hn.container));
    expect(h.calls).toEqual([
      ["textBox"],
      ["button", { button: "blank" }],
      ["shape", { shapeId: "rectangle" }],
      ["picture"],
      ["floatingGrid"],
    ]);
  });

  it("Buttons and Shapes open their menus from the chevron half", () => {
    render();
    const buttons = byTestId("canvas-buttons", hn.container);
    const shapes = byTestId("canvas-shapes", hn.container);
    expect(buttons.getAttribute("aria-haspopup")).toBe("menu");
    expect(shapes.getAttribute("aria-haspopup")).toBe("menu");
  });
});

describe("Buttons v", () => {
  const ROWS: ReadonlyArray<[string, string, Parameters<typeof drawsIcon>[1]]> = [
    ["canvas-buttons-blank", "Blank", "ButtonControl"],
    ["canvas-buttons-macro", "Run Macro...", "Play"],
    ["canvas-buttons-pageNavigator", "Page Navigator", "PageNavigator"],
    ["canvas-buttons-back", "Back", "NavigateBack"],
    ["canvas-buttons-clearSlicers", "Clear All Slicers", "ClearSlicers"],
  ];

  it("rows in order, worded and pictured, with a rule before the actions", () => {
    CommandRegistry.register(MACRO_LIBRARY_COMMAND, () => {});
    render();
    click(byTestId("canvas-buttons", hn.container));
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    expect(testIdsWithPrefix("canvas-buttons-", menu)).toEqual(ROWS.map(([id]) => id));
    for (const [id, label, icon] of ROWS) {
      const row = byTestId(id, menu);
      expect(rowLabel(row)).toBe(label);
      expect(drawsIcon(row, icon), `${id} draws ${icon}`).toBe(true);
    }
    const kids = [...menu.children];
    const sep = kids.findIndex((k) => k.getAttribute("role") === "separator");
    expect(sep).toBe(kids.indexOf(byTestId("canvas-buttons-pageNavigator", menu)) - 1);
  });

  it("each row inserts its button (the actions are declarative, the page navigator is a row of them)", async () => {
    const opened: unknown[] = [];
    CommandRegistry.register(MACRO_LIBRARY_COMMAND, () => {
      opened.push("library");
    });
    render();
    for (const id of ["blank", "back", "clearSlicers", "pageNavigator", "macro"]) {
      click(byTestId("canvas-buttons", hn.container));
      click(byTestId(`canvas-buttons-${id}`));
      await flush();
    }
    expect(h.calls).toEqual([
      ["button", { button: "blank" }],
      ["button", { button: "back" }],
      ["button", { button: "clearSlicers" }],
    ]);
    expect(h.navigator).toBe(1);
    // Run Macro... is the existing macroRef flow: Developer > Macros, where a
    // macro's "Add button" LINKS a button to it.
    expect(opened).toEqual(["library"]);
  });

  it("Run Macro... is disabled when no macro library is loaded", () => {
    render();
    click(byTestId("canvas-buttons", hn.container));
    expect(byTestId("canvas-buttons-macro").disabled).toBe(true);
  });
});

describe("Shapes v", () => {
  function openShapes(): HTMLElement {
    click(byTestId("canvas-shapes", hn.container));
    return document.querySelector<HTMLElement>('[role="menu"]')!;
  }

  it("the contract's rows, in order, under Basic shapes and Arrows", () => {
    expect(BASIC_SHAPE_ROWS.map((r) => r.id)).toEqual(CONTRACT_BASIC);
    expect(ARROW_SHAPE_ROWS.map((r) => r.id)).toEqual(CONTRACT_ARROWS);
    render();
    const menu = openShapes();
    const ids = testIdsWithPrefix("canvas-shapes-", menu).filter((id) => id !== "canvas-shapes-more");
    expect(ids).toEqual([...CONTRACT_BASIC, ...CONTRACT_ARROWS].map((id) => `canvas-shapes-${id}`));
    const text = menu.textContent ?? "";
    expect(text.indexOf("Basic shapes")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("Arrows")).toBeGreaterThan(text.indexOf("Basic shapes"));
  });

  it("Power BI's names: Speech bubble, Tab: rounded / snipped top corners, Pentagon arrow", () => {
    render();
    const menu = openShapes();
    expect(rowLabel(byTestId("canvas-shapes-roundedRectangularCallout", menu))).toBe("Speech bubble");
    expect(rowLabel(byTestId("canvas-shapes-roundSameSide", menu))).toBe("Tab: rounded top corners");
    expect(rowLabel(byTestId("canvas-shapes-snipSameSide", menu))).toBe("Tab: snipped top corners");
    expect(rowLabel(byTestId("canvas-shapes-homePentagon", menu))).toBe("Pentagon arrow");
  });

  it("each row shows the catalog's OWN picture of the shape (its thumbnail path)", () => {
    render();
    const menu = openShapes();
    for (const id of [...CONTRACT_BASIC, ...CONTRACT_ARROWS]) {
      const want = (h.catalog as Array<{ id: string; thumbnail: { d: string; viewBox: string } }>).find((e) => e.id === id)!.thumbnail;
      const svg = byTestId(`canvas-shapes-${id}`, menu).querySelector("svg[data-shape-thumbnail]");
      expect(svg, id).not.toBeNull();
      expect(svg!.getAttribute("viewBox")).toBe(want.viewBox);
      expect(svg!.querySelector("path")!.getAttribute("d")).toBe(want.d);
    }
  });

  // Review finding (2026-10-08): the thumbnail path is the shape at a SQUARE
  // box (the seam says so), and the row drew it in a square, so a 2:1 right
  // arrow looked as tall as it is wide and an up arrow was squashed the other
  // way. The picture is now drawn at the shape's own proportions
  // (defaultWidth x defaultHeight) inside the square icon column.
  it("each shape is drawn in its OWN proportions inside the square icon column", () => {
    const thumbnail = { viewBox: "-0.05 -0.05 1.1 1.1", d: "M0 0 L1 0 L1 1 Z" };
    const draw = (defaultWidth: number, defaultHeight: number, isLine = false) => {
      const html = renderToStaticMarkup(
        <ShapeThumbnail entry={{ thumbnail, isLine, defaultWidth, defaultHeight }} size={20} />,
      );
      const box = document.createElement("div");
      box.innerHTML = html;
      return box.querySelector<SVGSVGElement>("svg[data-shape-thumbnail]")!;
    };
    const wide = draw(120, 60);
    expect([wide.getAttribute("width"), wide.getAttribute("height")]).toEqual(["20", "10"]);
    expect(wide.getAttribute("preserveAspectRatio")).toBe("none");
    const tall = draw(60, 120);
    expect([tall.getAttribute("width"), tall.getAttribute("height")]).toEqual(["10", "20"]);
    // The square ones, and a line (its box is its direction, not a shape), stay square.
    const square = draw(100, 100);
    expect([square.getAttribute("width"), square.getAttribute("height")]).toEqual(["20", "20"]);
    const line = draw(120, 10, true);
    expect([line.getAttribute("width"), line.getAttribute("height")]).toEqual(["20", "20"]);
    // The row keeps a square slot whatever the drawing's shape.
    const slot = wide.parentElement!;
    expect([slot.style.width, slot.style.height]).toEqual(["20px", "20px"]);
  });

  it("a line is drawn as a stroke, a shape is filled", () => {
    render();
    const menu = openShapes();
    const line = byTestId("canvas-shapes-line", menu).querySelector("path")!;
    const rect = byTestId("canvas-shapes-rectangle", menu).querySelector("path")!;
    expect(line.getAttribute("fill")).toBe("none");
    expect(rect.getAttribute("fill")).not.toBe("none");
  });

  it("a pick inserts that shape by its id (the catalog's size applies)", () => {
    render();
    click(byTestId("canvas-shapes-heart", openShapes()));
    expect(h.calls).toEqual([["shape", { shapeId: "heart" }]]);
  });

  it("a row whose shape the catalog does not hold is left out, never shown dead", () => {
    h.catalog = fullCatalog().filter((e) => e.id !== "heart");
    render();
    expect(maybeTestId("canvas-shapes-heart", openShapes())).toBeNull();
  });

  it("More Shapes opens the WHOLE catalog, by category, and a pick there inserts too", async () => {
    render();
    const menu = openShapes();
    const more = byTestId("canvas-shapes-more", menu);
    expect(rowLabel(more)).toBe("More Shapes");
    click(more);
    await flush();
    const categories = testIdsWithPrefix("canvas-shapes-more-category-");
    expect(categories).toEqual(
      ["lines", "rectangles", "basicShapes", "blockArrows", "callouts", "starsAndBanners"].map((c) => `canvas-shapes-more-category-${c}`),
    );
    click(byTestId("canvas-shapes-more-category-starsAndBanners"));
    await flush();
    const star = byTestId("canvas-shapes-more-star5");
    expect(rowLabel(star)).toBe("Catalog star5");
    click(star);
    expect(h.calls).toEqual([["shape", { shapeId: "star5" }]]);
  });
});

describe("a subscribed canvas", () => {
  it("every hero is disabled, with the subscribed note, and nothing inserts", () => {
    h.snapshot = { ...h.snapshot, activeSubscribed: true };
    render();
    for (const [id] of HEROES) {
      const el = byTestId(id, hn.container);
      expect(el.disabled || el.getAttribute("aria-disabled") === "true", id).toBe(true);
      click(el);
    }
    for (const id of ["canvas-buttons", "canvas-shapes"]) {
      const el = byTestId(id, hn.container);
      expect(el.disabled || el.getAttribute("aria-disabled") === "true", id).toBe(true);
      click(el);
      expect(document.querySelector('[role="menu"]')).toBeNull();
    }
    expect(h.calls).toEqual([]);
    expect(SUBSCRIBED_NOTE).toMatch(/publisher/);
  });
});

it("is not shown off a canvas", () => {
  h.snapshot = { active: null, activeSubscribed: false, activeIndex: 0, version: 1 };
  render();
  expect(hn.container.innerHTML).toBe("");
});
