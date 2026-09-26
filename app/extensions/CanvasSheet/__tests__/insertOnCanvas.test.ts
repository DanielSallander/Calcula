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
vi.mock("@api/controlsService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/controlsService")>()),
  requireControlsProvider: () => ({ createShape }),
}));
const createButton = vi.fn();
vi.mock("@api/buttonControlService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/buttonControlService")>()),
  requireButtonControlProvider: () => ({ createButton }),
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

import { INSERT_SIZES, defaultInsertRect, insertOnCanvas, resetInsertCascade } from "../lib/insertOnCanvas";

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
  for (const f of [showDialog, createShape, createButton, createPicture, createFloating, importImageViaPicker]) f.mockReset();
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
});
