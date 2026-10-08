//! FILENAME: app/extensions/CanvasSheet/__tests__/canvasVisualsSection.test.tsx
// PURPOSE: The Canvas tab's VISUALS group, rendered (CONTRACT-CANVAS sections
//          1-2): in the band, Power BI's first two pane rows as two rows of
//          20px icon buttons and an All Visuals hero whose card is the whole
//          catalogue -- a TileGallery, six columns, under the contract's
//          headings, moved through with the arrow keys in two dimensions. Each
//          row button and each tile inserts ITS visual. On a subscribed canvas
//          nothing inserts. In a panel (sidebar, a folded launcher) the
//          catalogue is shown inline.
//
//          Test ids: a row button is `canvas-visual-<visualId>`, except the two
//          rows that ARE the old Insert heroes -- Slicer keeps
//          `canvas-insert-slicer` and Matrix keeps `canvas-insert-pivot` (live
//          E2E specs press them). A gallery tile is `canvas-visual-gallery-<id>`
//          (the Chart Design gallery's "chart-type" / "chart-type-gallery"
//          precedent), so a row and its tile never share an id while the card
//          is open over the band.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";

const h = vi.hoisted(() => ({
  snapshot: { active: null as unknown, activeSubscribed: false, activeIndex: 2, version: 1 },
  inserted: [] as string[],
}));

vi.mock("../lib/canvasSheetStore", () => ({
  getCanvasSheetSnapshot: () => h.snapshot,
  subscribeCanvasSheets: () => () => {},
}));
vi.mock("../lib/canvasVisuals", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/canvasVisuals")>()),
  insertCanvasVisual: async (id: string) => {
    h.inserted.push(id);
  },
}));

import type { PanelSectionProps } from "@api/uiTypes";
import { CanvasVisualsSection } from "../components/CanvasVisualsSection";
import { CANVAS_VISUALS, CANVAS_VISUAL_GROUPS, CANVAS_VISUAL_ROWS, canvasVisual } from "../lib/canvasVisuals";
import { SUBSCRIBED_NOTE } from "../lib/canvasNotes";
import { byTestId, click, drawsIcon, flush, maybeTestId, mountHarness, testIdsWithPrefix, type Harness } from "./tabHarness";

const PROPS = { placement: "ribbon" } as unknown as PanelSectionProps;

/** The id a row button carries (see the header). */
function rowTestId(id: string): string {
  if (id === "slicer") return "canvas-insert-slicer";
  if (id === "matrix") return "canvas-insert-pivot";
  return `canvas-visual-${id}`;
}

let hn: Harness;

beforeEach(() => {
  h.snapshot = { active: { index: 2, name: "Report", layout: {} }, activeSubscribed: false, activeIndex: 2, version: 1 };
  h.inserted = [];
  hn = mountHarness();
});

afterEach(() => hn.unmount());

function render(surface: "band" | "panel" = "band"): void {
  hn.render(<CanvasVisualsSection {...PROPS} />, surface);
}

function openGallery(): HTMLElement {
  click(byTestId("canvas-all-visuals", hn.container));
  return byTestId<HTMLElement>("canvas-visual-gallery");
}

describe("the two band rows", () => {
  it("are Power BI's first two pane rows, in order, each its own picture", () => {
    render();
    const rows = CANVAS_VISUAL_ROWS.flat();
    for (const id of rows) {
      const button = byTestId(rowTestId(id), hn.container);
      expect(drawsIcon(button, canvasVisual(id).icon), `${id} draws ${canvasVisual(id).icon}`).toBe(true);
      expect(button.getAttribute("aria-label")).toBe(canvasVisual(id).label);
    }
    const order = [...hn.container.querySelectorAll<HTMLElement>("[data-testid]")]
      .map((e) => e.getAttribute("data-testid"))
      .filter((t) => rows.map(rowTestId).includes(t ?? ""));
    expect(order).toEqual(rows.map(rowTestId));
  });

  it("each row button inserts its visual", () => {
    render();
    for (const id of CANVAS_VISUAL_ROWS.flat()) click(byTestId(rowTestId(id), hn.container));
    expect(h.inserted).toEqual(CANVAS_VISUAL_ROWS.flat());
  });

  it("the old Insert ids live on: Slicer and Matrix", () => {
    render();
    expect(byTestId("canvas-insert-slicer", hn.container).getAttribute("aria-label")).toBe("Slicer");
    expect(byTestId("canvas-insert-pivot", hn.container).getAttribute("aria-label")).toBe("Matrix");
  });
});

describe("All Visuals", () => {
  it("is a hero with the AllVisuals picture that opens a card", () => {
    render();
    const hero = byTestId("canvas-all-visuals", hn.container);
    expect(hero.textContent).toContain("All Visuals");
    expect(drawsIcon(hero, "AllVisuals")).toBe(true);
    expect(hero.getAttribute("aria-haspopup")).toBe("dialog");
    expect(hero.getAttribute("aria-expanded")).toBe("false");
    openGallery();
    expect(hero.getAttribute("aria-expanded")).toBe("true");
  });

  it("holds every visual of the catalogue, in order, under the contract's headings", () => {
    render();
    const gallery = openGallery();
    expect(testIdsWithPrefix("canvas-visual-gallery-", gallery)).toEqual(
      CANVAS_VISUALS.map((v) => `canvas-visual-gallery-${v.id}`),
    );
    const text = gallery.textContent ?? "";
    let at = -1;
    for (const heading of CANVAS_VISUAL_GROUPS) {
      const next = text.indexOf(heading, at + 1);
      expect(next, `heading ${heading}`).toBeGreaterThan(at);
      at = next;
    }
  });

  it("each tile draws its visual's picture", () => {
    render();
    const gallery = openGallery();
    for (const v of CANVAS_VISUALS) {
      expect(drawsIcon(byTestId(`canvas-visual-gallery-${v.id}`, gallery), v.icon), v.id).toBe(true);
    }
  });

  it("is six columns wide, and the arrow keys move in TWO dimensions", () => {
    render();
    const gallery = openGallery();
    const tiles = CANVAS_VISUALS.slice(0, 6).map((v) => byTestId(`canvas-visual-gallery-${v.id}`, gallery));
    // The first group (Bar & column) is exactly one row of six.
    act(() => tiles[0].focus());
    act(() => {
      tiles[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(document.activeElement).toBe(tiles[1]);
    act(() => {
      tiles[1].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    // Down from the second tile lands in the NEXT row's second column: Area.
    expect(document.activeElement).toBe(byTestId(`canvas-visual-gallery-${CANVAS_VISUALS[7].id}`, gallery));
  });

  it("a pick inserts that visual and closes the card", async () => {
    render();
    const gallery = openGallery();
    click(byTestId("canvas-visual-gallery-gauge", gallery));
    await flush();
    expect(h.inserted).toEqual(["gauge"]);
    expect(maybeTestId("canvas-visual-gallery")).toBeNull();
    expect(byTestId("canvas-all-visuals", hn.container).getAttribute("aria-expanded")).toBe("false");
  });
});

describe("a subscribed canvas", () => {
  it("disables every row button and the hero, with the subscribed note", () => {
    h.snapshot = { ...h.snapshot, activeSubscribed: true };
    render();
    for (const id of CANVAS_VISUAL_ROWS.flat()) expect(byTestId(rowTestId(id), hn.container).disabled).toBe(true);
    const hero = byTestId("canvas-all-visuals", hn.container);
    expect(hero.disabled).toBe(true);
    click(hero);
    expect(maybeTestId("canvas-visual-gallery")).toBeNull();
    expect(h.inserted).toEqual([]);
    expect(SUBSCRIBED_NOTE).toMatch(/publisher/);
  });

  it("in a panel, shows the note instead of a gallery that cannot insert", () => {
    h.snapshot = { ...h.snapshot, activeSubscribed: true };
    render("panel");
    expect(maybeTestId("canvas-visual-gallery", hn.container)).toBeNull();
    expect(hn.container.textContent).toContain(SUBSCRIBED_NOTE);
  });
});

describe("in a panel (the sidebar, a folded launcher)", () => {
  it("the whole catalogue is inline, and a tile inserts", async () => {
    render("panel");
    const gallery = byTestId<HTMLElement>("canvas-visual-gallery", hn.container);
    // Every visual but the two whose tiles keep the old Insert ids (below).
    expect(testIdsWithPrefix("canvas-visual-gallery-", gallery)).toHaveLength(CANVAS_VISUALS.length - 2);
    click(byTestId("canvas-visual-gallery-kpi", gallery));
    await flush();
    expect(h.inserted).toEqual(["kpi"]);
  });

  // Review finding (2026-10-08): the kept ids existed only in the BAND rows,
  // so once the Visuals group folded into its launcher flyout (or moved to
  // the sidebar) `canvas-insert-slicer` / `canvas-insert-pivot` vanished --
  // and with them the live specs that press them. In a panel there is no
  // card over the band, so the tile can carry the kept id without a twin.
  it("the old Insert ids live on in a panel too: the Slicer and Matrix tiles", async () => {
    render("panel");
    const gallery = byTestId<HTMLElement>("canvas-visual-gallery", hn.container);
    const slicer = byTestId("canvas-insert-slicer", gallery);
    const matrix = byTestId("canvas-insert-pivot", gallery);
    expect(slicer.getAttribute("aria-label")).toBe("Slicer");
    expect(matrix.getAttribute("aria-label")).toBe("Matrix");
    click(slicer);
    click(matrix);
    await flush();
    expect(h.inserted).toEqual(["slicer", "matrix"]);
  });
});

it("is not shown off a canvas", () => {
  h.snapshot = { active: null, activeSubscribed: false, activeIndex: 0, version: 1 };
  render();
  expect(hn.container.innerHTML).toBe("");
});
