//! FILENAME: app/extensions/Tracing/lib/__tests__/arrowGeometry.test.ts
// PURPOSE: Tests for arrow geometry calculations (pixel coordinates from cell positions).

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
import type { TraceArrow, ArrowPath } from "../../types";
import type { OverlayRenderContext } from "@api";

// ============================================================================
// Test Helpers
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
    id: "test-1",
    direction: "dependents",
    sourceRow: 2,
    sourceCol: 3,
    targetRow: 5,
    targetCol: 7,
    isCrossSheet: false,
    style: "solid-blue",
    level: 1,
    ...overrides,
  };
}

// ============================================================================
// computeArrowPath - Single Cell Arrows
// ============================================================================

describe("computeArrowPath", () => {
  describe("single cell arrows", () => {
    it("computes start/end from cell centers for dependents", () => {
      const arrow = makeArrow({
        sourceRow: 2,
        sourceCol: 3,
        targetRow: 5,
        targetCol: 7,
        direction: "dependents",
      });
      const result = computeArrowPath(arrow, makeCtx());

      expect(result).not.toBeNull();
      // Source center: col=3 -> x=300, w=100 -> cx=350; row=2 -> y=50, h=25 -> cy=62.5
      expect(result!.startX).toBe(350);
      expect(result!.startY).toBe(62.5);
      // Target center: col=7 -> x=700, w=100 -> cx=750; row=5 -> y=125, h=25 -> cy=137.5
      expect(result!.endX).toBe(750);
      expect(result!.endY).toBe(137.5);
    });

    it("swaps start/end for precedents direction", () => {
      const arrow = makeArrow({
        sourceRow: 2,
        sourceCol: 3,
        targetRow: 5,
        targetCol: 7,
        direction: "precedents",
      });
      const result = computeArrowPath(arrow, makeCtx());

      expect(result).not.toBeNull();
      // For precedents, start/end are swapped so arrowhead points at source
      expect(result!.startX).toBe(750); // target becomes start
      expect(result!.startY).toBe(137.5);
      expect(result!.endX).toBe(350); // source becomes end
      expect(result!.endY).toBe(62.5);
    });

    it("computes correct angle for horizontal arrow", () => {
      const arrow = makeArrow({
        sourceRow: 0,
        sourceCol: 0,
        targetRow: 0,
        targetCol: 5,
        direction: "dependents",
      });
      const result = computeArrowPath(arrow, makeCtx());

      expect(result).not.toBeNull();
      // Same row, so angle should be 0 (pointing right)
      expect(result!.angle).toBe(0);
    });

    it("computes correct angle for vertical arrow", () => {
      const arrow = makeArrow({
        sourceRow: 0,
        sourceCol: 0,
        targetRow: 5,
        targetCol: 0,
        direction: "dependents",
      });
      const result = computeArrowPath(arrow, makeCtx());

      expect(result).not.toBeNull();
      // Same column, so angle should be PI/2 (pointing down)
      expect(result!.angle).toBeCloseTo(Math.PI / 2);
    });
  });

  // ==========================================================================
  // Cross-sheet arrows
  // ==========================================================================

  describe("cross-sheet arrows", () => {
    it("endpoints extend 50px to the right of the source cell", () => {
      const arrow = makeArrow({
        sourceRow: 1,
        sourceCol: 2,
        isCrossSheet: true,
        direction: "dependents",
      });
      const result = computeArrowPath(arrow, makeCtx());

      expect(result).not.toBeNull();
      // Source center: col=2 -> x=200, w=100 -> cx=250; row=1 -> y=25, h=25 -> cy=37.5
      expect(result!.startX).toBe(250);
      expect(result!.startY).toBe(37.5);
      // Cross-sheet end: srcX + srcW + 50 = 200 + 100 + 50 = 350
      expect(result!.endX).toBe(350);
      expect(result!.endY).toBe(37.5);
    });

    it("swaps for precedents direction", () => {
      const arrow = makeArrow({
        sourceRow: 1,
        sourceCol: 2,
        isCrossSheet: true,
        direction: "precedents",
      });
      const result = computeArrowPath(arrow, makeCtx());

      expect(result).not.toBeNull();
      // Swapped: cross-sheet icon becomes start
      expect(result!.startX).toBe(350);
      expect(result!.endX).toBe(250);
    });
  });

  // ==========================================================================
  // Range arrows
  // ==========================================================================

  describe("range arrows", () => {
    it("targets the nearest edge midpoint of the range", () => {
      // Source at row=0, col=0 (center: 50, 12.5)
      // Range from row=3..5, col=3..5 (rect: x=300, y=75, w=300, h=75)
      const arrow = makeArrow({
        sourceRow: 0,
        sourceCol: 0,
        targetRow: 4,
        targetCol: 4,
        targetRange: { startRow: 3, startCol: 3, endRow: 5, endCol: 5 },
        direction: "dependents",
      });
      const result = computeArrowPath(arrow, makeCtx());

      expect(result).not.toBeNull();
      expect(result!.startX).toBe(50);
      expect(result!.startY).toBe(12.5);
      // The nearest edge from (50, 12.5) to the range rect should be the top edge
      // top edge midpoint: (450, 75)
      // But nearest is computed by distance: top=|12.5-75|=62.5, left=|50-300|=250
      // So top edge wins
      expect(result!.endY).toBe(75);
    });
  });

  // ==========================================================================
  // Off-screen culling
  // ==========================================================================

  describe("off-screen culling", () => {
    it("returns null when both endpoints are far left", () => {
      // Put source and target way off-screen by using a small canvas
      const ctx = makeCtx({ canvasWidth: 50, canvasHeight: 50 });
      const arrow = makeArrow({
        sourceRow: 100,
        sourceCol: 100,
        targetRow: 101,
        targetCol: 101,
        direction: "dependents",
      });
      const result = computeArrowPath(arrow, ctx);

      // Both endpoints at x>10000, canvas is 50px wide => should be culled
      expect(result).toBeNull();
    });

    it("returns non-null when at least one endpoint is visible", () => {
      const arrow = makeArrow({
        sourceRow: 0,
        sourceCol: 0,
        targetRow: 0,
        targetCol: 1,
        direction: "dependents",
      });
      const result = computeArrowPath(arrow, makeCtx());

      expect(result).not.toBeNull();
    });
  });
});

// ============================================================================
// getRangeRect
// ============================================================================

describe("getRangeRect", () => {
  it("returns correct pixel rectangle for a range", () => {
    const range = { startRow: 2, startCol: 3, endRow: 5, endCol: 6 };
    const rect = getRangeRect(range, makeCtx());

    // x = col 3 * 100 = 300
    // y = row 2 * 25 = 50
    // width = (6 - 3 + 1) * 100 = 400
    // height = (5 - 2 + 1) * 25 = 100
    expect(rect.x).toBe(300);
    expect(rect.y).toBe(50);
    expect(rect.width).toBe(400);
    expect(rect.height).toBe(100);
  });

  it("returns correct rect for a single-cell range", () => {
    const range = { startRow: 0, startCol: 0, endRow: 0, endCol: 0 };
    const rect = getRangeRect(range, makeCtx());

    expect(rect.x).toBe(0);
    expect(rect.y).toBe(0);
    expect(rect.width).toBe(100);
    expect(rect.height).toBe(25);
  });
});
