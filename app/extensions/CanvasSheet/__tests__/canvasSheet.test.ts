//! FILENAME: app/extensions/CanvasSheet/__tests__/canvasSheet.test.ts
// PURPOSE: The canvas sheet extension's own logic: the store (including the
//          refresh race), the layout-surface answer (editable = not
//          subscribed), the page painter, the tab lifecycle and fit-to-page.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CanvasLayout, SheetInfo, SheetsResult } from "@api";

const getSheets = vi.fn<() => Promise<SheetsResult>>();
const registerPanel = vi.fn();
const unregisterPanel = vi.fn();
vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  getSheets: () => getSheets(),
  registerPanel: (...a: unknown[]) => registerPanel(...a),
  unregisterPanel: (...a: unknown[]) => unregisterPanel(...a),
}));

const getSheetProvenance = vi.fn();
vi.mock("@api/collaboration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/collaboration")>()),
  getSheetProvenance: () => getSheetProvenance(),
}));

let gridSnapshot: Record<string, unknown> | null = null;
vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => gridSnapshot,
}));

import {
  canvasAt,
  canvasEntriesFrom,
  getCanvasSheetSnapshot,
  refreshCanvasProvenance,
  refreshCanvasSheets,
  resetCanvasSheetStore,
} from "../lib/canvasSheetStore";
import { canvasLayoutSurface } from "../lib/layoutSurfaceProvider";
import { gridLinesInView, paintCanvasPage, type PagePalette } from "../lib/pagePainter";
import { isCanvasTabRegistered, resetCanvasTab, syncCanvasTab } from "../lib/canvasTab";
import { fitPageZoom } from "../lib/canvasActions";
import { defaultCanvasLayout } from "@api/canvasSheet";
import { LAYOUT_PAGE_MARGIN } from "@api/layoutSurface";

function layout(over: Partial<CanvasLayout> = {}): CanvasLayout {
  return { ...defaultCanvasLayout(), ...over };
}

function sheets(activeIndex: number, extra: SheetInfo[] = []): SheetsResult {
  return {
    activeIndex,
    sheets: [
      { index: 0, name: "Data", visibility: "visible", sheetId: "ws-0" },
      { index: 1, name: "Dashboard", visibility: "visible", sheetId: "cv-1", kind: "canvas", canvasLayout: layout() },
      ...extra,
    ],
  };
}

beforeEach(() => {
  resetCanvasSheetStore();
  resetCanvasTab();
  getSheets.mockReset();
  getSheetProvenance.mockReset();
  registerPanel.mockReset();
  unregisterPanel.mockReset();
  gridSnapshot = null;
});

describe("the store", () => {
  it("keeps canvases only, by index", () => {
    const map = canvasEntriesFrom(sheets(0).sheets);
    expect([...map.keys()]).toEqual([1]);
    expect(map.get(1)?.sheetId).toBe("cv-1");
  });

  it("an older get_sheets answer that arrives LAST never overwrites a newer one", async () => {
    let resolveOld!: (r: SheetsResult) => void;
    getSheets.mockImplementationOnce(() => new Promise((r) => (resolveOld = r)));
    getSheets.mockImplementationOnce(() => Promise.resolve(sheets(1)));
    const old = refreshCanvasSheets();
    const fresh = refreshCanvasSheets();
    expect(await fresh).toBe(true);
    resolveOld(sheets(0));
    expect(await old).toBe(false);
    expect(getCanvasSheetSnapshot().activeIndex).toBe(1);
    expect(getCanvasSheetSnapshot().active?.name).toBe("Dashboard");
  });

  it("a failed read keeps the previous answer", async () => {
    getSheets.mockResolvedValueOnce(sheets(1));
    await refreshCanvasSheets();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    getSheets.mockRejectedValueOnce(new Error("ipc"));
    expect(await refreshCanvasSheets()).toBe(false);
    expect(canvasAt(1)).not.toBeNull();
    warn.mockRestore();
  });
});

describe("the layout surface (editable = not subscribed)", () => {
  it("a worksheet answers null: its objects stay free", async () => {
    getSheets.mockResolvedValueOnce(sheets(0));
    await refreshCanvasSheets();
    expect(canvasLayoutSurface(0)).toBeNull();
  });

  it("a canvas answers its snap, pitch and page, editable", async () => {
    getSheets.mockResolvedValueOnce(sheets(1, [
      { index: 2, name: "Other", visibility: "visible", sheetId: "cv-2", kind: "canvas",
        canvasLayout: layout({ gridSizePx: 24, snapToGrid: false, pagePreset: "custom", pageWidth: 900, pageHeight: 600 }) },
    ]));
    await refreshCanvasSheets();
    expect(canvasLayoutSurface(2)).toEqual({
      snapToGrid: false,
      gridSize: 24,
      showGrid: true,
      page: { width: 900, height: 600 },
      editable: true,
      // M8: the surface also answers which objects the layout LOCKS.
      isLocked: expect.any(Function),
    });
  });

  it("a SUBSCRIBED canvas is read-only; a working copy is not", async () => {
    getSheets.mockResolvedValueOnce(sheets(1));
    await refreshCanvasSheets();
    getSheetProvenance.mockResolvedValueOnce([{ sheetId: "cv-1", role: "subscribed" }]);
    await refreshCanvasProvenance();
    expect(canvasLayoutSurface(1)?.editable).toBe(false);
    expect(getCanvasSheetSnapshot().activeSubscribed).toBe(true);
    getSheetProvenance.mockResolvedValueOnce([{ sheetId: "cv-1", role: "workingCopy" }]);
    await refreshCanvasProvenance();
    expect(canvasLayoutSurface(1)?.editable).toBe(true);
  });
});

describe("the page painter", () => {
  const PALETTE: PagePalette = { outside: "#o", page: "#p", border: "#b", dot: "#d" };

  function mockCtx() {
    const calls: Array<{ fill: string; rect: number[] }> = [];
    const ctx = {
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      fillRect(x: number, y: number, w: number, h: number) {
        calls.push({ fill: String(this.fillStyle), rect: [x, y, w, h] });
      },
      strokeRect: vi.fn(),
    };
    return { ctx, calls };
  }

  function layerContext(ctx: unknown, scrollX = 0, scrollY = 0) {
    return {
      ctx,
      config: { rowHeaderWidth: 0, colHeaderHeight: 0 },
      viewport: { scrollX, scrollY, startRow: 0, startCol: 0, rowCount: 0, colCount: 0 },
      dimensions: {},
      canvasWidth: 400,
      canvasHeight: 300,
      freezeConfig: null,
    } as never;
  }

  beforeEach(async () => {
    getSheets.mockResolvedValue(sheets(1));
    await refreshCanvasSheets();
  });

  it("paints nothing on a worksheet surface -- even where the store still says canvas", () => {
    // Index 1 IS a canvas in the store: only the SURFACE guard can stop this
    // paint (the store and Core disagree for a moment during a move).
    gridSnapshot = { surface: "grid", sheetContext: { activeSheetIndex: 1 }, zoom: 1 };
    const { ctx, calls } = mockCtx();
    paintCanvasPage(layerContext(ctx), PALETTE, 1);
    expect(calls).toHaveLength(0);
  });

  it("on a canvas: the surround, then the page at the origin minus scroll, then dots", () => {
    gridSnapshot = { surface: "canvas", sheetContext: { activeSheetIndex: 1 }, zoom: 1 };
    const { ctx, calls } = mockCtx();
    paintCanvasPage(layerContext(ctx, 32, 16), PALETTE, 1);
    expect(calls[0]).toEqual({ fill: "#o", rect: [0, 0, 400, 300] });
    expect(calls[1]).toEqual({ fill: "#p", rect: [-32, -16, 1280, 720] });
    const dots = calls.filter((c) => c.fill === "#d");
    expect(dots.length).toBeGreaterThan(0);
    // Every dot sits on a grid multiple of the page (pitch 16), in screen space.
    for (const d of dots) {
      expect((d.rect[0] + 0.5 + 32) % 16).toBe(0);
    }
  });

  it("no dots when the grid is hidden, or the canvas is subscribed", async () => {
    gridSnapshot = { surface: "canvas", sheetContext: { activeSheetIndex: 1 }, zoom: 1 };
    getSheets.mockResolvedValueOnce({
      activeIndex: 1,
      sheets: [{ index: 1, name: "D", visibility: "visible", sheetId: "cv-1", kind: "canvas", canvasLayout: layout({ showGrid: false }) }],
    });
    await refreshCanvasSheets();
    let m = mockCtx();
    paintCanvasPage(layerContext(m.ctx), PALETTE, 1);
    expect(m.calls.some((c) => c.fill === "#d")).toBe(false);

    getSheets.mockResolvedValueOnce(sheets(1));
    await refreshCanvasSheets();
    getSheetProvenance.mockResolvedValueOnce([{ sheetId: "cv-1", role: "subscribed" }]);
    await refreshCanvasProvenance();
    m = mockCtx();
    paintCanvasPage(layerContext(m.ctx), PALETTE, 1);
    expect(m.calls.some((c) => c.fill === "#d")).toBe(false);
    expect(m.calls.some((c) => c.fill === "#p")).toBe(true);
  });

  it("the page background is the layout's colour when set", async () => {
    gridSnapshot = { surface: "canvas", sheetContext: { activeSheetIndex: 1 }, zoom: 1 };
    getSheets.mockResolvedValueOnce({
      activeIndex: 1,
      sheets: [{ index: 1, name: "D", visibility: "visible", sheetId: "cv-1", kind: "canvas", canvasLayout: layout({ background: "#123456" }) }],
    });
    await refreshCanvasSheets();
    const { ctx, calls } = mockCtx();
    paintCanvasPage(layerContext(ctx), PALETTE, 1);
    expect(calls[1].fill).toBe("#123456");
  });

  it("gridLinesInView clips to the page and the viewport", () => {
    expect(gridLinesInView(100, 0, 1000, 25)).toEqual([0, 25, 50, 75, 100]);
    expect(gridLinesInView(1000, 30, 60, 25)).toEqual([50, 75]);
    expect(gridLinesInView(100, 0, 100, 0)).toEqual([]);
  });
});

describe("the Canvas tab", () => {
  it("registers once on the way onto canvases and once off", () => {
    syncCanvasTab(true);
    syncCanvasTab(true);
    expect(registerPanel).toHaveBeenCalledTimes(1);
    expect(isCanvasTabRegistered()).toBe(true);
    syncCanvasTab(false);
    syncCanvasTab(false);
    expect(unregisterPanel).toHaveBeenCalledTimes(1);
    expect(isCanvasTabRegistered()).toBe(false);
  });

  it("the tab selects itself on arrival and carries the canvas accent", async () => {
    syncCanvasTab(true);
    const def = registerPanel.mock.calls[0][0];
    expect(def.title).toBe("Canvas");
    expect(def.ribbonActivateOnRegister).toBe(true);
    expect(def.ribbonColor).toBe("var(--tab-accent-canvas, #b0245f)");
  });
});

describe("fit to window", () => {
  it("shows the whole page plus its margin, whichever edge binds", () => {
    const page = { width: 1280, height: 720 };
    // A wide window: height binds.
    const z = fitPageZoom(2014, 774, page);
    expect(z).toBeCloseTo(Math.floor(((774 - 14) / (720 + LAYOUT_PAGE_MARGIN)) * 100) / 100);
    expect((720 + LAYOUT_PAGE_MARGIN) * z).toBeLessThanOrEqual(774 - 14);
  });

  it("clamps to the grid's zoom range", () => {
    expect(fitPageZoom(20, 20, { width: 10_000, height: 10_000 })).toBe(0.1);
    expect(fitPageZoom(100_000, 100_000, { width: 100, height: 100 })).toBe(4);
  });
});
