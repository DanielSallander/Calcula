//! FILENAME: app/extensions/FloatingRange/lib/__tests__/frCanvasGeometry.test.ts
// PURPOSE: The floating range's own frame bounds use the gutters Core PAINTED.
//
// CONTEXT (M7 map finding 6). `frameCanvasBounds` read the STORED config's
//          gutters (`rowHeaderGutter(state.config)`), while Core paints and
//          hit-tests with the effective ones. On a CANVAS sheet the headings are
//          never shown, but `config.rowHeaderWidth` still says 50 (here), so the
//          extension's drag-extend, body drag and right-click menu looked for
//          the frame one gutter right of and below where it was drawn. The same
//          holds on a worksheet with View > Headings off. These cases fail with
//          the old line and pass with `paintedDisplayHeadings`.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FloatingRangeInfo } from "@api/floatingRanges";

const snapshot = {
  surface: "canvas" as "canvas" | "grid",
  displayHeadings: true,
  zoom: 1,
  config: { rowHeaderWidth: 50, colHeaderHeight: 24 },
  viewport: { scrollX: 0, scrollY: 0 },
};

vi.mock("@api/grid", async () => {
  const header = await vi.importActual<typeof import("../../../../src/core/lib/gridRenderer/layout/headerVisibility")>(
    "../../../../src/core/lib/gridRenderer/layout/headerVisibility",
  );
  return {
    getGridStateSnapshot: () => snapshot,
    resolveHeaderSizes: header.resolveHeaderSizes,
    paintedDisplayHeadings: header.paintedDisplayHeadings,
    rowHeaderGutter: header.rowHeaderGutter,
    colHeaderGutter: header.colHeaderGutter,
  };
});

vi.mock("@api/floatingRanges", () => ({
  FLOATING_RANGE_MAX_ROWS: 1000,
  FLOATING_RANGE_MAX_COLS: 256,
  listFloatingRanges: vi.fn(async () => []),
  updateFloatingRange: vi.fn(async () => ({})),
}));

import { frameCanvasBounds, frameAtCanvasPoint } from "../frCanvasGeometry";
import { upsertFromInfo, resetFloatingRangeStore, setFrActiveSheetIndex } from "../floatingRangeStore";
import { frameWidth, frameHeight } from "../frDimensions";

const INFO = {
  id: "fr-geo",
  backingSheetId: "backing",
  hostSheetId: "host",
  x: 200,
  y: 100,
  rotation: 0,
  pinToGrid: false,
  rowCount: 3,
  colCount: 2,
  colWidths: {},
  rowHeights: {},
  showTitle: true,
  showColumnHeaders: true,
  showRowHeaders: true,
  name: "Float1",
  backingSheetIndex: 1,
  hostSheetIndex: 0,
} as FloatingRangeInfo;

beforeEach(() => {
  snapshot.surface = "canvas";
  snapshot.displayHeadings = true;
  snapshot.viewport = { scrollX: 0, scrollY: 0 };
  resetFloatingRangeStore();
  setFrActiveSheetIndex(0);
});

afterEach(() => {
  resetFloatingRangeStore();
});

describe("frameCanvasBounds uses the PAINTED gutters", () => {
  it("on a canvas sheet the frame starts at its sheet position (no gutter), whatever the stored config says", () => {
    const e = upsertFromInfo(INFO);
    expect(frameCanvasBounds(e)).toEqual({
      x: 200,
      y: 100,
      width: frameWidth(e),
      height: frameHeight(e),
    });
  });

  it("on a worksheet with headings it offsets by the configured gutters", () => {
    snapshot.surface = "grid";
    const e = upsertFromInfo(INFO);
    expect(frameCanvasBounds(e)).toMatchObject({ x: 250, y: 124 });
  });

  it("on a worksheet with View > Headings off it offsets by nothing", () => {
    snapshot.surface = "grid";
    snapshot.displayHeadings = false;
    const e = upsertFromInfo(INFO);
    expect(frameCanvasBounds(e)).toMatchObject({ x: 200, y: 100 });
  });

  it("still subtracts the grid scroll", () => {
    snapshot.viewport = { scrollX: 30, scrollY: 40 };
    const e = upsertFromInfo(INFO);
    expect(frameCanvasBounds(e)).toMatchObject({ x: 170, y: 60 });
  });
});

describe("frameAtCanvasPoint finds the frame where it is DRAWN on a canvas", () => {
  it("a point just inside the painted top-left corner finds the range", () => {
    const e = upsertFromInfo(INFO);
    expect(frameAtCanvasPoint(203, 103)?.id).toBe(e.id);
  });

  it("a point one gutter past the painted bottom-right corner does not", () => {
    const e = upsertFromInfo(INFO);
    // Inside the OLD (raw-config) box, outside the painted frame.
    expect(frameAtCanvasPoint(200 + frameWidth(e) + 20, 100 + frameHeight(e) + 10)).toBeNull();
  });
});
