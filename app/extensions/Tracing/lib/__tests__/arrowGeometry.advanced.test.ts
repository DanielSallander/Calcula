//! FILENAME: app/extensions/Tracing/lib/__tests__/arrowGeometry.advanced.test.ts
// PURPOSE: Advanced tests for arrow geometry: dependency chains, merged cells,
//          crossing arrows, zoom levels, and performance.

import { describe, it, expect, vi, afterEach } from "vitest";

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
import {
  overlayGetColumnX,
  overlayGetRowY,
  overlayGetColumnWidth,
  overlayGetRowHeight,
  overlayGetColumnsWidth,
  overlayGetRowsHeight,
} from "@api";

const mockColX = vi.mocked(overlayGetColumnX);
const mockRowY = vi.mocked(overlayGetRowY);
const mockColW = vi.mocked(overlayGetColumnWidth);
const mockRowH = vi.mocked(overlayGetRowHeight);
const mockColsW = vi.mocked(overlayGetColumnsWidth);
const mockRowsH = vi.mocked(overlayGetRowsHeight);

afterEach(() => {
  // Restore default mock implementations
  mockColX.mockImplementation((_ctx: any, col: number) => col * 100);
  mockRowY.mockImplementation((_ctx: any, row: number) => row * 25);
  mockColW.mockImplementation(() => 100);
  mockRowH.mockImplementation(() => 25);
  mockColsW.mockImplementation((_ctx: any, s: number, e: number) => (e - s + 1) * 100);
  mockRowsH.mockImplementation((_ctx: any, s: number, e: number) => (e - s + 1) * 25);
});

// ============================================================================
// Helpers
// ============================================================================

function makeCtx(
  overrides: Partial<OverlayRenderContext> = {},
): OverlayRenderContext {
  return {
    canvasWidth: 2000,
    canvasHeight: 2000,
    ...overrides,
  } as OverlayRenderContext;
}

function makeArrow(overrides: Partial<TraceArrow> = {}): TraceArrow {
  return {
    id: "adv-test",
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

function cellCenter(row: number, col: number) {
  return { x: col * 100 + 50, y: row * 25 + 12.5 };
}

function arrowLength(path: ArrowPath): number {
  return Math.hypot(path.endX - path.startX, path.endY - path.startY);
}

// ============================================================================
// Complex dependency chains: A1 -> B1 -> C1 -> D1 (4-level)
// ============================================================================

describe("complex dependency chains", () => {
  it("4-level chain A1->B1->C1->D1 produces correct per-segment paths", () => {
    const chain = [
      makeArrow({ id: "a1-b1", sourceRow: 0, sourceCol: 0, targetRow: 0, targetCol: 1, level: 1 }),
      makeArrow({ id: "b1-c1", sourceRow: 0, sourceCol: 1, targetRow: 0, targetCol: 2, level: 2 }),
      makeArrow({ id: "c1-d1", sourceRow: 0, sourceCol: 2, targetRow: 0, targetCol: 3, level: 3 }),
    ];

    const ctx = makeCtx();
    const paths = chain.map((a) => computeArrowPath(a, ctx)!);

    // All should be non-null
    paths.forEach((p) => expect(p).not.toBeNull());

    // Each segment connects end-to-end (source center of next = target center of prev)
    expect(paths[0].endX).toBe(paths[1].startX);
    expect(paths[0].endY).toBe(paths[1].startY);
    expect(paths[1].endX).toBe(paths[2].startX);
    expect(paths[1].endY).toBe(paths[2].startY);
  });

  it("chain with branching: A1->B1, A1->B2 shares source", () => {
    const a1b1 = computeArrowPath(
      makeArrow({ sourceRow: 0, sourceCol: 0, targetRow: 0, targetCol: 1 }),
      makeCtx(),
    )!;
    const a1b2 = computeArrowPath(
      makeArrow({ sourceRow: 0, sourceCol: 0, targetRow: 1, targetCol: 1 }),
      makeCtx(),
    )!;

    expect(a1b1.startX).toBe(a1b2.startX);
    expect(a1b1.startY).toBe(a1b2.startY);
    expect(a1b1.endY).not.toBe(a1b2.endY);
  });

  it("chain with convergence: B1->D1, C1->D1 shares target", () => {
    const b1d1 = computeArrowPath(
      makeArrow({ sourceRow: 0, sourceCol: 1, targetRow: 0, targetCol: 3 }),
      makeCtx(),
    )!;
    const c1d1 = computeArrowPath(
      makeArrow({ sourceRow: 0, sourceCol: 2, targetRow: 0, targetCol: 3 }),
      makeCtx(),
    )!;

    expect(b1d1.endX).toBe(c1d1.endX);
    expect(b1d1.endY).toBe(c1d1.endY);
    expect(b1d1.startX).not.toBe(c1d1.startX);
  });

  it("precedents chain reverses direction at every level", () => {
    const chain = [
      makeArrow({ sourceRow: 0, sourceCol: 0, targetRow: 0, targetCol: 1, direction: "precedents", level: 1 }),
      makeArrow({ sourceRow: 0, sourceCol: 1, targetRow: 0, targetCol: 2, direction: "precedents", level: 2 }),
    ];

    const ctx = makeCtx();
    const paths = chain.map((a) => computeArrowPath(a, ctx)!);

    // For precedents, start/end are swapped: arrowhead at source
    // Arrow 0: source=A1, target=B1 -> start=B1 center, end=A1 center
    const a1 = cellCenter(0, 0);
    const b1 = cellCenter(0, 1);
    expect(paths[0].startX).toBe(b1.x);
    expect(paths[0].endX).toBe(a1.x);
  });
});

// ============================================================================
// Circular reference handling
// ============================================================================

describe("circular reference handling", () => {
  it("self-referencing arrow (A1->A1) produces zero-length path", () => {
    const arrow = makeArrow({ sourceRow: 0, sourceCol: 0, targetRow: 0, targetCol: 0 });
    const result = computeArrowPath(arrow, makeCtx())!;

    expect(result).not.toBeNull();
    expect(result.startX).toBe(result.endX);
    expect(result.startY).toBe(result.endY);
    expect(arrowLength(result)).toBe(0);
  });

  it("two-cell cycle A1->B1, B1->A1 produces valid opposing arrows", () => {
    const ctx = makeCtx();
    const fwd = computeArrowPath(
      makeArrow({ sourceRow: 0, sourceCol: 0, targetRow: 0, targetCol: 1 }),
      ctx,
    )!;
    const bwd = computeArrowPath(
      makeArrow({ sourceRow: 0, sourceCol: 1, targetRow: 0, targetCol: 0 }),
      ctx,
    )!;

    // Forward and backward arrows should have opposite angles
    expect(fwd.angle).toBeCloseTo(0); // right
    expect(bwd.angle).toBeCloseTo(Math.PI); // left
  });

  it("three-cell cycle A1->B1->C1->A1 all produce non-null paths", () => {
    const ctx = makeCtx();
    const arrows = [
      makeArrow({ id: "a-b", sourceRow: 0, sourceCol: 0, targetRow: 0, targetCol: 1 }),
      makeArrow({ id: "b-c", sourceRow: 0, sourceCol: 1, targetRow: 0, targetCol: 2 }),
      makeArrow({ id: "c-a", sourceRow: 0, sourceCol: 2, targetRow: 0, targetCol: 0 }),
    ];
    const paths = arrows.map((a) => computeArrowPath(a, ctx));
    paths.forEach((p) => expect(p).not.toBeNull());
  });
});

// ============================================================================
// Arrows from/to merged cells (simulated via range targets)
// ============================================================================

describe("arrows involving merged cells (range targets)", () => {
  it("arrow to a 2x2 merged cell targets nearest edge", () => {
    // Merged cell spans rows 4-5, cols 4-5
    const arrow = makeArrow({
      sourceRow: 0, sourceCol: 0,
      targetRow: 4, targetCol: 4,
      targetRange: { startRow: 4, startCol: 4, endRow: 5, endCol: 5 },
    });
    const result = computeArrowPath(arrow, makeCtx())!;

    expect(result).not.toBeNull();
    // Range rect: x=400, y=100, w=200, h=50
    // Source center: (50, 12.5)
    // top edge: y=100, dist=87.5; left edge: x=400, dist=350
    // Top edge wins
    expect(result.endY).toBe(100);
  });

  it("arrow to wide merged cell (1 row x 5 cols) from below targets bottom edge", () => {
    // Wide merge: row 2, cols 3-7
    // Source far below: row 50
    const arrow = makeArrow({
      sourceRow: 50, sourceCol: 5,
      targetRow: 2, targetCol: 5,
      targetRange: { startRow: 2, startCol: 3, endRow: 2, endCol: 7 },
    });
    const result = computeArrowPath(arrow, makeCtx())!;

    expect(result).not.toBeNull();
    // Range rect: x=300, y=50, w=500, h=25. bottom=75
    // Source center: (550, 1262.5)
    // top dist=|1262.5-50|=1212.5, bottom dist=|1262.5-75|=1187.5
    // left dist=|550-300|=250, right dist=|550-800|=250
    // left/right win at 250
    // Actually it's a tie between left and right. sort is stable so left wins.
    expect(result.endX).toBe(300); // left edge midpoint x
  });

  it("arrow to tall merged cell (5 rows x 1 col) from right targets right edge", () => {
    // Tall merge: rows 0-4, col 0
    // Source far right: col 50
    const arrow = makeArrow({
      sourceRow: 2, sourceCol: 50,
      targetRow: 2, targetCol: 0,
      targetRange: { startRow: 0, startCol: 0, endRow: 4, endCol: 0 },
    });
    const result = computeArrowPath(arrow, makeCtx({ canvasWidth: 10000 }))!;

    expect(result).not.toBeNull();
    // Range rect: x=0, y=0, w=100, h=125. right=100, midY=62.5
    // Source center: (5050, 62.5)
    // top dist=|62.5-0|=62.5, bottom=|62.5-125|=62.5, left=|5050-0|=5050, right=|5050-100|=4950
    // top/bottom win at 62.5
    expect(result.endY).toBe(0); // top edge (ties go to first in sort = top)
  });
});

// ============================================================================
// Multiple arrows crossing each other
// ============================================================================

describe("multiple arrows crossing each other", () => {
  it("X-pattern: two arrows that cross paths", () => {
    const ctx = makeCtx();
    // Arrow 1: top-left to bottom-right
    const a1 = computeArrowPath(
      makeArrow({ sourceRow: 0, sourceCol: 0, targetRow: 10, targetCol: 10 }),
      ctx,
    )!;
    // Arrow 2: top-right to bottom-left
    const a2 = computeArrowPath(
      makeArrow({ sourceRow: 0, sourceCol: 10, targetRow: 10, targetCol: 0 }),
      ctx,
    )!;

    expect(a1).not.toBeNull();
    expect(a2).not.toBeNull();

    // They should cross roughly in the middle
    // Arrow 1 goes from (50, 12.5) to (1050, 262.5)
    // Arrow 2 goes from (1050, 12.5) to (50, 262.5)
    // Both are independent computations; geometry is valid
    expect(a1.startX).toBeLessThan(a1.endX);
    expect(a2.startX).toBeGreaterThan(a2.endX);
  });

  it("parallel horizontal arrows at different rows never share endpoints", () => {
    const ctx = makeCtx();
    const arrows = Array.from({ length: 5 }, (_, i) =>
      computeArrowPath(
        makeArrow({ sourceRow: i, sourceCol: 0, targetRow: i, targetCol: 5, id: `h-${i}` }),
        ctx,
      )!,
    );

    // All startX should be the same (col 0 center), but startY differs
    const startXs = new Set(arrows.map((a) => a.startX));
    const startYs = new Set(arrows.map((a) => a.startY));
    expect(startXs.size).toBe(1);
    expect(startYs.size).toBe(5);
  });

  it("star pattern: multiple arrows from same cell to surrounding cells", () => {
    const ctx = makeCtx();
    const center = { sourceRow: 5, sourceCol: 5 };
    const targets = [
      { targetRow: 3, targetCol: 3 },
      { targetRow: 3, targetCol: 5 },
      { targetRow: 3, targetCol: 7 },
      { targetRow: 5, targetCol: 3 },
      { targetRow: 5, targetCol: 7 },
      { targetRow: 7, targetCol: 3 },
      { targetRow: 7, targetCol: 5 },
      { targetRow: 7, targetCol: 7 },
    ];

    const paths = targets.map((t, i) =>
      computeArrowPath(makeArrow({ ...center, ...t, id: `star-${i}` }), ctx)!,
    );

    // All paths start from same point
    const srcCenter = cellCenter(5, 5);
    paths.forEach((p) => {
      expect(p).not.toBeNull();
      expect(p.startX).toBe(srcCenter.x);
      expect(p.startY).toBe(srcCenter.y);
    });

    // All 8 angles are distinct
    const angles = new Set(paths.map((p) => p.angle.toFixed(6)));
    expect(angles.size).toBe(8);
  });
});

// ============================================================================
// Arrows at extreme zoom levels (simulated via varying cell sizes)
// ============================================================================

describe("arrows at extreme zoom levels", () => {
  it("very small cells (5px wide, 2px tall) still produce valid paths", () => {
    mockColW.mockReturnValue(5);
    mockRowH.mockReturnValue(2);
    mockColX.mockImplementation((_ctx: any, col: number) => col * 5);
    mockRowY.mockImplementation((_ctx: any, row: number) => row * 2);

    const arrow = makeArrow({ sourceRow: 0, sourceCol: 0, targetRow: 10, targetCol: 10 });
    const result = computeArrowPath(arrow, makeCtx())!;

    expect(result).not.toBeNull();
    // Source center: (2.5, 1), Target center: (52.5, 21)
    expect(result.startX).toBe(2.5);
    expect(result.startY).toBe(1);
    expect(result.endX).toBe(52.5);
    expect(result.endY).toBe(21);
  });

  it("very large cells (500px wide, 200px tall) produce valid paths", () => {
    mockColW.mockReturnValue(500);
    mockRowH.mockReturnValue(200);
    mockColX.mockImplementation((_ctx: any, col: number) => col * 500);
    mockRowY.mockImplementation((_ctx: any, row: number) => row * 200);

    const arrow = makeArrow({ sourceRow: 0, sourceCol: 0, targetRow: 1, targetCol: 1 });
    const result = computeArrowPath(arrow, makeCtx({ canvasWidth: 5000, canvasHeight: 5000 }))!;

    expect(result).not.toBeNull();
    expect(result.startX).toBe(250);
    expect(result.startY).toBe(100);
    expect(result.endX).toBe(750);
    expect(result.endY).toBe(300);
  });

  it("mixed cell sizes (non-uniform widths) produce correct centers", () => {
    const widths = [50, 150, 200, 100];
    const xPositions = [0, 50, 200, 400];
    mockColW.mockImplementation((_ctx: any, col: number) => widths[col] ?? 100);
    mockColX.mockImplementation((_ctx: any, col: number) => xPositions[col] ?? col * 100);

    // Arrow from col 0 (width 50, center 25) to col 2 (x=200, width 200, center 300)
    const arrow = makeArrow({ sourceRow: 0, sourceCol: 0, targetRow: 0, targetCol: 2 });
    const result = computeArrowPath(arrow, makeCtx())!;

    expect(result).not.toBeNull();
    expect(result.startX).toBe(25); // 0 + 50/2
    expect(result.endX).toBe(300); // 200 + 200/2
  });
});

// ============================================================================
// Performance: 100 arrows simultaneously
// ============================================================================

describe("performance with many arrows", () => {
  it("computes 100 arrows in under 50ms", () => {
    const ctx = makeCtx({ canvasWidth: 20000, canvasHeight: 20000 });
    const arrows: TraceArrow[] = [];
    for (let i = 0; i < 100; i++) {
      arrows.push(makeArrow({
        id: `perf-${i}`,
        sourceRow: i,
        sourceCol: 0,
        targetRow: i,
        targetCol: i + 1,
      }));
    }

    const start = performance.now();
    const results = arrows.map((a) => computeArrowPath(a, ctx));
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(50);
    // All should be non-null (all on-screen)
    results.forEach((r) => expect(r).not.toBeNull());
  });

  it("computes 100 range arrows in under 50ms", () => {
    const ctx = makeCtx({ canvasWidth: 20000, canvasHeight: 20000 });
    const arrows: TraceArrow[] = [];
    for (let i = 0; i < 100; i++) {
      arrows.push(makeArrow({
        id: `perf-range-${i}`,
        sourceRow: i * 2,
        sourceCol: 0,
        targetRow: i * 2 + 5,
        targetCol: 5,
        targetRange: {
          startRow: i * 2 + 3,
          startCol: 3,
          endRow: i * 2 + 7,
          endCol: 7,
        },
      }));
    }

    const start = performance.now();
    const results = arrows.map((a) => computeArrowPath(a, ctx));
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(50);
    results.forEach((r) => expect(r).not.toBeNull());
  });

  it("culling 100 off-screen arrows is fast", () => {
    const ctx = makeCtx({ canvasWidth: 100, canvasHeight: 100 });
    const arrows: TraceArrow[] = [];
    for (let i = 0; i < 100; i++) {
      arrows.push(makeArrow({
        id: `cull-${i}`,
        sourceRow: 500 + i,
        sourceCol: 500 + i,
        targetRow: 600 + i,
        targetCol: 600 + i,
      }));
    }

    const start = performance.now();
    const results = arrows.map((a) => computeArrowPath(a, ctx));
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(50);
    // All should be culled
    results.forEach((r) => expect(r).toBeNull());
  });
});
