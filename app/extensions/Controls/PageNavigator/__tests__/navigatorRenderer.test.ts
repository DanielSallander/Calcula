//! FILENAME: app/extensions/Controls/PageNavigator/__tests__/navigatorRenderer.test.ts
// PURPOSE: The Page Navigator's paint (PageNavigator/navigatorRenderer.ts;
//          WP-B, D-NAV S6):
//            - THE ONE FETCH TRIGGER: a render with no cached settings starts
//              the read once; a render with fresh settings starts none; a
//              render with stale settings starts one again;
//            - one caption per listed page, the CURRENT page's item in the
//              selected fill and caption colour, the others in the item style;
//            - a pressed item gets the button's wash and its caption one pixel
//              down and right; a hidden page's item is faded;
//            - no page to list: "No pages" in Design Mode, nothing in run mode.
// CONTEXT: A recording 2-D context (the buttonPressedPaint.test.ts idiom); the
//          page list, the grid and the settings cache are doubled.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReportPage, ReportPagesSnapshot } from "@api/reportPages";

const h = vi.hoisted(() => ({
  snapshot: null as unknown,
  activeIndex: 1,
  props: undefined as unknown,
  fresh: false,
  fetches: [] as unknown[][],
  design: false,
}));

vi.mock("@api/reportPages", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getReportPagesSnapshot: () => h.snapshot,
}));
vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getGridStateSnapshot: () => ({ sheetContext: { activeSheetIndex: h.activeIndex, activeSheetName: "" } }),
}));
vi.mock("../navigatorCache", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPageNavigatorProps: () => h.props,
  isPageNavigatorCacheFresh: () => h.fresh,
  fetchPageNavigatorProps: async (...args: unknown[]) => {
    h.fetches.push(args);
  },
}));
vi.mock("../../lib/designMode", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDesignMode: () => h.design,
}));
vi.mock("../../lib/controlApi", () => ({ resolveControlProperties: async () => ({}) }));

import { PAGE_NAVIGATOR_CONTROL_TYPE } from "@api/buttonControlService";
import { BUTTON_PRESSED_SHADE } from "../../Button/floatingRenderer";
import { HIDDEN_PAGE_ITEM_ALPHA, NO_PAGES_TEXT, renderFloatingPageNavigator } from "../navigatorRenderer";
import { PAGE_NAVIGATOR_DEFAULTS } from "../pageNavigatorRecipe";
import { readPageNavigatorProps } from "../navigatorModel";
import { beginFloatingButtonPress, cancelFloatingButtonPress } from "../../lib/buttonPress";

const NAV = "control-1-0-3";

function page(index: number, name: string, extra: Partial<ReportPage> = {}): ReportPage {
  return { sheetId: `id-${index}`, name, index, visibility: "visible", isTooltipPage: false, ...extra };
}

function snapshotOf(pages: ReportPage[]): ReportPagesSnapshot {
  return { pages, sheetIdByIndex: new Map(pages.map((p) => [p.index, p.sheetId])), activeIndex: 1, version: 1 };
}

interface Fill {
  style: unknown;
  alpha: number;
}
interface Text {
  text: string;
  x: number;
  y: number;
  style: unknown;
  alpha: number;
}

/** A canvas context that records every fill and every caption (with the style and alpha in force). */
function recordingCtx(): { ctx: CanvasRenderingContext2D; fills: Fill[]; texts: Text[] } {
  const fills: Fill[] = [];
  const texts: Text[] = [];
  const stack: Array<{ alpha: number; fillStyle: unknown }> = [];
  const target: Record<string, unknown> = {
    globalAlpha: 1,
    fillStyle: "#000",
    fill: () => fills.push({ style: target.fillStyle, alpha: target.globalAlpha as number }),
    fillText: (text: string, x: number, y: number) =>
      texts.push({ text, x, y, style: target.fillStyle, alpha: target.globalAlpha as number }),
    save: () => stack.push({ alpha: target.globalAlpha as number, fillStyle: target.fillStyle }),
    restore: () => {
      const s = stack.pop();
      if (s) {
        target.globalAlpha = s.alpha;
        target.fillStyle = s.fillStyle;
      }
    },
  };
  const ctx = new Proxy(target, {
    get: (obj, prop) => (prop in obj ? obj[prop as string] : () => undefined),
    set: (obj, prop, value) => {
      obj[prop as string] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, fills, texts };
}

/** Paint the navigator at sheet (64, 64), 360 x 32; headers 50 x 24, no scroll. */
function paint() {
  const rec = recordingCtx();
  renderFloatingPageNavigator({
    ctx: rec.ctx,
    canvasWidth: 2000,
    canvasHeight: 2000,
    config: { rowHeaderWidth: 50, colHeaderHeight: 24 },
    viewport: { scrollX: 0, scrollY: 0 },
    region: {
      id: NAV,
      type: "floating-control",
      floating: { x: 64, y: 64, width: 360, height: 32 },
      data: { controlType: PAGE_NAVIGATOR_CONTROL_TYPE, sheetIndex: 1, row: 0, col: 3, movable: false },
    },
  } as never);
  return rec;
}

beforeEach(() => {
  h.snapshot = snapshotOf([page(1, "Overview"), page(2, "Sales"), page(3, "Detail")]);
  h.activeIndex = 1;
  h.props = readPageNavigatorProps(null);
  h.fresh = true;
  h.fetches = [];
  h.design = false;
});

afterEach(() => {
  cancelFloatingButtonPress();
});

describe("the one fetch trigger", () => {
  it("no cached settings: the render starts the read ONCE, with the region's anchor", () => {
    h.props = undefined;
    h.fresh = false;
    paint();
    expect(h.fetches).toEqual([[NAV, 1, 0, 3]]);
  });

  it("fresh settings: the render starts no read", () => {
    paint();
    expect(h.fetches).toHaveLength(0);
  });

  it("stale settings (invalidated): the render starts the read again, and still paints the old ones", () => {
    h.fresh = false;
    const { texts } = paint();
    expect(h.fetches).toHaveLength(1);
    expect(texts.map((t) => t.text)).toEqual(["Overview", "Sales", "Detail"]);
  });
});

describe("what it paints", () => {
  it("one caption per listed page; the CURRENT page in the selected colours, the rest in the item style", () => {
    h.props = readPageNavigatorProps({ selectedFill: "#112233", selectedColor: "#fefefe", fill: "#abcdef", color: "#010203" });
    const { fills, texts } = paint();
    expect(texts.map((t) => t.text)).toEqual(["Overview", "Sales", "Detail"]);
    expect(texts[0].style).toBe("#fefefe");
    expect(texts[1].style).toBe("#010203");
    const faces = fills.filter((f) => f.style === "#112233" || f.style === "#abcdef").map((f) => f.style);
    expect(faces).toEqual(["#112233", "#abcdef", "#abcdef"]);
  });

  it("the defaults table's colours when nothing is cached yet", () => {
    h.props = undefined;
    h.fresh = false;
    const { texts } = paint();
    expect(texts.map((t) => t.text)).toEqual(["Overview", "Sales", "Detail"]);
    expect(texts[1].style).toBe(PAGE_NAVIGATOR_DEFAULTS.color);
  });

  it("a PRESSED item: the button's wash over its face and its caption one pixel down and right", () => {
    const released = paint().texts[1];
    beginFloatingButtonPress({ controlId: NAV, regionId: NAV, itemKey: "id-2", itemAtClient: () => "id-2", run: () => {} });
    const { fills, texts } = paint();
    const washes = fills.filter((f) => f.style === "#000000" && f.alpha === BUTTON_PRESSED_SHADE);
    expect(washes, "the pressed item is not darker").toHaveLength(1);
    expect(texts[1]).toMatchObject({ x: released.x + 1, y: released.y + 1 });
    expect(texts[0].x).toBe(paint().texts[0].x);
  });

  it("a hidden page's item (listed with Show hidden pages) is faded", () => {
    h.snapshot = snapshotOf([page(1, "Overview"), page(2, "Secret", { visibility: "hidden" })]);
    h.props = readPageNavigatorProps({ showHiddenPages: "true" });
    const { texts } = paint();
    expect(texts.map((t) => [t.text, t.alpha])).toEqual([
      ["Overview", 1],
      ["Secret", HIDDEN_PAGE_ITEM_ALPHA],
    ]);
  });

  it("no page to list: 'No pages' in Design Mode, nothing at all in run mode", () => {
    h.snapshot = snapshotOf([]);
    expect(paint().texts).toHaveLength(0);
    h.design = true;
    expect(paint().texts.map((t) => t.text)).toEqual([NO_PAGES_TEXT]);
  });
});
