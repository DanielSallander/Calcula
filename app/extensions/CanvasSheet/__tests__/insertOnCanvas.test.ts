//! FILENAME: app/extensions/CanvasSheet/__tests__/insertOnCanvas.test.ts
// PURPOSE: The Canvas tab's Insert group: where a new object lands (centred in
//          the view, snapped, on the page, cascading), and that each kind goes
//          to its OWNING family's seam with a free position -- never a recipe.

import { describe, it, expect, vi, beforeEach } from "vitest";

const showDialog = vi.fn();
vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  showDialog: (...a: unknown[]) => showDialog(...a),
}));

let gridSnapshot: Record<string, unknown> | null = null;
vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => gridSnapshot,
}));

const createShape = vi.fn();
// The catalog rows the shapes menu and the insert read (sizes as Controls'
// shapeCatalog.ts has them: a rectangle 160x100, a right arrow 160x80).
const SHAPE_CATALOG = [
  { id: "rectangle", label: "Rectangle", categoryId: "rectangles", categoryLabel: "Rectangles", defaultWidth: 160, defaultHeight: 100, isLine: false },
  { id: "rightArrow", label: "Right Arrow", categoryId: "blockArrows", categoryLabel: "Block Arrows", defaultWidth: 160, defaultHeight: 80, isLine: false },
  { id: "textBox", label: "Text Box", categoryId: "basicShapes", categoryLabel: "Basic Shapes", defaultWidth: 160, defaultHeight: 60, isLine: false },
];
vi.mock("@api/controlsService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/controlsService")>()),
  requireControlsProvider: () => ({ createShape, listShapeCatalog: () => SHAPE_CATALOG }),
}));
const alertAsync = vi.fn(async (..._a: unknown[]) => {});
vi.mock("@api/dialogs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/dialogs")>()),
  alertAsync: (...a: unknown[]) => alertAsync(...a),
}));
const createButton = vi.fn();
const createPageNavigator = vi.fn();
vi.mock("@api/buttonControlService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/buttonControlService")>()),
  requireButtonControlProvider: () => ({ createButton, createPageNavigator }),
}));
const createPicture = vi.fn();
vi.mock("@api/pictureControlService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/pictureControlService")>()),
  requirePictureControlProvider: () => ({ createPicture }),
}));
const createFloating = vi.fn();
vi.mock("@api/floatingRangeService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/floatingRangeService")>()),
  requireFloatingRangeProvider: () => ({ create: createFloating }),
}));
const importImageViaPicker = vi.fn();
vi.mock("@api/filesystem", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/filesystem")>()),
  importImageViaPicker: (...a: unknown[]) => importImageViaPicker(...a),
}));

let surface: Record<string, unknown> | null = null;
vi.mock("../lib/layoutSurfaceProvider", () => ({
  canvasLayoutSurface: () => surface,
}));

import { CHART_MARK_INSERT_SIZES, INSERT_SIZES, defaultInsertRect, insertOnCanvas, resetInsertCascade } from "../lib/insertOnCanvas";
import { TABLE_VISUAL_PIVOT_PRESET } from "@api/pivotPresets";

const VIEW = { sheetIndex: 2, scrollX: 0, scrollY: 0, viewWidth: 1000, viewHeight: 600 };

beforeEach(() => {
  resetInsertCascade();
  surface = { snapToGrid: true, gridSize: 16, showGrid: true, page: { width: 1280, height: 720 }, editable: true };
  gridSnapshot = {
    sheetContext: { activeSheetIndex: 2 },
    viewport: { scrollX: 0, scrollY: 0 },
    viewportDimensions: { width: 1000, height: 600 },
    zoom: 1,
  };
  for (const f of [showDialog, createShape, createButton, createPageNavigator, createPicture, createFloating, importImageViaPicker, alertAsync]) f.mockReset();
});

describe("where a new object lands", () => {
  it("centred in the view and snapped to the grid", () => {
    const r = defaultInsertRect(VIEW, { width: 200, height: 100 });
    // Centre 400,250 -> snapped to the 16 grid.
    expect(r).toEqual({ x: 400, y: 256, width: 200, height: 100 });
  });

  it("unsnapped when snap is off", () => {
    surface = { ...surface!, snapToGrid: false };
    expect(defaultInsertRect(VIEW, { width: 210, height: 90 })).toMatchObject({ x: 395, y: 255 });
  });

  it("a burst of inserts cascades one pitch down-right instead of stacking", () => {
    const a = defaultInsertRect(VIEW, { width: 200, height: 100 });
    const b = defaultInsertRect(VIEW, { width: 200, height: 100 });
    expect(b.x - a.x).toBe(16);
    expect(b.y - a.y).toBe(16);
  });

  it("stays on the page even when the view is past it", () => {
    const r = defaultInsertRect({ ...VIEW, scrollX: 5000, scrollY: 5000 }, { width: 200, height: 100 });
    expect(r.x + r.width).toBeLessThanOrEqual(1280);
    expect(r.y + r.height).toBeLessThanOrEqual(720);
  });

  it("keeps an object's size on a page smaller than it unless asked to fit the page", () => {
    surface = { ...surface!, page: { width: 300, height: 200 } };
    expect(defaultInsertRect(VIEW, { width: 480, height: 320 })).toEqual({ x: 0, y: 0, width: 480, height: 320 });
    resetInsertCascade();
    expect(defaultInsertRect(VIEW, { width: 480, height: 320 }, { fitPage: true })).toEqual({
      x: 0,
      y: 0,
      width: 300,
      height: 200,
    });
  });
});

describe("each kind goes to its owner's seam", () => {
  it("chart: the create dialog, with the placement and no range guessed from the canvas", async () => {
    await insertOnCanvas("chart");
    expect(showDialog).toHaveBeenCalledWith(
      "chart:createDialog",
      expect.objectContaining({ suppressAutoRange: true, placement: expect.objectContaining({ sheetIndex: 2 }) }),
    );
  });

  it("pivot: the pivot create dialog, with the canvas and a snapped default frame (never a range or a cell)", async () => {
    await insertOnCanvas("pivot");
    expect(showDialog).toHaveBeenCalledTimes(1);
    const [id, data] = showDialog.mock.calls[0];
    expect(id).toBe("pivot:createDialog");
    // Centre of the 1000x600 view: (1000-480)/2 = 260 -> 256 and
    // (600-320)/2 = 140 -> 144 on the 16 px grid. Bigger than a chart.
    expect(data).toEqual({ placement: { sheetIndex: 2, x: 256, y: 144, width: 480, height: 320 } });
    expect(data.placement.width * data.placement.height).toBeGreaterThan(
      INSERT_SIZES.chart.width * INSERT_SIZES.chart.height,
    );
  });

  it("pivot: the frame is kept on the page when the view is scrolled past it", async () => {
    gridSnapshot = { ...gridSnapshot!, viewport: { scrollX: 5000, scrollY: 5000 } };
    await insertOnCanvas("pivot");
    const { placement } = showDialog.mock.calls[0][1];
    expect(placement.x + placement.width).toBeLessThanOrEqual(1280);
    expect(placement.y + placement.height).toBeLessThanOrEqual(720);
    expect(placement.x % 16).toBe(0);
    expect(placement.y % 16).toBe(0);
    expect(placement).toMatchObject({ width: 480, height: 320 });
  });

  it("pivot: on a page smaller than the default frame the frame shrinks to the page", async () => {
    surface = { ...surface!, page: { width: 400, height: 240 } };
    await insertOnCanvas("pivot");
    expect(showDialog.mock.calls[0][1].placement).toEqual({ sheetIndex: 2, x: 0, y: 0, width: 400, height: 240 });
  });

  it("pivot: with no grid yet nothing opens", async () => {
    gridSnapshot = null;
    await insertOnCanvas("pivot");
    expect(showDialog).not.toHaveBeenCalled();
  });

  it("slicer and timeline: their insert dialogs, with a placement origin", async () => {
    await insertOnCanvas("slicer");
    await insertOnCanvas("timeline");
    expect(showDialog.mock.calls.map((c) => c[0])).toEqual(["slicer:insertDialog", "timelineSlicer:insertDialog"]);
    for (const c of showDialog.mock.calls) expect(c[1].placement).toEqual({ x: expect.any(Number), y: expect.any(Number) });
  });

  it("text box and shape: the controls seam with a free x/y and NO anchor cell", async () => {
    await insertOnCanvas("textBox");
    await insertOnCanvas("shape");
    const [text, shape] = createShape.mock.calls.map((c) => c[0]);
    expect(text).toMatchObject({ sheetIndex: 2, shapeType: "textBox", text: "" });
    expect(shape).toMatchObject({ sheetIndex: 2, shapeType: "rectangle" });
    for (const req of [text, shape]) {
      expect(req.row).toBeUndefined();
      expect(req.col).toBeUndefined();
      expect(typeof req.x).toBe("number");
    }
  });

  it("button: the button seam with a caption (never a hand-written recipe)", async () => {
    await insertOnCanvas("button");
    expect(createButton).toHaveBeenCalledWith(expect.objectContaining({ sheetIndex: 2, label: "Button" }));
  });

  it("picture: picked through the media door, sized to fit, placed by handle", async () => {
    importImageViaPicker.mockResolvedValue({ ref: "media:abc", mimeType: "image/png", width: 800, height: 400, byteLength: 10 });
    await insertOnCanvas("picture");
    expect(createPicture).toHaveBeenCalledWith(
      expect.objectContaining({ sheetIndex: 2, mediaRef: "media:abc", width: 400, height: 200 }),
    );
  });

  it("picture: a cancelled picker inserts nothing", async () => {
    importImageViaPicker.mockResolvedValue(null);
    await insertOnCanvas("picture");
    expect(createPicture).not.toHaveBeenCalled();
  });

  it("floating grid: the floating-range seam with a position and a starting size", async () => {
    await insertOnCanvas("floatingGrid");
    expect(createFloating).toHaveBeenCalledWith(expect.objectContaining({ rows: 5, cols: 3, x: expect.any(Number) }));
  });

  it("chart with a type: the dialog opens PRESET to it (initialMark / initialMarkOptions), still with the placement", async () => {
    await insertOnCanvas("chart", { mark: "horizontalBar", markOptions: { stackMode: "stacked" } });
    const [id, data] = showDialog.mock.calls[0];
    expect(id).toBe("chart:createDialog");
    expect(data).toMatchObject({
      suppressAutoRange: true,
      initialMark: "horizontalBar",
      initialMarkOptions: { stackMode: "stacked" },
      placement: { sheetIndex: 2, width: INSERT_SIZES.chart.width, height: INSERT_SIZES.chart.height },
    });
  });

  // Review finding (2026-10-08): every chart -- a Card showing one number
  // included -- was dropped at the full chart size (480 x 300). The tile
  // visuals (Card, Multi-row card, KPI, Gauge) get boxes sized for what they
  // show; every other mark keeps the chart size.
  it.each(Object.entries(CHART_MARK_INSERT_SIZES))("chart preset to %s: placed at its own, smaller size", async (mark, size) => {
    await insertOnCanvas("chart", { mark });
    const placement = (showDialog.mock.calls[0][1] as { placement: { width: number; height: number } }).placement;
    expect([placement.width, placement.height]).toEqual([size.width, size.height]);
    expect(size.width * size.height).toBeLessThan(INSERT_SIZES.chart.width * INSERT_SIZES.chart.height);
  });

  it("the tile visuals that get a size of their own are exactly Card, Multi-row card, KPI and Gauge", () => {
    expect(Object.keys(CHART_MARK_INSERT_SIZES).sort()).toEqual(["card", "gauge", "kpi", "multiRowCard"]);
  });

  it("chart with no type: no preset keys at all (the dialog's own default)", async () => {
    await insertOnCanvas("chart");
    const data = showDialog.mock.calls[0][1];
    expect("initialMark" in data).toBe(false);
    expect("initialMarkOptions" in data).toBe(false);
  });

  it("pivot with the Table preset: the pivot dialog receives it beside the placement", async () => {
    await insertOnCanvas("pivot", { preset: TABLE_VISUAL_PIVOT_PRESET });
    expect(showDialog.mock.calls[0][1]).toEqual({
      placement: { sheetIndex: 2, x: 256, y: 144, width: 480, height: 320 },
      preset: TABLE_VISUAL_PIVOT_PRESET,
    });
  });
});

describe("shapes by catalog id, at the catalog's size", () => {
  it("a named shape is created by its id with NO width/height (the catalog's default applies)", async () => {
    await insertOnCanvas("shape", { shapeId: "rightArrow" });
    const req = createShape.mock.calls[0][0];
    expect(req.shapeType).toBe("rightArrow");
    expect(req.width).toBeUndefined();
    expect(req.height).toBeUndefined();
  });

  it("it is placed as an object of the CATALOG size: centred by 160x80, snapped", async () => {
    await insertOnCanvas("shape", { shapeId: "rightArrow" });
    const req = createShape.mock.calls[0][0];
    // (1000-160)/2 = 420 -> 416, (600-80)/2 = 260 -> 256 on the 16 px grid.
    expect({ x: req.x, y: req.y }).toEqual({ x: 416, y: 256 });
  });

  it("no id is a rectangle", async () => {
    await insertOnCanvas("shape");
    expect(createShape.mock.calls[0][0].shapeType).toBe("rectangle");
  });

  it("an id the catalog does not hold is refused, named, and nothing is created", async () => {
    await insertOnCanvas("shape", { shapeId: "noSuchShape" });
    expect(createShape).not.toHaveBeenCalled();
    expect(alertAsync).toHaveBeenCalledTimes(1);
    expect(String(alertAsync.mock.calls[0][0])).toContain("noSuchShape");
  });

  it("the text box keeps its own 240x64 (a text box is sized for words, not by the shape catalog)", async () => {
    await insertOnCanvas("textBox");
    expect(createShape.mock.calls[0][0]).toMatchObject({ shapeType: "textBox", width: 240, height: 64 });
  });
});

describe("button kinds", () => {
  it("blank: a captioned button with no action and no code", async () => {
    await insertOnCanvas("button", { button: "blank" });
    const req = createButton.mock.calls[0][0];
    expect(req).toMatchObject({ sheetIndex: 2, label: "Button" });
    expect(req.action).toBeUndefined();
    expect(req.onSelect).toBeUndefined();
    expect(req.macroRef).toBeUndefined();
  });

  it("back: Power BI's Back button -- the declarative action, never code", async () => {
    await insertOnCanvas("button", { button: "back" });
    const req = createButton.mock.calls[0][0];
    expect(req).toMatchObject({ label: "Back", action: { kind: "back" } });
    expect(req.onSelect).toBeUndefined();
  });

  it("clear all slicers: the declarative action, captioned as Power BI does", async () => {
    await insertOnCanvas("button", { button: "clearSlicers" });
    expect(createButton.mock.calls[0][0]).toMatchObject({ label: "Clear all slicers", action: { kind: "clearSlicers" } });
  });

  it("a refused button is said once, with the provider's reason", async () => {
    createButton.mockRejectedValueOnce(new Error("no anchor left"));
    await insertOnCanvas("button", { button: "back" });
    expect(alertAsync).toHaveBeenCalledTimes(1);
    expect(String(alertAsync.mock.calls[0][0])).toContain("no anchor left");
  });
});
