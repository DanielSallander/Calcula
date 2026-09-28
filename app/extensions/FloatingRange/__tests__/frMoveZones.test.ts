//! FILENAME: app/extensions/FloatingRange/__tests__/frMoveZones.test.ts
// PURPOSE: Which part of a floating range MOVES it, which part RESIZES it, and
//          which part is the working surface -- the zone router Core consults
//          on every press (`claimsBodyDrag`), the cursor that must agree with
//          it (`getFrCursor`), the extended hit area of the edge balls, the
//          edge-scale's page clamp and the corner count-resize's fit.
// CONTEXT: Owner finding 2026-09-27: "a floating grid cannot be moved" -- the
//          title bar showed a move cursor and the drag did nothing outside
//          Design Mode. The fix makes the title bar (and, with no title, a 4px
//          border band) a move handle in every mode, while the CELLS stay the
//          working surface; the tests below are what keeps those two apart.
//
//          Core hands the claim the region it captured BEFORE the press
//          selected the range, so `data.resizable` there says whether the
//          handles were live when the press began. The tests build that region
//          by hand, exactly as Core would.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const editorCell = vi.fn((): { frId: string; row: number; col: number } | null => null);
const commitFrEditor = vi.fn(async (_move: unknown) => {});

vi.mock("../editor/frEditor", () => ({
  openFrEditor: vi.fn(),
  cancelFrEditor: vi.fn(),
  // The real commit tears the editor down SYNCHRONOUSLY before its first
  // await, so the double does too: a gate read after the commit would see a
  // closed editor.
  commitFrEditor: (move: unknown) => {
    editorCell.mockReturnValue(null);
    return commitFrEditor(move);
  },
  getFrEditorCell: () => editorCell(),
  getFrEditorSession: vi.fn(() => null),
  isFrEditorOpen: () => editorCell() !== null,
  destroyFrEditor: vi.fn(),
  layoutFrEditorForFrame: vi.fn(),
}));

vi.mock("@api/editing", () => ({
  isGlobalFormulaMode: () => false,
  getGlobalIsEditing: () => false,
  insertTextIntoActiveFormula: vi.fn(),
  getExternalFormulaTarget: () => null,
}));

// The edge drag converts window mouse events with the canvas layer's rect;
// here client coordinates ARE canvas coordinates.
vi.mock("../lib/frCanvasGeometry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/frCanvasGeometry")>()),
  clientToCanvas: (x: number, y: number) => ({ x, y }),
}));

const updateFloatingRange = vi.fn(async (_id: string, _patch: Record<string, unknown>) => INFO);

vi.mock("@api/floatingRanges", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/floatingRanges")>()),
  updateFloatingRange: (id: string, patch: Record<string, unknown>) => updateFloatingRange(id, patch),
}));

import { claimsBodyDrag, quantizeCornerResize, resizeFr } from "../index";
import {
  upsertFromInfo,
  resetFloatingRangeStore,
  getFloatingRangeById,
  FLOATING_RANGE_REGION_TYPE,
} from "../lib/floatingRangeStore";
import { selectFloatingRange, resetFrSelection, clearLocalSelection } from "../lib/frSelection";
import { frameWidth, frameHeight, FR_ROW_HDR_W, FR_DEFAULT_COL_W } from "../lib/frDimensions";
import { getFrCursor, hitTestFloatingRange } from "../rendering/frRenderer";
import { registerLayoutSurfaceProvider, type LayoutSurface } from "@api/layoutSurface";
import type { FloatingRangeInfo } from "@api/floatingRanges";
import type { GridRegion, OverlayHitTestContext } from "@api/gridOverlays";

const FR_ID = "fr-uuid-1";

const INFO: FloatingRangeInfo = {
  id: FR_ID,
  backingSheetId: "backing",
  hostSheetId: "host",
  x: 100,
  y: 100,
  rotation: 0,
  pinToGrid: false,
  rowCount: 4,
  colCount: 3,
  colWidths: {},
  rowHeights: {},
  showTitle: true,
  showColumnHeaders: true,
  showRowHeaders: true,
  name: "Float1",
  backingSheetIndex: 1,
  hostSheetIndex: 0,
} as FloatingRangeInfo;

/** Where the frame's top-left sits on the canvas in these tests. */
const ORIGIN = { x: 150, y: 120 };

function load(over: Partial<FloatingRangeInfo> = {}): void {
  upsertFromInfo({ ...INFO, ...over });
}

/** The region Core would hand the claim, with the flags the store published. */
function ctxAt(dx: number, dy: number, flags: Record<string, unknown>): OverlayHitTestContext {
  const entry = getFloatingRangeById(FR_ID)!;
  const width = frameWidth(entry);
  const height = frameHeight(entry);
  const region: GridRegion = {
    id: "fr-" + FR_ID,
    type: FLOATING_RANGE_REGION_TYPE,
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    floating: { x: entry.x, y: entry.y, width, height },
    data: { frId: FR_ID, ...flags },
  };
  return {
    region,
    canvasX: ORIGIN.x + dx,
    canvasY: ORIGIN.y + dy,
    row: 0,
    col: 0,
    floatingCanvasBounds: { x: ORIGIN.x, y: ORIGIN.y, width, height },
  };
}

/** Flags of a range on an editable sheet, unselected, Design Mode off. */
const FREE = { movable: true, resizable: false, bodyGrab: false };
/** ...and SELECTED before the press. */
const SELECTED = { movable: true, resizable: true, bodyGrab: false };
/** A subscribed canvas / a locked range. */
const FROZEN = { movable: false, resizable: false, bodyGrab: false };

/** Centre of local cell (0,0) with every strip shown: past the 28px gutter and 36px of chrome. */
const CELL_00 = { dx: 28 + 30, dy: 20 + 16 + 10 };

function mouse(type: "mousemove" | "mouseup", x: number, y: number): void {
  window.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y }));
}

let unregisterSurface: (() => void) | null = null;

function surfaceWithPage(page: { width: number; height: number }): void {
  const surface: LayoutSurface = {
    snapToGrid: false,
    gridSize: 16,
    showGrid: false,
    page,
    editable: true,
  };
  unregisterSurface = registerLayoutSurfaceProvider({ get: (i) => (i === 0 ? surface : null) });
}

beforeEach(() => {
  editorCell.mockReturnValue(null);
  commitFrEditor.mockClear();
  updateFloatingRange.mockClear();
  resetFloatingRangeStore();
  resetFrSelection();
  clearLocalSelection();
  load();
});

afterEach(() => {
  // End any edge drag a test left installed.
  mouse("mouseup", 0, 0);
  unregisterSurface?.();
  unregisterSurface = null;
  resetFloatingRangeStore();
  resetFrSelection();
});

// ============================================================================
// The zone router
// ============================================================================

describe("claimsBodyDrag: the frame moves, the cells work", () => {
  it("with a title bar, a TITLE press is handed to Core's move; a cell press stays the range's", () => {
    expect(claimsBodyDrag(ctxAt(40, 8, FREE))).toBe(false);
    expect(claimsBodyDrag(ctxAt(CELL_00.dx, CELL_00.dy, FREE))).toBe(true);
  });

  it("with NO title bar and Design Mode OFF, a cell press is still the range's (the naive-fix guard)", () => {
    // Publishing `movable: true` outside Design Mode is the fix; reading
    // `movable` as "the body is the handle" would make every title-less range
    // on a canvas an object whose cells can no longer be selected or edited.
    load({ showTitle: false });
    expect(claimsBodyDrag(ctxAt(CELL_00.dx, 16 + 10, FREE))).toBe(true);
  });

  it("with NO title bar in Design Mode (bodyGrab), the whole body moves", () => {
    load({ showTitle: false });
    expect(claimsBodyDrag(ctxAt(CELL_00.dx, 16 + 10, { ...FREE, bodyGrab: true }))).toBe(false);
  });

  it("with NO title bar, the 4px border band moves the range -- when it may move", () => {
    load({ showTitle: false });
    const h = frameHeight(getFloatingRangeById(FR_ID)!);
    expect(claimsBodyDrag(ctxAt(2, h / 2, FREE))).toBe(false);
    expect(claimsBodyDrag(ctxAt(10, h / 2, FREE))).toBe(true);
    // On a subscribed canvas or a locked range the band is just the edge cells.
    expect(claimsBodyDrag(ctxAt(2, h / 2, FROZEN))).toBe(true);
  });

  it("a border-band press COMMITS an open edit even over the edited cell (it is a frame press)", () => {
    load({ showTitle: false, showRowHeaders: false });
    const h = frameHeight(getFloatingRangeById(FR_ID)!);
    // Row 3 is under (2, h - 10); the editor is open on it.
    editorCell.mockReturnValue({ frId: FR_ID, row: 3, col: 0 });
    expect(claimsBodyDrag(ctxAt(2, h - 10, FREE))).toBe(false);
    expect(commitFrEditor).toHaveBeenCalledWith(null);
  });
});

// ============================================================================
// Edge balls: only on a range selected BEFORE the press, never while editing
// ============================================================================

describe("edge-handle cell scaling", () => {
  /** Press the right-edge ball and drag it `by` px to the right. */
  function dragRightBall(flags: Record<string, unknown>, by: number): number {
    const entry = getFloatingRangeById(FR_ID)!;
    const w = frameWidth(entry);
    const h = frameHeight(entry);
    const ctx = ctxAt(w, h / 2, flags);
    // Core dispatches floatingObject:selected BEFORE it asks the claim, and
    // the FR selects the range synchronously there -- so AT CLAIM TIME the
    // range is always selected. Only the pre-press region can tell.
    selectFloatingRange(FR_ID);
    claimsBodyDrag(ctx);
    mouse("mousemove", ctx.canvasX + by, ctx.canvasY);
    return frameWidth(getFloatingRangeById(FR_ID)!);
  }

  it("scales the cells of a range that was selected before the press (the harness can see a scale)", () => {
    const before = frameWidth(getFloatingRangeById(FR_ID)!);
    expect(dragRightBall(SELECTED, 60)).toBeGreaterThan(before + 40);
  });

  it("does NOT scale on the press that selects the range", () => {
    const before = frameWidth(getFloatingRangeById(FR_ID)!);
    expect(dragRightBall(FREE, 60)).toBe(before);
  });

  it("does NOT scale while the range's own cell editor is open", () => {
    editorCell.mockReturnValue({ frId: FR_ID, row: 0, col: 0 });
    const before = frameWidth(getFloatingRangeById(FR_ID)!);
    expect(dragRightBall(SELECTED, 60)).toBe(before);
  });

  it("stops the dragged edge at the canvas PAGE border", () => {
    surfaceWithPage({ width: 600, height: 400 });
    const w0 = frameWidth(getFloatingRangeById(FR_ID)!);
    load({ x: 600 - w0 - 20 }); // 20px of room to the right
    const entry = getFloatingRangeById(FR_ID)!;
    dragRightBall(SELECTED, 200);
    const live = getFloatingRangeById(FR_ID)!;
    const right = live.x + frameWidth(live);
    expect(right).toBeLessThanOrEqual(600);
    expect(right).toBeGreaterThan(600 - 2); // it grew right up to the page
    expect(live.x).toBe(entry.x);
  });

  it("a CLICK on a ball (1px of jitter) is not a resize: no scale, no write -- a real drag writes once", async () => {
    // Review 2026-09-27: the balls sit over the edge cells of every selected
    // range in every mode, and a 1px wobble while clicking such a cell
    // rescaled every column by a fraction of a pixel and recorded "Resize
    // floating range cells". Core's 3px move threshold, on the dragged axis.
    const flush = async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    };
    const entry = getFloatingRangeById(FR_ID)!;
    const w = frameWidth(entry);
    const h = frameHeight(entry);
    // Just INSIDE the frame: the ball's hit circle over the last column's cell.
    const click = ctxAt(w - 2, h / 2, SELECTED);
    selectFloatingRange(FR_ID);
    expect(claimsBodyDrag(click)).toBe(true);
    mouse("mousemove", click.canvasX + 1, click.canvasY);
    expect(frameWidth(getFloatingRangeById(FR_ID)!)).toBe(w);
    mouse("mouseup", click.canvasX + 1, click.canvasY);
    await flush();
    expect(updateFloatingRange).not.toHaveBeenCalled();

    // Control: past the threshold it is a drag, measured from the PRESS point.
    const drag = ctxAt(w, h / 2, SELECTED);
    selectFloatingRange(FR_ID);
    expect(claimsBodyDrag(drag)).toBe(true);
    mouse("mousemove", drag.canvasX + 30, drag.canvasY);
    expect(frameWidth(getFloatingRangeById(FR_ID)!)).toBeGreaterThan(w + 20);
    mouse("mouseup", drag.canvasX + 30, drag.canvasY);
    await flush();
    expect(updateFloatingRange).toHaveBeenCalledTimes(1);
  });

  it("a LEFT-edge drag past the sheet origin keeps the right edge where it was", () => {
    load({ x: 10 });
    const entry = getFloatingRangeById(FR_ID)!;
    const w0 = frameWidth(entry);
    const h = frameHeight(entry);
    const ctx = ctxAt(0, h / 2, SELECTED);
    selectFloatingRange(FR_ID);
    claimsBodyDrag(ctx);
    mouse("mousemove", ctx.canvasX - 200, ctx.canvasY);
    const live = getFloatingRangeById(FR_ID)!;
    expect(live.x).toBeGreaterThanOrEqual(0);
    expect(live.x + frameWidth(live)).toBeCloseTo(10 + w0, 1);
  });
});

// ============================================================================
// Cursor + extended hit area (in lockstep with the claim)
// ============================================================================

describe("getFrCursor / hitTestFloatingRange", () => {
  it("the title band says 'move' only when the range will move", () => {
    expect(getFrCursor(ctxAt(40, 8, FREE))).toBe("move");
    // The owner saw a move cursor and the drag did nothing: never again.
    expect(getFrCursor(ctxAt(40, 8, FROZEN))).toBe("pointer");
    expect(getFrCursor(ctxAt(CELL_00.dx, CELL_00.dy, FREE))).toBe("cell");
  });

  it("with no title: the border band and Design Mode's body grab say 'move', the cells 'cell'", () => {
    load({ showTitle: false });
    const h = frameHeight(getFloatingRangeById(FR_ID)!);
    expect(getFrCursor(ctxAt(2, h / 2, FREE))).toBe("move");
    expect(getFrCursor(ctxAt(2, h / 2, FROZEN))).toBe("cell");
    expect(getFrCursor(ctxAt(CELL_00.dx, 16 + 10, FREE))).toBe("cell");
    expect(getFrCursor(ctxAt(CELL_00.dx, 16 + 10, { ...FREE, bodyGrab: true }))).toBe("move");
  });

  it("the edge ball reaches past the frame only while the handles are live", () => {
    const entry = getFloatingRangeById(FR_ID)!;
    const w = frameWidth(entry);
    const h = frameHeight(entry);
    // 3px OUTSIDE the right edge, at the ball's height.
    expect(hitTestFloatingRange(ctxAt(w + 3, h / 2, SELECTED))).toBe(true);
    expect(hitTestFloatingRange(ctxAt(w + 3, h / 2, FREE))).toBe(false);
    editorCell.mockReturnValue({ frId: FR_ID, row: 0, col: 0 });
    expect(hitTestFloatingRange(ctxAt(w + 3, h / 2, SELECTED))).toBe(false);
  });
});

// ============================================================================
// The shared SIZE door refuses what the one per-range answer refuses
// ============================================================================

describe("resizeFr (menu, corner count-resize, script provider)", () => {
  function canvasThat(over: Partial<LayoutSurface>): void {
    const surface: LayoutSurface = {
      snapToGrid: false,
      gridSize: 16,
      showGrid: false,
      page: { width: 1280, height: 720 },
      editable: true,
      ...over,
    };
    unregisterSurface = registerLayoutSurfaceProvider({ get: (i) => (i === 0 ? surface : null) });
  }

  it("refuses a range its canvas LOCKS, saying so, and writes nothing", async () => {
    canvasThat({ isLocked: (r: GridRegion) => r.data?.frId === FR_ID });
    await expect(resizeFr(FR_ID, 5, 5)).rejects.toThrow(/locked/);
    expect(updateFloatingRange).not.toHaveBeenCalled();
  });

  it("refuses a range on a SUBSCRIBED canvas, naming the remedy, and writes nothing", async () => {
    canvasThat({ editable: false });
    await expect(resizeFr(FR_ID, 5, 5)).rejects.toThrow(/detached/);
    expect(updateFloatingRange).not.toHaveBeenCalled();
  });

  it("control: an editable canvas's range is resized", async () => {
    canvasThat({});
    await resizeFr(FR_ID, 5, 4);
    expect(updateFloatingRange).toHaveBeenCalledWith(FR_ID, { rowCount: 5, colCount: 4 });
  });
});

// ============================================================================
// Corner count-resize: the nearest count must not overshoot a clamp
// ============================================================================

describe("quantizeCornerResize", () => {
  it("does not round a page-clamped bottom-right drag PAST the page", () => {
    surfaceWithPage({ width: 600, height: 400 });
    const w0 = frameWidth(getFloatingRangeById(FR_ID)!);
    // 40px of room: more than half a 64.29px column, so NEAREST rounds up to
    // a 4th column the page cannot hold.
    load({ x: 600 - w0 - 40 });
    const entry = getFloatingRangeById(FR_ID)!;
    const q = quantizeCornerResize(entry, {
      x: entry.x,
      y: entry.y,
      width: 600 - entry.x, // Core clamped the dragged edge to the page
      height: frameHeight(entry),
    });
    expect(q.cols).toBe(3);
    expect(q.x + q.width).toBeLessThanOrEqual(600);
  });

  it("does not round a left drag stopped at the sheet origin into moving the FIXED right edge", () => {
    load({ x: 40 });
    const entry = getFloatingRangeById(FR_ID)!;
    const right = entry.x + frameWidth(entry);
    const q = quantizeCornerResize(entry, {
      x: 0,
      y: entry.y,
      width: right, // dragged all the way to x = 0
      height: frameHeight(entry),
    });
    expect(q.x + q.width).toBeCloseTo(right, 6);
    expect(q.x).toBeGreaterThanOrEqual(0);
  });

  it("an unclamped drag still picks the NEAREST count", () => {
    const entry = getFloatingRangeById(FR_ID)!;
    const q = quantizeCornerResize(entry, {
      x: entry.x,
      y: entry.y,
      width: FR_ROW_HDR_W + 3.6 * FR_DEFAULT_COL_W,
      height: frameHeight(entry),
    });
    expect(q.cols).toBe(4);
  });
});
