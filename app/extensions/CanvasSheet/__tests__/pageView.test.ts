//! FILENAME: app/extensions/CanvasSheet/__tests__/pageView.test.ts
// PURPOSE: View > Page View (Power BI's Scale to fit): Fit to Page, Fit to
//          Width (new) and Actual Size, and which of the three the page is
//          shown at now -- the radio check of the menu. Also Pages > New Page,
//          which asks the sheet strip for a canvas through the shell's own
//          door (the one "Insert Canvas" uses).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const dispatched: unknown[] = [];
vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  dispatchGridAction: (a: unknown) => dispatched.push(a),
  setZoom: (z: number) => ({ type: "SET_ZOOM", z }),
  scrollToPosition: (x: number, y: number) => ({ type: "SCROLL", x, y }),
}));

let gridSnapshot: Record<string, unknown> | null = null;
vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => gridSnapshot,
}));

let active: Record<string, unknown> | null = null;
vi.mock("../lib/canvasSheetStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/canvasSheetStore")>()),
  getCanvasSheetSnapshot: () => ({ active, activeSubscribed: false, activeIndex: 1, version: 1 }),
}));

import { LAYOUT_PAGE_MARGIN, GRID_SCROLLBAR_GUTTER_PX } from "@api/layoutSurface";
import { CommandRegistry, CoreCommands } from "@api/commands";
import {
  NEW_CANVAS_PAGE_ARGS,
  addBlankCanvasPage,
  currentPageView,
  fitActiveCanvasToWidth,
  fitPageZoom,
  fitWidthZoom,
  pageViewOf,
} from "../lib/canvasActions";

const PAGE = { width: 1280, height: 720 };

beforeEach(() => {
  dispatched.length = 0;
  active = { index: 1, name: "Report", layout: { pageWidth: 1280, pageHeight: 720 } };
  gridSnapshot = { viewportDimensions: { width: 1000, height: 600 }, viewport: { scrollX: 0, scrollY: 0 }, zoom: 1 };
});

describe("Fit to Width", () => {
  it("the page's width plus its margin fills the view's width (the height may scroll)", () => {
    const z = fitWidthZoom(1000, PAGE);
    expect(z).toBe(Math.floor(((1000 - GRID_SCROLLBAR_GUTTER_PX) / (1280 + LAYOUT_PAGE_MARGIN)) * 100) / 100);
    expect((1280 + LAYOUT_PAGE_MARGIN) * z).toBeLessThanOrEqual(1000 - GRID_SCROLLBAR_GUTTER_PX);
  });

  it("is never smaller than Fit to Page (width only binds less)", () => {
    for (const [w, h] of [[1000, 300], [2000, 600], [600, 2000]]) {
      expect(fitWidthZoom(w, PAGE)).toBeGreaterThanOrEqual(fitPageZoom(w, h, PAGE));
    }
  });

  it("clamps to the grid's zoom range", () => {
    expect(fitWidthZoom(20, { width: 10_000, height: 10 })).toBe(0.1);
    expect(fitWidthZoom(100_000, { width: 100, height: 10 })).toBe(4);
  });

  it("zooms the active canvas and scrolls home", () => {
    fitActiveCanvasToWidth();
    expect(dispatched).toEqual([{ type: "SET_ZOOM", z: fitWidthZoom(1000, PAGE) }, { type: "SCROLL", x: 0, y: 0 }]);
  });

  it("does nothing off a canvas or before the grid has a size", () => {
    active = null;
    fitActiveCanvasToWidth();
    active = { index: 1, name: "R", layout: { pageWidth: 1280, pageHeight: 720 } };
    gridSnapshot = { viewportDimensions: { width: 0, height: 0 }, zoom: 1 };
    fitActiveCanvasToWidth();
    expect(dispatched).toEqual([]);
  });
});

describe("which page view is on now (the radio check)", () => {
  it("names the mode whose zoom the page is shown at", () => {
    // A wide window: the HEIGHT binds Fit to Page, so the two fits differ.
    const fit = fitPageZoom(2000, 600, PAGE);
    const width = fitWidthZoom(2000, PAGE);
    expect(fit).not.toBe(width);
    expect(pageViewOf(fit, 2000, 600, PAGE)).toBe("fitPage");
    expect(pageViewOf(width, 2000, 600, PAGE)).toBe("fitWidth");
    expect(pageViewOf(1, 2000, 600, PAGE)).toBe("actual");
    expect(pageViewOf(0.37, 2000, 600, PAGE)).toBeNull();
  });

  it("when two modes give the same zoom, the one chosen last keeps the check", () => {
    // A short page in a tall window: fit to page = fit to width.
    const flat = { width: 1280, height: 100 };
    const z = fitPageZoom(1000, 2000, flat);
    expect(fitWidthZoom(1000, flat)).toBe(z);
    expect(pageViewOf(z, 1000, 2000, flat)).toBe("fitPage");
    expect(pageViewOf(z, 1000, 2000, flat, "fitWidth")).toBe("fitWidth");
  });

  it("reads the live zoom of the active canvas", () => {
    gridSnapshot = { viewportDimensions: { width: 2000, height: 600 }, zoom: 1 };
    expect(currentPageView()).toBe("actual");
    gridSnapshot = { viewportDimensions: { width: 2000, height: 600 }, zoom: fitWidthZoom(2000, PAGE) };
    expect(currentPageView()).toBe("fitWidth");
    active = null;
    expect(currentPageView()).toBeNull();
  });
});

describe("New Page", () => {
  // Review finding (2026-10-08): New Page dispatched the Shell's PRIVATE
  // `sheet:requestAdd` window event -- a string contract with a Shell
  // internal that lint:boundaries cannot see. It now runs the public sheet
  // command (core.sheet.insert, which can name a canvas and the end), the one
  // door every sheet insert shares, refusals included.
  let requestAdds: unknown[] = [];
  const listener = (e: Event) => requestAdds.push((e as CustomEvent).detail);
  beforeEach(() => {
    requestAdds = [];
    window.addEventListener("sheet:requestAdd", listener);
  });
  afterEach(() => {
    window.removeEventListener("sheet:requestAdd", listener);
    vi.restoreAllMocks();
  });

  it("runs core.sheet.insert for a CANVAS at the end, never the Shell's private add event", async () => {
    const execute = vi.spyOn(CommandRegistry, "execute").mockResolvedValue(undefined as never);
    await addBlankCanvasPage();
    expect(execute.mock.calls).toEqual([[CoreCommands.SHEET_INSERT, NEW_CANVAS_PAGE_ARGS]]);
    expect(NEW_CANVAS_PAGE_ARGS).toEqual({ kind: "canvas", atEnd: true });
    expect(requestAdds).toEqual([]);
  });
});
