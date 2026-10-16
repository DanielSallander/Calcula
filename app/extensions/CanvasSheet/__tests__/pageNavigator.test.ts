//! FILENAME: app/extensions/CanvasSheet/__tests__/pageNavigator.test.ts
// PURPOSE: Buttons > Page Navigator inserts ONE live control (controlType
//          "pageNavigator") through the seam's `createPageNavigator` -- never a
//          row of navigate buttons -- in ONE undo step ("Insert Page
//          Navigator"). Its box is the seam's natural size for the pages it
//          lists now, clamped to the page, so it never lands off a small page.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SheetInfo } from "@api";
import { pageNavigatorNaturalSize } from "@api/buttonControlService";

const getSheets = vi.fn();
vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  getSheets: () => getSheets(),
}));

let gridSnapshot: Record<string, unknown> | null = null;
vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => gridSnapshot,
}));

const createButton = vi.fn();
const createPageNavigator = vi.fn();
vi.mock("@api/buttonControlService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/buttonControlService")>()),
  requireButtonControlProvider: () => ({ createButton, createPageNavigator }),
}));

const transactions: string[] = [];
/** Whether a create ran INSIDE the transaction (between open and commit). */
let insideTransaction = false;
const createdInside: boolean[] = [];
vi.mock("@api/objectGeometry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/objectGeometry")>()),
  runInUndoTransaction: async (label: string, fn: () => Promise<unknown>) => {
    transactions.push(label);
    insideTransaction = true;
    try {
      return await fn();
    } finally {
      insideTransaction = false;
    }
  },
}));

const alertAsync = vi.fn(async (..._a: unknown[]) => {});
vi.mock("@api/dialogs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/dialogs")>()),
  alertAsync: (...a: unknown[]) => alertAsync(...a),
}));

let surface: Record<string, unknown> | null = null;
vi.mock("../lib/layoutSurfaceProvider", () => ({
  canvasLayoutSurface: () => surface,
}));

import { PAGE_NAVIGATOR_UNDO_LABEL, insertPageNavigator, pageNavigatorDefaultSize } from "../lib/pageNavigator";
import { resetInsertCascade } from "../lib/insertOnCanvas";

const WIDE = { width: 1280, height: 720 } as const; // 16:9
const TOOLTIP = { width: 320, height: 240 } as const; // the Tooltip page preset

function sheet(index: number, name: string, over: Partial<SheetInfo> = {}): SheetInfo {
  return { index, name, visibility: "visible", sheetId: `id-${index}`, kind: "canvas", ...over } as SheetInfo;
}

const SHEETS: SheetInfo[] = [
  sheet(0, "Data", { kind: "worksheet" }),
  sheet(1, "Overview"),
  sheet(2, "Hidden page", { visibility: "hidden" }),
  sheet(3, "Detail"),
  sheet(4, "Very hidden", { visibility: "veryHidden" }),
  sheet(5, "Tip", { canvasLayout: { pagePreset: "tooltip" } } as Partial<SheetInfo>),
];

function manyPages(n: number): SheetInfo[] {
  return Array.from({ length: n }, (_, i) => sheet(i + 1, `Page ${i + 1}`));
}

type Req = { sheetIndex: number; x: number; y: number; width: number; height: number } & Record<string, unknown>;

function onlyRequest(): Req {
  expect(createPageNavigator).toHaveBeenCalledTimes(1);
  return createPageNavigator.mock.calls[0][0] as Req;
}

function expectOnPage(r: Req, page: { width: number; height: number }): void {
  expect(r.x, "left edge").toBeGreaterThanOrEqual(0);
  expect(r.y, "top edge").toBeGreaterThanOrEqual(0);
  expect(r.x + r.width, "right edge").toBeLessThanOrEqual(page.width);
  expect(r.y + r.height, "bottom edge").toBeLessThanOrEqual(page.height);
}

beforeEach(() => {
  resetInsertCascade();
  transactions.length = 0;
  createdInside.length = 0;
  insideTransaction = false;
  createButton.mockReset();
  createPageNavigator.mockReset().mockImplementation(async (req: Req) => {
    createdInside.push(insideTransaction);
    return { instanceId: "n", sheetIndex: req.sheetIndex, row: 0, col: 0, x: req.x, y: req.y, width: req.width, height: req.height };
  });
  alertAsync.mockClear();
  getSheets.mockReset().mockResolvedValue({ sheets: SHEETS, activeIndex: 1 });
  surface = { snapToGrid: true, gridSize: 16, showGrid: true, page: { ...WIDE }, editable: true };
  gridSnapshot = {
    sheetContext: { activeSheetIndex: 1 },
    viewport: { scrollX: 0, scrollY: 0 },
    viewportDimensions: { width: 1000, height: 600 },
    zoom: 1,
  };
});

describe("the default box (pure)", () => {
  it("is the seam's natural size when it fits on the page", () => {
    expect(pageNavigatorDefaultSize(1, WIDE)).toEqual(pageNavigatorNaturalSize(1));
    expect(pageNavigatorDefaultSize(4, WIDE)).toEqual(pageNavigatorNaturalSize(4));
  });

  it("is clamped to the page on each axis (the box is fixed; the items divide it)", () => {
    const natural30 = pageNavigatorNaturalSize(30);
    expect(natural30.width).toBeGreaterThan(WIDE.width);
    expect(pageNavigatorDefaultSize(30, WIDE)).toEqual({ width: WIDE.width, height: natural30.height });
    expect(pageNavigatorDefaultSize(4, TOOLTIP)).toEqual({ width: TOOLTIP.width, height: pageNavigatorNaturalSize(4).height });
    expect(pageNavigatorDefaultSize(1, { width: 50, height: 10 })).toEqual({ width: 50, height: 10 });
  });

  it("off a page (no layout surface) it is the natural size, unclamped", () => {
    expect(pageNavigatorDefaultSize(30, null)).toEqual(pageNavigatorNaturalSize(30));
  });

  it("zero pages still get one item's room, never an invisible box", () => {
    expect(pageNavigatorDefaultSize(0, WIDE)).toEqual(pageNavigatorNaturalSize(1));
  });
});

describe("inserting it", () => {
  it("is ONE createPageNavigator call, never createButton, in ONE undo step", async () => {
    await insertPageNavigator();
    expect(createButton).not.toHaveBeenCalled();
    expect(transactions).toEqual([PAGE_NAVIGATOR_UNDO_LABEL]);
    expect(PAGE_NAVIGATOR_UNDO_LABEL).toBe("Insert Page Navigator");
    expect(createdInside).toEqual([true]);
    const r = onlyRequest();
    expect(r.sheetIndex).toBe(1);
  });

  it("asks only WHERE and HOW BIG -- nothing about pages, captions or actions is stored", async () => {
    await insertPageNavigator();
    const r = onlyRequest();
    expect(Object.keys(r).sort()).toEqual(["height", "sheetIndex", "width", "x", "y"]);
  });

  it("sizes the box for the pages it lists now: visible, non-Tooltip canvases only", async () => {
    // Overview + Detail. Never the worksheet, the hidden, the veryHidden or the Tooltip page.
    await insertPageNavigator();
    const r = onlyRequest();
    expect({ width: r.width, height: r.height }).toEqual(pageNavigatorNaturalSize(2));
  });

  it("is placed like any other insert: centred in the view and kept on the page", async () => {
    await insertPageNavigator();
    const r = onlyRequest();
    expect(r.x).toBeGreaterThan(0);
    expectOnPage(r, WIDE);
  });

  for (const n of [1, 4, 30]) {
    it(`${n} page(s) on a 16:9 page: the box stays on the page`, async () => {
      getSheets.mockReset().mockResolvedValue({ sheets: manyPages(n), activeIndex: 1 });
      gridSnapshot = { ...gridSnapshot!, viewport: { scrollX: 400, scrollY: 300 } };
      await insertPageNavigator();
      const r = onlyRequest();
      expect({ width: r.width, height: r.height }).toEqual(pageNavigatorDefaultSize(n, WIDE));
      expectOnPage(r, WIDE);
    });

    it(`${n} page(s) on a 320 x 240 Tooltip page: the box stays on the page`, async () => {
      surface = { ...surface, page: { ...TOOLTIP } };
      getSheets.mockReset().mockResolvedValue({ sheets: manyPages(n), activeIndex: 1 });
      // Scrolled so an unclamped box would be placed off the page.
      gridSnapshot = { ...gridSnapshot!, viewport: { scrollX: 200, scrollY: 200 } };
      await insertPageNavigator();
      const r = onlyRequest();
      expect(r.width).toBeLessThanOrEqual(TOOLTIP.width);
      expect(r.height).toBeLessThanOrEqual(TOOLTIP.height);
      expectOnPage(r, TOOLTIP);
    });
  }

  it("with no page listed yet it is still inserted (it is live), one item's room", async () => {
    getSheets.mockReset().mockResolvedValue({ sheets: [sheet(0, "Data", { kind: "worksheet" })], activeIndex: 0 });
    await insertPageNavigator();
    const r = onlyRequest();
    expect({ width: r.width, height: r.height }).toEqual(pageNavigatorNaturalSize(1));
  });

  it("a refused create is said once, with the provider's reason", async () => {
    createPageNavigator.mockReset().mockRejectedValueOnce(new Error("Lock Objects is on"));
    await insertPageNavigator();
    expect(createPageNavigator).toHaveBeenCalledTimes(1);
    expect(alertAsync).toHaveBeenCalledTimes(1);
    expect(String(alertAsync.mock.calls[0][0])).toBe("Could not insert a page navigator: Lock Objects is on");
  });

  it("a failed page read is said once and nothing is created", async () => {
    getSheets.mockReset().mockRejectedValue(new Error("ipc down"));
    await insertPageNavigator();
    expect(createPageNavigator).not.toHaveBeenCalled();
    expect(transactions).toEqual([]);
    expect(alertAsync).toHaveBeenCalledTimes(1);
    expect(String(alertAsync.mock.calls[0][0])).toContain("ipc down");
  });

  it("with no grid yet nothing is created", async () => {
    gridSnapshot = null;
    await insertPageNavigator();
    expect(createPageNavigator).not.toHaveBeenCalled();
    expect(createButton).not.toHaveBeenCalled();
    expect(alertAsync).not.toHaveBeenCalled();
  });
});
