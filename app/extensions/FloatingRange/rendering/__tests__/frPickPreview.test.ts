//! FILENAME: app/extensions/FloatingRange/rendering/__tests__/frPickPreview.test.ts
// PURPOSE: The floating grid's half of a reference pick's drag preview (D-PICK)
//          and its share of the ONE inner-selection ink:
//          - while Core's pick session publishes a preview for THIS region, in
//            the object space under THIS range's name, the range paints the
//            covered cells dashed (`paintPickPreview`), in the scrolled cell
//            space and under the cell-viewport clip;
//          - a preview for another region, the sheet space or another name
//            paints nothing;
//          - `frPickPreviewCells` normalizes a reversed drag and clamps to the
//            extent the paint can index;
//          - the local selection paints in INNER_SELECTION_FILL /
//            INNER_SELECTION_BORDER (_shared/lib/innerSelectionPaint.ts), the
//            colours the canvas pivot's cell selection uses too.
// CONTEXT: The preview is Core's state (core/lib/referencePickState.ts), read
//          through @api/gridOverlays; an extension test may not import Core, so
//          the facade getter is doubled here with a hoisted slot.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FloatingRangeInfo } from "@api/floatingRanges";
import type { FloatingReferencePickPreview } from "@api/gridOverlays";

const pick = vi.hoisted(() => ({ preview: null as FloatingReferencePickPreview | null }));

vi.mock("@api/gridOverlays", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/gridOverlays")>()),
  getFloatingReferencePickPreview: () => pick.preview,
}));

vi.mock("@api/floatingRanges", () => ({
  FLOATING_RANGE_MAX_ROWS: 1000,
  FLOATING_RANGE_MAX_COLS: 256,
  listFloatingRanges: vi.fn(async () => []),
  updateFloatingRange: vi.fn(async () => ({})),
  getFloatingRangeCells: vi.fn(async () => []),
}));

vi.mock("@api/lib", () => ({
  getUsedRange: vi.fn(async () => ({ startRow: 0, startCol: 0, endRow: 0, endCol: 0, empty: true })),
}));

vi.mock("../../editor/frEditor", () => ({
  layoutFrEditorForFrame: vi.fn(),
  getFrEditorCell: vi.fn(() => null),
}));

import type { OverlayRenderContext } from "@api/gridOverlays";
import { renderFloatingRange, resetFrRenderCaches, frPickPreviewCells } from "../frRenderer";
import {
  upsertFromInfo,
  getFloatingRangeById,
  resetFloatingRangeStore,
  FLOATING_RANGE_REGION_TYPE,
} from "../../lib/floatingRangeStore";
import { recordFrUsedExtent } from "../../lib/frExtent";
import { setFrScroll } from "../../lib/frScroll";
import { setLocalSelection, clearLocalSelection } from "../../lib/frSelection";
import { getFrView } from "../../lib/frView";
import {
  FR_TITLE_H,
  FR_COL_HDR_H,
  FR_ROW_HDR_W,
  FR_DEFAULT_COL_W,
  FR_DEFAULT_ROW_H,
  contentWidth,
  contentHeight,
} from "../../lib/frDimensions";
import {
  INNER_SELECTION_BORDER,
  INNER_SELECTION_FILL,
  PICK_PREVIEW_STROKE,
} from "../../../_shared/lib/innerSelectionPaint";
import {
  createRecordingCtx,
  rectInside,
  visiblePart,
  type DrawOp,
  type Rect,
} from "../../../_shared/lib/__tests__/recordingCtx";

const FR_ID = "fr-pick";
const REGION_ID = `fr-${FR_ID}`;
const FRAME_X = 100;
const FRAME_Y = 60;

function info(overrides: Partial<FloatingRangeInfo> = {}): FloatingRangeInfo {
  return {
    id: FR_ID,
    backingSheetId: "backing",
    hostSheetId: "host",
    x: FRAME_X,
    y: FRAME_Y,
    rotation: 0,
    pinToGrid: false,
    rowCount: 6,
    colCount: 3,
    colWidths: {},
    rowHeights: {},
    showTitle: true,
    showColumnHeaders: true,
    showRowHeaders: true,
    name: "Float2",
    backingSheetIndex: 2,
    hostSheetIndex: 0,
    ...overrides,
  } as FloatingRangeInfo;
}

function overlayCtx(ctx: CanvasRenderingContext2D): OverlayRenderContext {
  return {
    ctx,
    region: {
      id: REGION_ID,
      type: FLOATING_RANGE_REGION_TYPE,
      startRow: 0,
      startCol: 0,
      endRow: 0,
      endCol: 0,
      floating: { x: FRAME_X, y: FRAME_Y, width: 1, height: 1 },
      data: { frId: FR_ID },
    },
    config: { rowHeaderWidth: 0, colHeaderHeight: 0 },
    viewport: { scrollX: 0, scrollY: 0 },
    dimensions: {},
    canvasWidth: 2000,
    canvasHeight: 2000,
  } as unknown as OverlayRenderContext;
}

/** A styled op: the recorded op plus the ink and dash in force when it was issued. */
interface StyledOp {
  op: DrawOp;
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  dash: number[];
}

/** Render once into a recording context that also notes the ink of every rect op. */
function render(): { ops: DrawOp[]; styled: StyledOp[] } {
  const rec = createRecordingCtx();
  const c = rec.ctx as unknown as Record<string, unknown>;
  let dash: number[] = [];
  const styled: StyledOp[] = [];
  const wrap = (name: "fillRect" | "strokeRect" | "fill") => {
    const original = c[name] as (...args: unknown[]) => void;
    c[name] = (...args: unknown[]) => {
      original(...args);
      styled.push({
        op: rec.ops[rec.ops.length - 1],
        fillStyle: String(c.fillStyle),
        strokeStyle: String(c.strokeStyle),
        lineWidth: Number(c.lineWidth),
        dash: [...dash],
      });
    };
  };
  wrap("fillRect");
  wrap("strokeRect");
  wrap("fill");
  c.setLineDash = (d: number[]) => {
    dash = [...d];
  };
  renderFloatingRange(overlayCtx(rec.ctx));
  return { ops: rec.ops, styled };
}

/** The cell viewport on the canvas (grid headers are 0). */
function viewport(): Rect {
  const e = getFloatingRangeById(FR_ID)!;
  return {
    x: FRAME_X + FR_ROW_HDR_W,
    y: FRAME_Y + FR_TITLE_H + FR_COL_HDR_H,
    width: contentWidth(e),
    height: contentHeight(e),
  };
}

function previewOps(styled: StyledOp[]): StyledOp[] {
  return styled.filter((s) => s.op.op === "strokeRect" && s.strokeStyle === PICK_PREVIEW_STROKE);
}

function near(a: Rect, b: Rect): boolean {
  return [a.x - b.x, a.y - b.y, a.width - b.width, a.height - b.height].every((d) => Math.abs(d) < 1e-6);
}

beforeEach(() => {
  pick.preview = null;
  resetFloatingRangeStore();
  resetFrRenderCaches();
  clearLocalSelection();
});

afterEach(() => {
  pick.preview = null;
  resetFloatingRangeStore();
  resetFrRenderCaches();
  clearLocalSelection();
});

describe("a reference pick's drag preview on the floating grid", () => {
  it("paints the covered cells dashed, in the pick colour, under the cell-viewport clip", () => {
    upsertFromInfo(info());
    const vp = viewport();
    pick.preview = {
      regionId: REGION_ID,
      range: { space: "object", name: "Float2", startRow: 1, startCol: 0, endRow: 2, endCol: 1 },
    };
    const { styled } = render();
    const dashed = previewOps(styled);
    expect(dashed).toHaveLength(1);
    const [p] = dashed;
    expect(p.dash).toEqual([4, 3]);
    expect(p.lineWidth).toBe(1.5);
    // Cells (1,0)..(2,1): two columns, two rows from the viewport's corner, inset by half the line.
    const cells: Rect = {
      x: vp.x,
      y: vp.y + FR_DEFAULT_ROW_H,
      width: 2 * FR_DEFAULT_COL_W,
      height: 2 * FR_DEFAULT_ROW_H,
    };
    expect(
      near(p.op.rect, { x: cells.x + 0.75, y: cells.y + 0.75, width: cells.width - 1.5, height: cells.height - 1.5 }),
      JSON.stringify(p.op.rect),
    ).toBe(true);
    expect(p.op.clip).not.toBeNull();
    expect(rectInside(p.op.clip!, vp)).toBe(true);
  });

  it("a SCROLLED range paints the preview where the scrolled cells are", () => {
    upsertFromInfo(info());
    recordFrUsedExtent(FR_ID, 40, 3);
    setFrScroll(FR_ID, 0, 20 * FR_DEFAULT_ROW_H);
    const vp = viewport();
    pick.preview = {
      regionId: REGION_ID,
      range: { space: "object", name: "Float2", startRow: 20, startCol: 2, endRow: 20, endCol: 2 },
    };
    const [p] = previewOps(render().styled);
    expect(p, "the preview was painted").toBeDefined();
    expect(p.op.rect.y).toBeCloseTo(vp.y + 0.75, 6);
    expect(p.op.rect.x).toBeCloseTo(vp.x + 2 * FR_DEFAULT_COL_W + 0.75, 6);
    expect(rectInside(visiblePart(p.op)!, vp)).toBe(true);
  });

  it("paints nothing for another region, the sheet space, or another name -- and nothing with no preview", () => {
    upsertFromInfo(info());
    const range = { startRow: 0, startCol: 0, endRow: 1, endCol: 1 };
    pick.preview = { regionId: "fr-other", range: { space: "object", name: "Float2", ...range } };
    expect(previewOps(render().styled)).toHaveLength(0);
    pick.preview = { regionId: REGION_ID, range: { space: "sheet", ...range } };
    expect(previewOps(render().styled)).toHaveLength(0);
    pick.preview = { regionId: REGION_ID, range: { space: "object", name: "Float1", ...range } };
    expect(previewOps(render().styled)).toHaveLength(0);
    pick.preview = null;
    expect(previewOps(render().styled)).toHaveLength(0);
    // Positive control on the same render path.
    pick.preview = { regionId: REGION_ID, range: { space: "object", name: "Float2", ...range } };
    expect(previewOps(render().styled)).toHaveLength(1);
  });

  it("frPickPreviewCells normalizes a reversed drag and clamps to the extent", () => {
    const entry = upsertFromInfo(info());
    const view = getFrView(entry);
    pick.preview = {
      regionId: REGION_ID,
      range: { space: "object", name: "Float2", startRow: 9, startCol: 5, endRow: 2, endCol: 1 },
    };
    expect(frPickPreviewCells(REGION_ID, entry, view)).toEqual({ startRow: 2, startCol: 1, endRow: 5, endCol: 2 });
    // Entirely past the extent (the range shrank under a live drag): nothing.
    pick.preview = {
      regionId: REGION_ID,
      range: { space: "object", name: "Float2", startRow: 7, startCol: 0, endRow: 8, endCol: 0 },
    };
    expect(frPickPreviewCells(REGION_ID, entry, view)).toBeNull();
    expect(frPickPreviewCells("fr-other", entry, view)).toBeNull();
  });
});

describe("the local selection uses the ONE inner-selection ink", () => {
  it("fills in INNER_SELECTION_FILL and borders in INNER_SELECTION_BORDER", () => {
    upsertFromInfo(info());
    const vp = viewport();
    setLocalSelection({ frId: FR_ID, anchorRow: 1, anchorCol: 1, endRow: 2, endCol: 2 });
    const { styled } = render();
    const sel: Rect = {
      x: vp.x + FR_DEFAULT_COL_W,
      y: vp.y + FR_DEFAULT_ROW_H,
      width: 2 * FR_DEFAULT_COL_W,
      height: 2 * FR_DEFAULT_ROW_H,
    };
    const fill = styled.find((s) => s.op.op === "fillRect" && near(s.op.rect, sel));
    expect(fill, "the selection fill").toBeDefined();
    expect(fill!.fillStyle).toBe(INNER_SELECTION_FILL);
    const border = styled.find(
      (s) =>
        s.op.op === "strokeRect" &&
        near(s.op.rect, { x: sel.x + 1, y: sel.y + 1, width: sel.width - 2, height: sel.height - 2 }),
    );
    expect(border, "the selection border").toBeDefined();
    expect(border!.strokeStyle).toBe(INNER_SELECTION_BORDER);
    expect(border!.lineWidth).toBe(2);
    expect(previewOps(styled)).toHaveLength(0);
  });
});
