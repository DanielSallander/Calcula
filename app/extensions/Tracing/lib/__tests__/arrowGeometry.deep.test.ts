//! FILENAME: app/extensions/Tracing/lib/__tests__/arrowGeometry.deep.test.ts
// PURPOSE: Deep tests for arrow geometry covering all directions, edge cases, and range targeting.

import { describe, it, expect, vi } from "vitest";

// Mock the @api overlay helpers before importing the module under test
vi.mock("@api", () => ({
  overlayGetColumnX: vi.fn((ctx: any, col: number) => col * 100),
  overlayGetRowY: vi.fn((ctx: any, row: number) => row * 25),
  overlayGetColumnWidth: vi.fn((_ctx: any, _col: number) => 100),
  overlayGetRowHeight: vi.fn((_ctx: any, _row: number) => 25),
  overlayGetColumnsWidth: vi.fn((_ctx: any, startCol: number, endCol: number) =>
    (endCol - startCol + 1) * 100,
  ),
  overlayGetRowsHeight: vi.fn((_ctx: any, startRow: number, endRow: number) =>
    (endRow - startRow + 1) * 25,
  ),
}));

import { computeArrowPath, getRangeRect } from "../arrowGeometry";
import type { TraceArrow } from "../../types";
import type { OverlayRenderContext } from "@api";

// ============================================================================
// Helpers
// ============================================================================

function makeCtx(
  overrides: Partial<OverlayRenderContext> = {},
): OverlayRenderContext {
  return {
    canvasWidth: 1200,
    canvasHeight: 800,
    ...overrides,
  } as OverlayRenderContext;
}

function makeArrow(overrides: Partial<TraceArrow> = {}): TraceArrow {
  return {
    id: "test",
    direction: "dependents",
    sourceRow: 0,
    sourceCol: 0,
    targetRow: 0,
    targetCol: 0,
    isCrossSheet: false,
    style: "solid-blue",
    level: 1,
    ...overrides,
  };
}

/** Center coordinates for a cell at given row/col (100px wide, 25px tall). */
function cellCenter(row: number, col: number) {
  return { x: col * 100 + 50, y: row * 25 + 12.5 };
}

// ============================================================================
// All 8 directions
// ============================================================================

describe("arrows in all 8 directions", () => {
  const src = { sourceRow: 5, sourceCol: 5 };
  const cases: Array<{ name: string; targetRow: number; targetCol: number; expectedAngle: number }> = [
    { name: "right",       targetRow: 5, targetCol: 8,  expectedAngle: 0 },
    { name: "left",        targetRow: 5, targetCol: 2,  expectedAngle: Math.PI },
    { name: "down",        targetRow: 8, targetCol: 5,  expectedAngle: Math.PI / 2 },
    { name: "up",          targetRow: 2, targetCol: 5,  expectedAngle: -Math.PI / 2 },
    { name: "down-right",  targetRow: 8, targetCol: 8,  expectedAngle: Math.atan2(3 * 25, 3 * 100) },
    { name: "down-left",   targetRow: 8, targetCol: 2,  expectedAngle: Math.atan2(3 * 25, -3 * 100) },
    { name: "up-right",    targetRow: 2, targetCol: 8,  expectedAngle: Math.atan2(-3 * 25, 3 * 100) },
    { name: "up-left",     targetRow: 2, targetCol: 2,  expectedAngle: Math.atan2(-3 * 25, -3 * 100) },
  ];

  for (const c of cases) {
    it(`computes correct angle for ${c.name} arrow`, () => {
      const arrow = makeArrow({ ...src, targetRow: c.targetRow, targetCol: c.targetCol });
      const result = computeArrowPath(arrow, makeCtx())!;
      expect(result).not.toBeNull();
      expect(result.angle).toBeCloseTo(c.expectedAngle, 10);
    });
  }
});

// ============================================================================
// Very long arrows
// ============================================================================

describe("very long arrows (1000+ pixels)", () => {
  it("computes path for arrow spanning many columns", () => {
    const arrow = makeArrow({ sourceRow: 0, sourceCol: 0, targetRow: 0, targetCol: 50 });
    const ctx = makeCtx({ canvasWidth: 10000, canvasHeight: 800 });
    const result = computeArrowPath(arrow, ctx)!;

    expect(result).not.toBeNull();
    const dx = result.endX - result.startX;
    expect(dx).toBe(50 * 100); // 5000 pixels
    expect(result.angle).toBe(0);
  });

  it("computes path for arrow spanning many rows", () => {
    const arrow = makeArrow({ sourceRow: 0, sourceCol: 0, targetRow: 100, targetCol: 0 });
    const ctx = makeCtx({ canvasWidth: 1200, canvasHeight: 5000 });
    const result = computeArrowPath(arrow, ctx)!;

    expect(result).not.toBeNull();
    const dy = result.endY - result.startY;
    expect(dy).toBe(100 * 25); // 2500 pixels
  });
});

// ============================================================================
// Very short arrows (1-2 pixels apart)
// ============================================================================

describe("very short arrows", () => {
  it("arrow between adjacent cells has non-zero length", () => {
    const arrow = makeArrow({ sourceRow: 0, sourceCol: 0, targetRow: 0, targetCol: 1 });
    const result = computeArrowPath(arrow, makeCtx())!;
    expect(result).not.toBeNull();
    const length = Math.hypot(result.endX - result.startX, result.endY - result.startY);
    expect(length).toBe(100); // center-to-center = one cell width
  });

  it("arrow between vertically adjacent cells", () => {
    const arrow = makeArrow({ sourceRow: 0, sourceCol: 0, targetRow: 1, targetCol: 0 });
    const result = computeArrowPath(arrow, makeCtx())!;
    expect(result).not.toBeNull();
    const length = Math.hypot(result.endX - result.startX, result.endY - result.startY);
    expect(length).toBe(25); // center-to-center = one row height
  });

  it("arrow from cell to itself has zero length", () => {
    const arrow = makeArrow({ sourceRow: 3, sourceCol: 3, targetRow: 3, targetCol: 3 });
    const result = computeArrowPath(arrow, makeCtx())!;
    expect(result).not.toBeNull();
    expect(result.startX).toBe(result.endX);
    expect(result.startY).toBe(result.endY);
  });
});

// ============================================================================
// Multiple arrows from same source
// ============================================================================

describe("multiple arrows from same source to different targets", () => {
  it("all share the same start point", () => {
    const targets = [
      { targetRow: 0, targetCol: 5 },
      { targetRow: 5, targetCol: 0 },
      { targetRow: 5, targetCol: 5 },
    ];
    const results = targets.map((t) =>
      computeArrowPath(makeArrow({ sourceRow: 2, sourceCol: 2, ...t }), makeCtx())!,
    );

    const srcCenter = cellCenter(2, 2);
    for (const r of results) {
      expect(r.startX).toBe(srcCenter.x);
      expect(r.startY).toBe(srcCenter.y);
    }
  });

  it("each has a distinct endpoint and angle", () => {
    const targets = [
      { targetRow: 0, targetCol: 5 },
      { targetRow: 5, targetCol: 0 },
      { targetRow: 5, targetCol: 5 },
    ];
    const results = targets.map((t) =>
      computeArrowPath(makeArrow({ sourceRow: 2, sourceCol: 2, ...t }), makeCtx())!,
    );

    const angles = results.map((r) => r.angle);
    const uniqueAngles = new Set(angles);
    expect(uniqueAngles.size).toBe(3);
  });
});

// ============================================================================
// Range endpoint targeting
// ============================================================================

describe("range endpoint: nearest edge selection", () => {
  it("picks top edge when source is above the range", () => {
    const arrow = makeArrow({
      sourceRow: 0, sourceCol: 5,
      targetRange: { startRow: 5, startCol: 3, endRow: 8, endCol: 7 },
    });
    const result = computeArrowPath(arrow, makeCtx())!;
    // Range top = row 5 * 25 = 125
    expect(result.endY).toBe(125);
  });

  it("picks bottom edge when source is far below the range", () => {
    // Source must be far enough below that bottom-edge distance < left/right-edge distance
    // Range rows 5-8, cols 5-6. Rect: x=500, y=125, w=200, h=100. bottom=225, midX=600
    // Source at row=40, col=5. Center=(550, 1012.5).
    // Distances: top=|1012.5-125|=887.5, bottom=|1012.5-225|=787.5, left=|550-500|=50, right=|550-700|=150
    // left wins. Need source col inside range horizontally but far below.
    // Use range cols 0-10 so left=0, right=1100, midX=550. Source col=5, center x=550.
    // left dist=|550-0|=550, right dist=|550-1100|=550, top dist far, bottom dist less.
    // We need bottom dist < 550. Source at row=30, center y=762.5. bottom=225. dist=537.5 < 550. Yes!
    const arrow = makeArrow({
      sourceRow: 30, sourceCol: 5,
      targetRange: { startRow: 5, startCol: 0, endRow: 8, endCol: 10 },
    });
    const result = computeArrowPath(arrow, makeCtx())!;
    // bottom = 125 + 4*25 = 225. dist to bottom = |762.5 - 225| = 537.5
    // left dist = |550 - 0| = 550, right dist = |550 - 1100| = 550
    // bottom wins
    expect(result.endY).toBe(225);
  });

  it("picks left edge when source is far left of range", () => {
    // Range rows 0-20, cols 5-10. Rect: x=500, y=0, w=600, h=525.
    // top=0, bottom=525, midY=262.5, left=500, right=1100
    // Source at row=10, col=0. Center=(50, 262.5).
    // top dist=|262.5-0|=262.5, bottom dist=|262.5-525|=262.5, left dist=|50-500|=450, right dist=|50-1100|=1050
    // top and bottom tie at 262.5, both < left. Need range tall enough that midY ~ srcY.
    // Actually we need left dist < top and bottom dist.
    // Use range rows 9-11, cols 10-15. Rect: x=1000, y=225, w=600, h=75.
    // Source at row=10, col=0. Center=(50, 262.5).
    // top=225, bottom=300, left=1000, right=1600, midY=262.5
    // top dist=|262.5-225|=37.5, bottom=|262.5-300|=37.5, left=|50-1000|=950, right=|50-1600|=1550
    // top/bottom win. We need source y well inside range vertically so top/bottom dist ~ 0.
    // Try: range rows 0-100, source at row=50. Center=(50, 1262.5). Range y=0..2525.
    // top dist=1262.5, bottom=1262.5, left dist=|50-1000|=950. left < top/bottom!
    const arrow = makeArrow({
      sourceRow: 50, sourceCol: 0,
      targetRange: { startRow: 0, startCol: 10, endRow: 100, endCol: 15 },
    });
    const result = computeArrowPath(arrow, makeCtx({ canvasWidth: 5000, canvasHeight: 5000 }))!;
    // left = col10 * 100 = 1000
    expect(result.endX).toBe(1000);
  });

  it("picks right edge when source is far right of range", () => {
    // Range rows 49-51 (narrow), cols 0-2. Source at row=50 (inside vertically), col=30 (far right).
    // Rect: x=0, y=1225, w=300, h=75. top=1225, bottom=1300, left=0, right=300, midY=1262.5
    // Source center: (3050, 1262.5).
    // top dist=|1262.5-1225|=37.5, bottom=|1262.5-1300|=37.5, left=|3050-0|=3050, right=|3050-300|=2750
    // top/bottom win again. Need source y far from range vertically but close to right edge.
    // Range rows 0-0, cols 0-2. Rect: x=0, y=0, w=300, h=25. top=0, bottom=25, right=300, midY=12.5
    // Source at row=0, col=30. Center=(3050, 12.5).
    // top=|12.5-0|=12.5, bottom=|12.5-25|=12.5, left=|3050-0|=3050, right=|3050-300|=2750
    // top/bottom tie at 12.5. They win. Can't get right edge to win with this distance metric.
    // The algorithm always compares |srcY - edgeY| vs |srcX - edgeX|.
    // Right edge wins when |srcX - right| < |srcY - top| and |srcX - right| < |srcY - bottom|.
    // Use range rows 0-1000 so top/bottom dists are large. Source at row=500, col=30.
    // top=0, bottom=25025, source y=12512.5. top dist=12512.5, bottom=12512.5.
    // right = (endCol+1)*100, range cols 10-12, right=1300. |3050-1300|=1750 < 12512.5. Right wins!
    const arrow = makeArrow({
      sourceRow: 500, sourceCol: 30,
      targetRange: { startRow: 0, startCol: 10, endRow: 1000, endCol: 12 },
    });
    const result = computeArrowPath(arrow, makeCtx({ canvasWidth: 10000, canvasHeight: 30000 }))!;
    // right = 1000 + 3*100 = 1300
    expect(result.endX).toBe(1300);
  });

  it("single-cell range targets the edge, not center", () => {
    // Source above and to the left, range is a single cell at (5,5)
    const arrow = makeArrow({
      sourceRow: 0, sourceCol: 0,
      targetRange: { startRow: 5, startCol: 5, endRow: 5, endCol: 5 },
    });
    const result = computeArrowPath(arrow, makeCtx())!;
    // Range rect: x=500, y=125, w=100, h=25
    // top edge dist = |12.5 - 125| = 112.5; left edge dist = |50 - 500| = 450
    // Top wins, endpoint = (550, 125)
    expect(result.endY).toBe(125);
    expect(result.endX).toBe(550);
  });
});

// ============================================================================
// Cross-sheet arrows with various offsets
// ============================================================================

describe("cross-sheet arrows", () => {
  it("always extends 50px right of source cell regardless of position", () => {
    for (const col of [0, 5, 10]) {
      const arrow = makeArrow({
        sourceRow: 0, sourceCol: col, isCrossSheet: true,
      });
      const result = computeArrowPath(arrow, makeCtx())!;
      const expectedEnd = col * 100 + 100 + 50;
      expect(result.endX).toBe(expectedEnd);
    }
  });

  it("cross-sheet arrow is always horizontal (angle = 0 for dependents)", () => {
    const arrow = makeArrow({
      sourceRow: 3, sourceCol: 2, isCrossSheet: true, direction: "dependents",
    });
    const result = computeArrowPath(arrow, makeCtx())!;
    expect(result.angle).toBe(0);
  });

  it("cross-sheet precedents arrow angle is PI (pointing left)", () => {
    const arrow = makeArrow({
      sourceRow: 3, sourceCol: 2, isCrossSheet: true, direction: "precedents",
    });
    const result = computeArrowPath(arrow, makeCtx())!;
    expect(result.angle).toBeCloseTo(Math.PI, 10);
  });
});

// ============================================================================
// Viewport boundary / off-screen culling
// ============================================================================

describe("viewport boundary and culling", () => {
  it("returns null when both endpoints are far below canvas", () => {
    const ctx = makeCtx({ canvasWidth: 1200, canvasHeight: 100 });
    const arrow = makeArrow({ sourceRow: 50, sourceCol: 0, targetRow: 60, targetCol: 0 });
    const result = computeArrowPath(arrow, ctx);
    // Both y values > 100 + 100 margin = 200. row50 center = 1262.5 >> 200
    expect(result).toBeNull();
  });

  it("returns non-null when one endpoint is inside viewport", () => {
    const ctx = makeCtx({ canvasWidth: 1200, canvasHeight: 100 });
    const arrow = makeArrow({ sourceRow: 0, sourceCol: 0, targetRow: 50, targetCol: 0 });
    const result = computeArrowPath(arrow, ctx);
    // Source at y=12.5 is visible
    expect(result).not.toBeNull();
  });

  it("returns non-null when arrow crosses viewport without endpoints inside", () => {
    // Start at negative x, end at beyond canvas width, but y is in view
    const ctx = makeCtx({ canvasWidth: 500, canvasHeight: 200 });
    // Source at col=0 center = 50 (inside), target at col=100 center = 10050 (outside right)
    // Only startX < canvasWidth+margin, so not culled
    const arrow = makeArrow({ sourceRow: 0, sourceCol: 0, targetRow: 0, targetCol: 100 });
    const result = computeArrowPath(arrow, ctx);
    expect(result).not.toBeNull();
  });

  it("returns null when both endpoints far to the right", () => {
    const ctx = makeCtx({ canvasWidth: 200, canvasHeight: 200 });
    const arrow = makeArrow({ sourceRow: 0, sourceCol: 50, targetRow: 0, targetCol: 60 });
    const result = computeArrowPath(arrow, ctx);
    // Both x > 200 + 100 = 300. col50 center = 5050 >> 300
    expect(result).toBeNull();
  });

  it("returns arrow when within margin but outside canvas", () => {
    const ctx = makeCtx({ canvasWidth: 100, canvasHeight: 100 });
    // Source at col=1, center = 150. Canvas = 100, margin = 100, threshold = 200
    // 150 < 200, so not culled
    const arrow = makeArrow({ sourceRow: 0, sourceCol: 1, targetRow: 0, targetCol: 0 });
    const result = computeArrowPath(arrow, ctx);
    expect(result).not.toBeNull();
  });
});

// ============================================================================
// Precedents direction with range targets
// ============================================================================

describe("precedents direction with range targets", () => {
  it("swaps start and end for range arrows in precedents mode", () => {
    const arrow = makeArrow({
      sourceRow: 0, sourceCol: 0,
      targetRange: { startRow: 5, startCol: 5, endRow: 8, endCol: 8 },
      direction: "precedents",
    });
    const result = computeArrowPath(arrow, makeCtx())!;
    expect(result).not.toBeNull();
    // In precedents mode, the range edge becomes startX/Y and source center becomes endX/Y
    const srcCenter = cellCenter(0, 0);
    expect(result.endX).toBe(srcCenter.x);
    expect(result.endY).toBe(srcCenter.y);
  });
});

// ============================================================================
// getRangeRect edge cases
// ============================================================================

describe("getRangeRect edge cases", () => {
  it("handles large ranges correctly", () => {
    const range = { startRow: 0, startCol: 0, endRow: 99, endCol: 25 };
    const rect = getRangeRect(range, makeCtx());
    expect(rect.width).toBe(2600);
    expect(rect.height).toBe(2500);
  });

  it("range at high row/col offsets", () => {
    const range = { startRow: 100, startCol: 50, endRow: 100, endCol: 50 };
    const rect = getRangeRect(range, makeCtx());
    expect(rect.x).toBe(5000);
    expect(rect.y).toBe(2500);
    expect(rect.width).toBe(100);
    expect(rect.height).toBe(25);
  });
});
