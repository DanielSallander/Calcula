//! FILENAME: app/extensions/FloatingRange/__tests__/frMoveZones.test.ts
// PURPOSE: Which part of a floating range MOVES it, which part RESIZES it, and
//          which part is the working surface -- what a press there does (move,
//          select, the range's own cell work, a reference pick, an edge-ball
//          scale, the commit of an open edit), the pointer that must agree with
//          it, the extended hit area of the edge balls, the edge-scale's page
//          clamp and the corner count-resize's fit.
// CONTEXT: Owner finding 2026-09-27: "a floating grid cannot be moved" -- the
//          title bar showed a move cursor and the drag did nothing outside
//          Design Mode. The fix makes the title bar (and, with no title, a 4px
//          border band) a move handle in every mode, while the CELLS stay the
//          working surface; the tests below are what keeps those two apart.
//
//          EVERY PRESS GOES THROUGH ONE HELPER (helpers/frPress.ts), which
//          mirrors Core's press order against the ACTIVATED extension, so the
//          range's own floatingObject:* handlers run exactly as they do live.
//          These pins were written green on the legacy router (M5 T5a) and the
//          zone migration (T5b: one PURE `frZoneAt` answer, decided before the
//          press selects anything) changed only that helper's body -- and one
//          expectation, the frozen title's pointer, marked where it stands.
//
//          Core hands the press the region it captured BEFORE the press
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

/**
 * What the formula editors say. `grid`: the grid's own editor is in point
 * mode. `external`: an external target (the range's cell editor, the formula
 * bar) that EXPECTS a reference until one is inserted -- "=SUM(" plus a pick is
 * "=SUM(Float1!B1", which expects none, exactly as the real text does.
 */
const formula = vi.hoisted(() => ({
  grid: false,
  external: null as null | { expecting: boolean },
  insertReference: null as null | ((ref: unknown) => void),
  insertText: null as null | ((text: string) => void),
}));

vi.mock("@api/editing", () => ({
  isGlobalFormulaMode: () => formula.grid,
  getGlobalIsEditing: () => false,
  insertTextIntoActiveFormula: (text: string) => formula.insertText?.(text),
  getExternalFormulaTarget: () => {
    const ext = formula.external;
    if (!ext) return null;
    return {
      isExpectingReference: () => ext.expecting,
      insertReference: (ref: unknown) => {
        formula.insertReference?.(ref);
        ext.expecting = false;
      },
    };
  },
}));

/** Where the frame's top-left sits on the canvas in these tests. */
const ORIGIN = vi.hoisted(() => ({ x: 150, y: 120 }));

// The range's own mouse paths find the frame on the canvas without Core; here
// it sits at ORIGIN and client coordinates ARE canvas coordinates.
vi.mock("../lib/frCanvasGeometry", async (importOriginal) => {
  const dims = await import("../lib/frDimensions");
  return {
    ...(await importOriginal<typeof import("../lib/frCanvasGeometry")>()),
    clientToCanvas: (x: number, y: number) => ({ x, y }),
    frameCanvasBounds: (entry: import("../lib/floatingRangeStore").FloatingRangeEntry) => ({
      x: ORIGIN.x,
      y: ORIGIN.y,
      width: dims.frameWidth(entry),
      height: dims.frameHeight(entry),
    }),
  };
});

const updateFloatingRange = vi.fn(async (_id: string, _patch: Record<string, unknown>) => INFO);

vi.mock("@api/floatingRanges", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/floatingRanges")>()),
  updateFloatingRange: (id: string, patch: Record<string, unknown>) => updateFloatingRange(id, patch),
  // The startup load: the tests stand their range up by hand afterwards.
  listFloatingRanges: async () => [],
  getFloatingRangeCells: async () => [],
}));

vi.mock("@api/lib", () => ({
  getActiveSheet: async () => 0,
  getUsedRange: async () => ({ startRow: 0, startCol: 0, endRow: 0, endCol: 0, empty: true }),
}));

import extension, { quantizeCornerResize, resizeFr, frZoneAt } from "../index";
import {
  upsertFromInfo,
  getFloatingRangeById,
  FLOATING_RANGE_REGION_TYPE,
} from "../lib/floatingRangeStore";
import {
  resetFrSelection,
  getLocalSelection,
  setLocalSelection,
  isFloatingRangeSelected,
} from "../lib/frSelection";
import {
  frameWidth,
  frameHeight,
  FR_ROW_HDR_W,
  FR_DEFAULT_COL_W,
  FR_DEFAULT_ROW_H,
  FR_TITLE_H,
  FR_COL_HDR_H,
} from "../lib/frDimensions";
import { hitTestFloatingRange } from "../rendering/frRenderer";
import { recordFrUsedExtent, resetFrExtents } from "../lib/frExtent";
import { buildQualifiedRef } from "../lib/frRefs";
import { registerLayoutSurfaceProvider, type LayoutSurface } from "@api/layoutSurface";
import { registerGridOverlay, getOverlayRegistration } from "@api/gridOverlays";
import { onAppEvent } from "@api/events";
import type { FloatingRangeInfo } from "@api/floatingRanges";
import type { GridRegion, OverlayHitTestContext, OverlayRegistration } from "@api/gridOverlays";
import { pressInCoreOrder, clickInCoreOrder, hoverCursorLikeCore } from "./helpers/frPress";

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

function load(over: Partial<FloatingRangeInfo> = {}): void {
  upsertFromInfo({ ...INFO, ...over });
}

/** The region Core would hand the press, with the flags the store published. */
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

/** Frame-relative centre of local cell (row, col), every strip shown, unscrolled. */
function cellCentre(row: number, col: number): { dx: number; dy: number } {
  return {
    dx: FR_ROW_HDR_W + col * FR_DEFAULT_COL_W + FR_DEFAULT_COL_W / 2,
    dy: FR_TITLE_H + FR_COL_HDR_H + row * FR_DEFAULT_ROW_H + FR_DEFAULT_ROW_H / 2,
  };
}

function mouse(type: "mousemove" | "mouseup", x: number, y: number): void {
  window.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y }));
}

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
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

/** The activation context: the overlay goes into the REAL registry, where Core (and the helper) find it. */
function stubContext(): never {
  return {
    grid: { overlays: { register: (registration: OverlayRegistration) => registerGridOverlay(registration) } },
    ui: {
      menus: { registerItem: vi.fn(), unregisterItem: vi.fn() },
      overlays: { register: vi.fn(), unregister: vi.fn() },
      dialogs: { register: vi.fn(), unregister: vi.fn() },
    },
    events: { on: (name: string, cb: (detail: unknown) => void) => onAppEvent(name, cb) },
  } as never;
}

const insertReference = vi.fn();
const insertTextIntoActiveFormula = vi.fn();

beforeEach(async () => {
  editorCell.mockReturnValue(null);
  commitFrEditor.mockReset();
  commitFrEditor.mockImplementation(async () => {});
  updateFloatingRange.mockClear();
  insertReference.mockClear();
  insertTextIntoActiveFormula.mockClear();
  formula.grid = false;
  formula.external = null;
  formula.insertReference = insertReference;
  formula.insertText = insertTextIntoActiveFormula;
  resetFrExtents();
  extension.activate(stubContext());
  // The startup load (an empty backend) lands before the range is stood up.
  await flush();
  resetFrSelection();
  load();
});

afterEach(() => {
  // End any drag a test left installed.
  mouse("mouseup", 0, 0);
  extension.deactivate?.();
  unregisterSurface?.();
  unregisterSurface = null;
});

// ============================================================================
// The press: the frame moves, the cells work
// ============================================================================

describe("a press: the frame moves, the cells work", () => {
  it("with a title bar, a TITLE press is Core's move; a cell press stays the range's", () => {
    expect(clickInCoreOrder(ctxAt(40, 8, FREE))).toBe("move");
    expect(clickInCoreOrder(ctxAt(CELL_00.dx, CELL_00.dy, FREE))).toBe("content");
  });

  it("with NO title bar and Design Mode OFF, a cell press is still the range's (the naive-fix guard)", () => {
    // Publishing `movable: true` outside Design Mode is the fix; reading
    // `movable` as "the body is the handle" would make every title-less range
    // on a canvas an object whose cells can no longer be selected or edited.
    load({ showTitle: false });
    expect(clickInCoreOrder(ctxAt(CELL_00.dx, 16 + 10, FREE))).toBe("content");
  });

  it("with NO title bar in Design Mode (bodyGrab), the whole body moves", () => {
    load({ showTitle: false });
    expect(clickInCoreOrder(ctxAt(CELL_00.dx, 16 + 10, { ...FREE, bodyGrab: true }))).toBe("move");
  });

  it("with NO title bar, the 4px border band moves the range -- when it may move", () => {
    load({ showTitle: false });
    const h = frameHeight(getFloatingRangeById(FR_ID)!);
    expect(clickInCoreOrder(ctxAt(2, h / 2, FREE))).toBe("move");
    expect(clickInCoreOrder(ctxAt(10, h / 2, FREE))).toBe("content");
    // On a subscribed canvas or a locked range the band is just the edge cells.
    expect(clickInCoreOrder(ctxAt(2, h / 2, FROZEN))).toBe("content");
  });

  it("a FROZEN title press selects the range and nothing moves it", () => {
    expect(clickInCoreOrder(ctxAt(40, 8, FROZEN))).toBe("select");
    expect(isFloatingRangeSelected(FR_ID)).toBe(true);
  });

  it("a cell press selects the OBJECT and that CELL", () => {
    const c = cellCentre(1, 1);
    expect(clickInCoreOrder(ctxAt(c.dx, c.dy, FREE))).toBe("content");
    expect(isFloatingRangeSelected(FR_ID)).toBe(true);
    expect(getLocalSelection()).toMatchObject({ frId: FR_ID, anchorRow: 1, anchorCol: 1, endRow: 1, endCol: 1 });
  });

  it("a ROW-header press selects that whole row, a COLUMN-header press that whole column", () => {
    // Row 2's gutter, then column B's letter strip.
    expect(clickInCoreOrder(ctxAt(FR_ROW_HDR_W / 2, cellCentre(2, 0).dy, FREE))).toBe("content");
    expect(getLocalSelection()).toMatchObject({ frId: FR_ID, anchorRow: 2, anchorCol: 0, endRow: 2, endCol: 2 });
    expect(clickInCoreOrder(ctxAt(cellCentre(0, 1).dx, FR_TITLE_H + FR_COL_HDR_H / 2, FREE))).toBe("content");
    expect(getLocalSelection()).toMatchObject({ frId: FR_ID, anchorRow: 0, anchorCol: 1, endRow: 3, endCol: 1 });
  });
});

// ============================================================================
// Commit before select: a frame press commits, a cell press commits unless it
// is the cell being edited
// ============================================================================

describe("an open cell edit and the press that leaves it", () => {
  function editing(row: number, col: number): void {
    setLocalSelection({ frId: FR_ID, anchorRow: row, anchorCol: col, endRow: row, endCol: col });
    editorCell.mockReturnValue({ frId: FR_ID, row, col });
  }

  it("a TITLE press commits the edit (a frame press has no target cell) and still moves", () => {
    editing(0, 0);
    expect(clickInCoreOrder(ctxAt(40, 8, FREE))).toBe("move");
    expect(commitFrEditor).toHaveBeenCalledTimes(1);
    expect(commitFrEditor).toHaveBeenCalledWith(null);
  });

  it("a border-band press COMMITS an open edit even over the edited cell (it is a frame press)", () => {
    load({ showTitle: false, showRowHeaders: false });
    const h = frameHeight(getFloatingRangeById(FR_ID)!);
    // Row 3 is under (2, h - 10); the editor is open on it.
    editing(3, 0);
    expect(clickInCoreOrder(ctxAt(2, h - 10, FREE))).toBe("move");
    expect(commitFrEditor).toHaveBeenCalledWith(null);
  });

  it("a press ON the edited cell commits nothing (the user is placing the caret) and keeps the cell", () => {
    editing(0, 0);
    expect(clickInCoreOrder(ctxAt(CELL_00.dx, CELL_00.dy, FREE))).toBe("content");
    expect(commitFrEditor).not.toHaveBeenCalled();
    expect(getLocalSelection()).toMatchObject({ anchorRow: 0, anchorCol: 0 });
  });

  it("a press on ANOTHER cell commits BEFORE the cell selection moves (click-away), then selects it", () => {
    editing(0, 0);
    let selectionAtCommit: unknown = "never committed";
    commitFrEditor.mockImplementation(async () => {
      selectionAtCommit = getLocalSelection();
    });
    const c = cellCentre(1, 1);
    expect(clickInCoreOrder(ctxAt(c.dx, c.dy, FREE))).toBe("content");
    expect(commitFrEditor).toHaveBeenCalledTimes(1);
    expect(selectionAtCommit).toMatchObject({ anchorRow: 0, anchorCol: 0 });
    expect(getLocalSelection()).toMatchObject({ anchorRow: 1, anchorCol: 1 });
  });

  it("Design Mode's body grab (no title) is a frame press: it commits even over the edited cell", () => {
    // M5 T5b: the commit's target is the part decided before the press, and
    // only a CELL press names a cell. The legacy router named the cell under
    // a body-grab press too, so an edit stayed open while its range was
    // dragged away; a frame press is a click-away like the title's and the
    // border band's.
    load({ showTitle: false });
    editing(0, 0);
    expect(clickInCoreOrder(ctxAt(CELL_00.dx, 16 + 10, { ...FREE, bodyGrab: true }))).toBe("move");
    expect(commitFrEditor).toHaveBeenCalledTimes(1);
  });

  it("a ROW-header press commits too (a header is not the edited cell)", () => {
    // The row selection keeps the edited cell as its anchor, so only the
    // press's own commit can be the one heard here.
    editing(1, 0);
    expect(clickInCoreOrder(ctxAt(FR_ROW_HDR_W / 2, cellCentre(1, 0).dy, FREE))).toBe("content");
    expect(commitFrEditor).toHaveBeenCalledTimes(1);
    expect(getLocalSelection()).toMatchObject({ anchorRow: 1, anchorCol: 0, endRow: 1, endCol: 2 });
  });
});

// ============================================================================
// A reference pick: the press FEEDS a formula, once, and selects nothing
// ============================================================================

describe("a reference pick (a formula expects a reference)", () => {
  const PRIOR = { frId: FR_ID, anchorRow: 2, anchorCol: 2, endRow: 2, endCol: 2 };

  it("over a cell: the reference is inserted EXACTLY once; the object is not selected, the cell selection does not move", () => {
    formula.external = { expecting: true };
    setLocalSelection({ ...PRIOR });
    const c = cellCentre(0, 1);
    expect(clickInCoreOrder(ctxAt(c.dx, c.dy, FREE))).toBe("content");
    expect(insertReference).toHaveBeenCalledTimes(1);
    expect(insertReference).toHaveBeenCalledWith({
      sheetName: "Float1",
      startRow: 0,
      startCol: 1,
      endRow: 0,
      endCol: 1,
    });
    expect(isFloatingRangeSelected(FR_ID)).toBe(false);
    expect(getLocalSelection()).toMatchObject(PRIOR);
    expect(commitFrEditor).not.toHaveBeenCalled();
  });

  it("over the TITLE: nothing is inserted, and the press neither selects nor moves the object", () => {
    formula.external = { expecting: true };
    setLocalSelection({ ...PRIOR });
    expect(clickInCoreOrder(ctxAt(40, 8, FREE))).toBe("content");
    expect(insertReference).not.toHaveBeenCalled();
    expect(isFloatingRangeSelected(FR_ID)).toBe(false);
    expect(getLocalSelection()).toMatchObject(PRIOR);
  });

  it("the grid's own formula: the qualified reference is typed EXACTLY once", () => {
    formula.grid = true;
    const c = cellCentre(1, 0);
    expect(clickInCoreOrder(ctxAt(c.dx, c.dy, FREE))).toBe("content");
    expect(insertTextIntoActiveFormula).toHaveBeenCalledTimes(1);
    expect(insertTextIntoActiveFormula).toHaveBeenCalledWith(buildQualifiedRef("Float1", 1, 0));
    expect(isFloatingRangeSelected(FR_ID)).toBe(false);
  });

  it("hovering first inserts nothing; the press inserts once", () => {
    formula.external = { expecting: true };
    const c = cellCentre(0, 1);
    const ctx = ctxAt(c.dx, c.dy, FREE);
    for (let i = 0; i < 25; i++) hoverCursorLikeCore(ctx);
    expect(insertReference).not.toHaveBeenCalled();
    pressInCoreOrder(ctx);
    expect(insertReference).toHaveBeenCalledTimes(1);
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
    // The press itself selects the range (floatingObject:selected), so by the
    // time the range decides what the press is FOR the range is always
    // selected: only the pre-press region can tell whether the balls were
    // live when the user pressed.
    pressInCoreOrder(ctx);
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

  it("does NOT scale while the range's own cell editor is open (the handles are read BEFORE the commit closes it)", () => {
    editorCell.mockReturnValue({ frId: FR_ID, row: 0, col: 0 });
    const before = frameWidth(getFloatingRangeById(FR_ID)!);
    expect(dragRightBall(SELECTED, 60)).toBe(before);
    // The press did commit the edit (it is not on the edited cell) -- which is
    // exactly why the handles must have been read before it.
    expect(commitFrEditor).toHaveBeenCalled();
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
    const entry = getFloatingRangeById(FR_ID)!;
    const w = frameWidth(entry);
    const h = frameHeight(entry);
    // Just INSIDE the frame: the ball's hit circle over the last column's cell.
    const click = ctxAt(w - 2, h / 2, SELECTED);
    expect(pressInCoreOrder(click)).toBe("content");
    mouse("mousemove", click.canvasX + 1, click.canvasY);
    expect(frameWidth(getFloatingRangeById(FR_ID)!)).toBe(w);
    mouse("mouseup", click.canvasX + 1, click.canvasY);
    await flush();
    expect(updateFloatingRange).not.toHaveBeenCalled();

    // Control: past the threshold it is a drag, measured from the PRESS point.
    const drag = ctxAt(w, h / 2, SELECTED);
    expect(pressInCoreOrder(drag)).toBe("content");
    mouse("mousemove", drag.canvasX + 30, drag.canvasY);
    expect(frameWidth(getFloatingRangeById(FR_ID)!)).toBeGreaterThan(w + 20);
    mouse("mouseup", drag.canvasX + 30, drag.canvasY);
    await flush();
    expect(updateFloatingRange).toHaveBeenCalledTimes(1);
  });

  it("a ball press moves no cell selection (the ball is not the cell under it)", () => {
    setLocalSelection({ frId: FR_ID, anchorRow: 0, anchorCol: 0, endRow: 0, endCol: 0 });
    const entry = getFloatingRangeById(FR_ID)!;
    const ctx = ctxAt(frameWidth(entry) - 2, frameHeight(entry) / 2, SELECTED);
    expect(pressInCoreOrder(ctx)).toBe("content");
    expect(getLocalSelection()).toMatchObject({ anchorRow: 0, anchorCol: 0, endRow: 0, endCol: 0 });
  });

  // E10 (d): the scale acted on the WINDOW plus existing overrides, so a
  // default-width column the content reaches past the window kept its width:
  // scrolled into view after a x1.5 scale it was visibly narrower than its
  // neighbours. Every column the user can scroll to is the object's to scale.
  it("scales every column the CONTENT reaches, not only the window's", () => {
    recordFrUsedExtent(FR_ID, 4, 6); // window 3 columns, content 6
    dragRightBall(SELECTED, 60);
    const live = getFloatingRangeById(FR_ID)!;
    const widths = live.colWidths as Record<number, number>;
    for (const c of [0, 1, 2, 3, 4, 5]) {
      expect(widths[c], `column ${c} kept its old width`).toBeGreaterThan(FR_DEFAULT_COL_W);
    }
    // One scale for all of them: the scrolled-to column matches the window's.
    expect(widths[5]).toBe(widths[0]);
  });

  // Review B (2026-09-28): the page cap leaves room for the 1/100 px rounding
  // of every size that MAKES THE FRAME -- the window's. E10 (d) handed it the
  // count of every size the scale writes (the whole content extent), so with
  // content far past the window the frame stopped pixels short of the page:
  // ~1.3 px over 256 columns, ~5 px over 1000 rows.
  it("with content far past the window, the dragged edge still stops AT the page border", () => {
    surfaceWithPage({ width: 600, height: 400 });
    const w0 = frameWidth(getFloatingRangeById(FR_ID)!);
    load({ x: 600 - w0 - 20 });
    recordFrUsedExtent(FR_ID, 4, 256); // window 3 columns, content 256
    dragRightBall(SELECTED, 200);
    const live = getFloatingRangeById(FR_ID)!;
    const right = live.x + frameWidth(live);
    expect(right).toBeLessThanOrEqual(600);
    expect(right, "the frame stopped short of the page").toBeGreaterThan(600 - 0.1);
  });

  it("the same for a BOTTOM-edge drag over 1000 content rows", () => {
    surfaceWithPage({ width: 600, height: 400 });
    const h0 = frameHeight(getFloatingRangeById(FR_ID)!);
    load({ y: 400 - h0 - 20 });
    recordFrUsedExtent(FR_ID, 1000, 3); // window 4 rows, content 1000
    const entry = getFloatingRangeById(FR_ID)!;
    const w = frameWidth(entry);
    const h = frameHeight(entry);
    const ctx = ctxAt(w / 2, h, SELECTED);
    pressInCoreOrder(ctx);
    mouse("mousemove", ctx.canvasX, ctx.canvasY + 200);
    const live = getFloatingRangeById(FR_ID)!;
    const bottom = live.y + frameHeight(live);
    expect(bottom).toBeLessThanOrEqual(400);
    expect(bottom, "the frame stopped short of the page").toBeGreaterThan(400 - 0.1);
  });

  it("a LEFT-edge drag past the sheet origin keeps the right edge where it was", () => {
    load({ x: 10 });
    const entry = getFloatingRangeById(FR_ID)!;
    const w0 = frameWidth(entry);
    const h = frameHeight(entry);
    const ctx = ctxAt(0, h / 2, SELECTED);
    pressInCoreOrder(ctx);
    mouse("mousemove", ctx.canvasX - 200, ctx.canvasY);
    const live = getFloatingRangeById(FR_ID)!;
    expect(live.x).toBeGreaterThanOrEqual(0);
    expect(live.x + frameWidth(live)).toBeCloseTo(10 + w0, 1);
  });

  it("a NEAR MISS outside the frame, within a ball's reach, is the range's and inert when its geometry is frozen", () => {
    // The region still says `resizable` (published before the canvas locked
    // the range), so the ball's extended hit area hands Core the press; the
    // range's own live geometry answer refuses the scale. Falling through
    // would start a move from outside the object.
    canvasThat({ isLocked: (r: GridRegion) => r.data?.frId === FR_ID });
    setLocalSelection({ frId: FR_ID, anchorRow: 0, anchorCol: 0, endRow: 0, endCol: 0 });
    const entry = getFloatingRangeById(FR_ID)!;
    const w = frameWidth(entry);
    const h = frameHeight(entry);
    const ctx = ctxAt(w + 3, h / 2, SELECTED);
    expect(hitTestFloatingRange(ctx)).toBe(true);
    expect(pressInCoreOrder(ctx)).toBe("content");
    mouse("mousemove", ctx.canvasX + 60, ctx.canvasY);
    expect(frameWidth(getFloatingRangeById(FR_ID)!)).toBe(w);
    expect(getLocalSelection()).toMatchObject({ anchorRow: 0, anchorCol: 0, endRow: 0, endCol: 0 });
    mouse("mouseup", ctx.canvasX + 60, ctx.canvasY);
    expect(updateFloatingRange).not.toHaveBeenCalled();
  });
});

// ============================================================================
// The pointer (in lockstep with the press) + the extended hit area
// ============================================================================

describe("the pointer over each zone, and the balls' extended hit area", () => {
  it("the title band says 'move' only when the range will move", () => {
    expect(hoverCursorLikeCore(ctxAt(40, 8, FREE))).toBe("move");
    // The owner saw a move cursor and the drag did nothing: never again.
    // DELIBERATE CHANGE (M5 T5b, the owner-approved zone rule in
    // resolveFloatingZone, BUG-0258): a frame that cannot move shows 'default'
    // -- Core's one answer for every family -- where the range's own cursor
    // used to say 'pointer'.
    expect(hoverCursorLikeCore(ctxAt(40, 8, FROZEN))).toBe("default");
    expect(hoverCursorLikeCore(ctxAt(CELL_00.dx, CELL_00.dy, FREE))).toBe("cell");
  });

  it("with no title: the border band and Design Mode's body grab say 'move', the cells 'cell'", () => {
    load({ showTitle: false });
    const h = frameHeight(getFloatingRangeById(FR_ID)!);
    expect(hoverCursorLikeCore(ctxAt(2, h / 2, FREE))).toBe("move");
    expect(hoverCursorLikeCore(ctxAt(2, h / 2, FROZEN))).toBe("cell");
    expect(hoverCursorLikeCore(ctxAt(CELL_00.dx, 16 + 10, FREE))).toBe("cell");
    expect(hoverCursorLikeCore(ctxAt(CELL_00.dx, 16 + 10, { ...FREE, bodyGrab: true }))).toBe("move");
  });

  it("a live ball says which way it scales; the same point on an unselected range is a cell", () => {
    const entry = getFloatingRangeById(FR_ID)!;
    const w = frameWidth(entry);
    const h = frameHeight(entry);
    expect(hoverCursorLikeCore(ctxAt(w - 2, h / 2, SELECTED))).toBe("ew-resize");
    expect(hoverCursorLikeCore(ctxAt(w / 2, h - 2, SELECTED))).toBe("ns-resize");
    expect(hoverCursorLikeCore(ctxAt(w - 2, h / 2, FREE))).toBe("cell");
  });

  it("while a formula picks, the whole range says 'cell' -- the title too (a press there picks, never moves)", () => {
    // M5 T5b, deliberate: the pointer is the zone the press will act on. The
    // range's own cursor used to show 'move' over the title in point mode,
    // where the press never moves the object.
    formula.external = { expecting: true };
    expect(hoverCursorLikeCore(ctxAt(40, 8, FREE))).toBe("cell");
    expect(hoverCursorLikeCore(ctxAt(CELL_00.dx, CELL_00.dy, FREE))).toBe("cell");
    formula.external = null;
    formula.grid = true;
    expect(hoverCursorLikeCore(ctxAt(40, 8, FREE))).toBe("cell");
  });

  it("a near miss on a range whose geometry is frozen never promises the scale its press refuses", () => {
    // The legacy cursor asked only whether the balls were published live and
    // said 'ew-resize' here, while the press refused the scale. One zone
    // answer drives both now.
    canvasThat({ isLocked: (r: GridRegion) => r.data?.frId === FR_ID });
    const entry = getFloatingRangeById(FR_ID)!;
    expect(hoverCursorLikeCore(ctxAt(frameWidth(entry) + 3, frameHeight(entry) / 2, SELECTED))).toBe("default");
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
// One answer: frZoneAt is registered alone, and it is PURE
// ============================================================================

describe("frZoneAt: the range's one zone answer", () => {
  it("is the registration's zoneAt, with no cursor or body-drag claim of its own beside it", () => {
    const registration = getOverlayRegistration(FLOATING_RANGE_REGION_TYPE) as unknown as Record<string, unknown>;
    expect(registration.zoneAt).toBe(frZoneAt);
    expect(registration.getCursor).toBeUndefined();
    expect(registration.getCellCursor).toBeUndefined();
    expect(registration.claimsBodyDrag).toBeUndefined();
  });

  it("is PURE: 1000 answers over cells, headers, title and live balls -- an edit open, then a formula picking -- commit nothing, insert nothing, start no drag, select nothing", () => {
    const entry = getFloatingRangeById(FR_ID)!;
    const w = frameWidth(entry);
    const h = frameHeight(entry);
    const PRIOR = { frId: FR_ID, anchorRow: 1, anchorCol: 1, endRow: 1, endCol: 1 };
    setLocalSelection({ ...PRIOR });

    /** Every point of a 25 x 20 lattice from 4px outside the frame to 4px past it, plus the four ball centres. */
    function sweep(flags: Record<string, unknown>): { parts: Set<string>; calls: number } {
      const parts = new Set<string>();
      let calls = 0;
      const ask = (dx: number, dy: number) => {
        const zone = frZoneAt(ctxAt(dx, dy, flags));
        calls++;
        if (zone?.part) parts.add(zone.part);
      };
      for (let i = 0; i <= 24; i++) {
        for (let j = 0; j <= 19; j++) ask(-4 + ((w + 8) * i) / 24, -4 + ((h + 8) * j) / 19);
      }
      for (const [dx, dy] of [[0, h / 2], [w, h / 2], [w / 2, 0], [w / 2, h]]) ask(dx, dy);
      return { parts, calls };
    }

    const listen = vi.spyOn(window, "addEventListener");
    try {
      // An edit open in ANOTHER range: this range's balls stay live, and a
      // commit-before-select run from the answer would be heard.
      editorCell.mockReturnValue({ frId: "fr-other", row: 0, col: 0 });
      const live = sweep(SELECTED);
      // Then a formula picking a reference: a pick run from the answer would insert.
      formula.external = { expecting: true };
      const picking = sweep(SELECTED);

      // The sweep reached every part (a guard that sees nothing proves nothing).
      expect(live.calls + picking.calls).toBeGreaterThanOrEqual(1000);
      for (const part of ["edgeHandle", "title", "cells", "rowHeader", "colHeader", "outside"]) {
        expect(live.parts, `the sweep never reached '${part}'`).toContain(part);
      }
      expect([...picking.parts]).toEqual(["referencePick"]);

      expect(commitFrEditor).not.toHaveBeenCalled();
      expect(editorCell()).toEqual({ frId: "fr-other", row: 0, col: 0 });
      expect(insertReference).not.toHaveBeenCalled();
      expect(insertTextIntoActiveFormula).not.toHaveBeenCalled();
      const dragListeners = listen.mock.calls.filter(([type]) => type === "mousemove" || type === "mouseup");
      expect(dragListeners, "an answer started a drag").toEqual([]);
      expect(frameWidth(getFloatingRangeById(FR_ID)!)).toBe(w);
      expect(getLocalSelection()).toMatchObject(PRIOR);
      expect(isFloatingRangeSelected(FR_ID)).toBe(false);
    } finally {
      listen.mockRestore();
    }
  });
});

// ============================================================================
// The shared SIZE door refuses what the one per-range answer refuses
// ============================================================================

describe("resizeFr (menu, corner count-resize, script provider)", () => {
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
