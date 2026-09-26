//! FILENAME: app/extensions/BusinessIntelligence/lib/__tests__/modelPivotCanvas.test.ts
// PURPOSE: "PivotTable from Model" on a CANVAS sheet sends the frame the
//          backend requires (and no frame on a worksheet, which it refuses).
// CONTEXT: The three BI create flows (ModelDialog, ConnectionsPane "New Pivot",
//          CreateModelPivotDialog) all go through createModelPivot; before the
//          canvas rule reached it, every one of them was refused on a canvas
//          with the backend's "needs a frame" message.

import { describe, it, expect, vi, beforeEach } from "vitest";

const createFromBiModel = vi.fn(async (_req: Record<string, unknown>) => ({ pivotId: "p1" }));
let surfaces: Record<number, unknown> = {};
let snapshot: unknown = null;

vi.mock("@api", () => ({
  columnToLetter: (c: number) => String.fromCharCode(65 + c),
  getPivotStoreService: () => ({ openBiPivotEditor: vi.fn() }),
}));
vi.mock("@api/pivot", () => ({
  pivot: { createFromBiModel: (req: Record<string, unknown>) => createFromBiModel(req) },
}));
vi.mock("@api/grid", () => ({ getGridStateSnapshot: () => snapshot }));
vi.mock("@api/layoutSurface", () => ({
  getLayoutSurface: (i: number) => surfaces[i] ?? null,
  snapValue: (v: number, p: number) => Math.round(v / p) * p,
  clampMoveToPage: (r: { x: number; y: number; width: number; height: number }, page: { width: number; height: number } | null) =>
    page
      ? {
          ...r,
          x: Math.min(Math.max(0, r.x), Math.max(0, page.width - r.width)),
          y: Math.min(Math.max(0, r.y), Math.max(0, page.height - r.height)),
        }
      : r,
}));
vi.mock("../../../_shared/lib/bi-api", () => ({
  getModelInfo: vi.fn(async () => ({ tables: [], measures: [], hierarchies: [] })),
}));

import { createModelPivot } from "../modelPivot";

const MODEL = { tables: [], measures: [], hierarchies: [] } as never;

describe("createModelPivot on a canvas", () => {
  beforeEach(() => {
    createFromBiModel.mockClear();
    surfaces = {};
    snapshot = {
      zoom: 1,
      sheetContext: { activeSheetIndex: 1 },
      viewport: { scrollX: 0, scrollY: 0 },
      viewportDimensions: { width: 1000, height: 600 },
    };
  });

  it("sends a snapped frame, centred in the view, when the (active) destination is a canvas", async () => {
    surfaces[1] = { snapToGrid: true, gridSize: 16, showGrid: true, page: { width: 1280, height: 720 }, editable: true };
    await createModelPivot("conn", { row: 4, col: 2 }, MODEL);
    const req = createFromBiModel.mock.calls[0][0];
    expect(req.destinationSheet).toBe(1);
    expect(req.canvasFrame).toEqual({ x: 256, y: 144, width: 480, height: 320, frozenHeaders: true });
  });

  it("sends NO frame to a worksheet, and keeps its destination cell", async () => {
    snapshot = { ...(snapshot as object), sheetContext: { activeSheetIndex: 0 } };
    await createModelPivot("conn", { row: 4, col: 2, sheetIndex: 0 }, MODEL);
    const req = createFromBiModel.mock.calls[0][0];
    expect("canvasFrame" in req).toBe(false);
    expect(req.destinationCell).toBe("C5");
    expect(req.destinationSheet).toBe(0);
  });

  it("a canvas that is not on screen gets a frame at the top of its page", async () => {
    surfaces[3] = { snapToGrid: true, gridSize: 16, showGrid: true, page: { width: 1280, height: 720 }, editable: true };
    await createModelPivot("conn", { row: 0, col: 0, sheetIndex: 3 }, MODEL);
    const req = createFromBiModel.mock.calls[0][0];
    expect(req.destinationSheet).toBe(3);
    expect(req.canvasFrame).toMatchObject({ x: 0, y: 0, width: 480, height: 320 });
  });
});
