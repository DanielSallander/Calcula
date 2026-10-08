//! FILENAME: app/extensions/CanvasSheet/__tests__/pageNavigator.test.ts
// PURPOSE: Buttons > Page Navigator: Power BI's page navigator is ONE row of
//          buttons, one per visible report page, the page on screen shown
//          selected. Calcula builds it from the declarative navigate action
//          (@api/buttonControlService): one navigate button per VISIBLE CANVAS,
//          in tab order, laid out in a row that wraps at the page edge, all
//          created as ONE undo step ("Insert Page Navigator").

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SheetInfo } from "@api";

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
vi.mock("@api/buttonControlService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/buttonControlService")>()),
  requireButtonControlProvider: () => ({ createButton }),
}));

const transactions: string[] = [];
vi.mock("@api/objectGeometry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/objectGeometry")>()),
  runInUndoTransaction: async (label: string, fn: () => Promise<unknown>) => {
    transactions.push(label);
    return fn();
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

import {
  PAGE_NAVIGATOR_BUTTON,
  PAGE_NAVIGATOR_GAP_PX,
  PAGE_NAVIGATOR_UNDO_LABEL,
  insertPageNavigator,
  layoutPageNavigator,
  pageNavigatorTargets,
} from "../lib/pageNavigator";
import { resetInsertCascade } from "../lib/insertOnCanvas";

function sheet(index: number, name: string, over: Partial<SheetInfo> = {}): SheetInfo {
  return { index, name, visibility: "visible", sheetId: `id-${index}`, kind: "canvas", ...over } as SheetInfo;
}

const SHEETS: SheetInfo[] = [
  sheet(0, "Data", { kind: "worksheet" }),
  sheet(1, "Overview"),
  sheet(2, "Hidden page", { visibility: "hidden" }),
  sheet(3, "Detail"),
  sheet(4, "Very hidden", { visibility: "veryHidden" }),
];

beforeEach(() => {
  resetInsertCascade();
  transactions.length = 0;
  createButton.mockReset().mockResolvedValue({ instanceId: "x", sheetIndex: 1, row: 0, col: 0, x: 0, y: 0, width: 0, height: 0 });
  alertAsync.mockClear();
  getSheets.mockReset().mockResolvedValue({ sheets: SHEETS, activeIndex: 1 });
  surface = { snapToGrid: true, gridSize: 16, showGrid: true, page: { width: 1280, height: 720 }, editable: true };
  gridSnapshot = {
    sheetContext: { activeSheetIndex: 1 },
    viewport: { scrollX: 0, scrollY: 0 },
    viewportDimensions: { width: 1000, height: 600 },
    zoom: 1,
  };
});

describe("which pages it lists", () => {
  it("every VISIBLE canvas, in tab order -- never a worksheet, never a hidden page", () => {
    expect(pageNavigatorTargets(SHEETS)).toEqual([
      { sheetId: "id-1", sheetName: "Overview" },
      { sheetId: "id-3", sheetName: "Detail" },
    ]);
  });

  it("a sheet with no stable id is still listed, by name (the action falls back to it)", () => {
    expect(pageNavigatorTargets([sheet(5, "Old", { sheetId: undefined })])).toEqual([{ sheetName: "Old" }]);
  });
});

describe("how the row is laid out", () => {
  it("side by side from the origin, one gap apart", () => {
    const rects = layoutPageNavigator(3, { x: 100, y: 50 }, { width: 1280, height: 720 });
    const w = PAGE_NAVIGATOR_BUTTON.width;
    expect(rects.map((r) => [r.x, r.y])).toEqual([
      [100, 50],
      [100 + w + PAGE_NAVIGATOR_GAP_PX, 50],
      [100 + 2 * (w + PAGE_NAVIGATOR_GAP_PX), 50],
    ]);
    for (const r of rects) expect([r.width, r.height]).toEqual([PAGE_NAVIGATOR_BUTTON.width, PAGE_NAVIGATOR_BUTTON.height]);
  });

  it("wraps to a new row instead of running off the page", () => {
    const rects = layoutPageNavigator(4, { x: 0, y: 0 }, { width: 300, height: 720 });
    // 112 + 8 + 112 = 232 fits in 300; a third would end at 352.
    expect(rects.map((r) => r.y)).toEqual([0, 0, PAGE_NAVIGATOR_BUTTON.height + PAGE_NAVIGATOR_GAP_PX, PAGE_NAVIGATOR_BUTTON.height + PAGE_NAVIGATOR_GAP_PX]);
    for (const r of rects) expect(r.x + r.width).toBeLessThanOrEqual(300);
  });
});

describe("inserting it", () => {
  it("one navigate button per page, captioned with the page, in ONE undo step", async () => {
    await insertPageNavigator();
    expect(transactions).toEqual([PAGE_NAVIGATOR_UNDO_LABEL]);
    expect(createButton).toHaveBeenCalledTimes(2);
    const reqs = createButton.mock.calls.map((c) => c[0]);
    expect(reqs.map((r) => r.label)).toEqual(["Overview", "Detail"]);
    expect(reqs.map((r) => r.action)).toEqual([
      { kind: "navigate", sheetId: "id-1", sheetName: "Overview" },
      { kind: "navigate", sheetId: "id-3", sheetName: "Detail" },
    ]);
    for (const r of reqs) {
      expect(r.sheetIndex).toBe(1);
      expect(r.onSelect).toBeUndefined();
      expect(r.row).toBeUndefined();
    }
    // A row: same y, increasing x.
    expect(reqs[1].y).toBe(reqs[0].y);
    expect(reqs[1].x).toBeGreaterThan(reqs[0].x);
  });

  it("is placed like any other insert: centred in the view and kept on the page", async () => {
    await insertPageNavigator();
    const reqs = createButton.mock.calls.map((c) => c[0]);
    const right = Math.max(...reqs.map((r) => r.x + r.width));
    expect(reqs[0].x).toBeGreaterThan(0);
    expect(right).toBeLessThanOrEqual(1280);
  });

  it("a refused button is said once and the rest are not attempted", async () => {
    createButton.mockReset().mockRejectedValueOnce(new Error("full"));
    await insertPageNavigator();
    expect(createButton).toHaveBeenCalledTimes(1);
    expect(alertAsync).toHaveBeenCalledTimes(1);
    expect(String(alertAsync.mock.calls[0][0])).toContain("full");
  });

  // Review finding (2026-10-08): the insert placed and clamped a ONE-row box,
  // then wrapped downwards with no regard for the page's bottom edge, so on a
  // small page (Tooltip, 320 x 240) with many pages the last rows landed below
  // the page. The WHOLE wrapped block is now placed and kept on the page, and
  // when even that cannot fit the buttons get narrower until it does.
  function manyPages(n: number): SheetInfo[] {
    return Array.from({ length: n }, (_, i) => sheet(i + 1, `Page ${i + 1}`));
  }
  function onPage(reqs: Array<{ x: number; y: number; width: number; height: number }>, w: number, h: number): void {
    for (const r of reqs) {
      expect(r.x, "left edge").toBeGreaterThanOrEqual(0);
      expect(r.y, "top edge").toBeGreaterThanOrEqual(0);
      expect(r.x + r.width, `right edge of the button at ${r.x},${r.y}`).toBeLessThanOrEqual(w);
      expect(r.y + r.height, `bottom edge of the button at ${r.x},${r.y}`).toBeLessThanOrEqual(h);
    }
  }

  it("a wrapped navigator stays on a small page: every row, not just the first", async () => {
    surface = { ...surface, page: { width: 320, height: 240 } };
    // The view is scrolled so a one-row box would be placed low on the page.
    gridSnapshot = { ...gridSnapshot!, viewport: { scrollX: 0, scrollY: 200 } };
    getSheets.mockReset().mockResolvedValue({ sheets: manyPages(10), activeIndex: 1 });
    await insertPageNavigator();
    const reqs = createButton.mock.calls.map((c) => c[0]);
    expect(reqs).toHaveLength(10);
    expect(new Set(reqs.map((r) => r.y)).size, "it wraps").toBeGreaterThan(1);
    onPage(reqs, 320, 240);
    // Room enough: the buttons keep their full width.
    for (const r of reqs) expect(r.width).toBe(PAGE_NAVIGATOR_BUTTON.width);
  });

  it("too many pages for full-width buttons: the buttons get narrower, and still fit", async () => {
    surface = { ...surface, page: { width: 320, height: 240 } };
    getSheets.mockReset().mockResolvedValue({ sheets: manyPages(24), activeIndex: 1 });
    await insertPageNavigator();
    const reqs = createButton.mock.calls.map((c) => c[0]);
    expect(reqs).toHaveLength(24);
    expect(reqs[0].width).toBeLessThan(PAGE_NAVIGATOR_BUTTON.width);
    onPage(reqs, 320, 240);
    // Never two buttons on top of each other.
    const spots = new Set(reqs.map((r) => `${r.x},${r.y}`));
    expect(spots.size).toBe(24);
  });

  it("with no grid yet nothing is created", async () => {
    gridSnapshot = null;
    await insertPageNavigator();
    expect(createButton).not.toHaveBeenCalled();
  });
});
