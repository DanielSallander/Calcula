//! FILENAME: app/extensions/FloatingRange/rendering/__tests__/frRendererScroll.test.ts
// PURPOSE: The floating range paint under overflow scroll (M7), recorded on a
//          context double that tracks translation and clip like a real one:
//          - rows past the WINDOW paint once the range is scrolled to them;
//          - the cell fetch is limited to the on-screen cells plus a margin,
//            never the whole window or extent;
//          - nothing of the cell content lands outside the cell viewport (the
//            scrolled-away rows, the rows scrolled under the sticky headers);
//          - the sticky column letters / row numbers show the scrolled labels,
//            each clipped to its own strip;
//          - scroll indicators appear only on an axis that overflows;
//          - a window over 100,000 cells still paints (every read <= 100,000).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FloatingRangeInfo } from "@api/floatingRanges";

type Rect = { startRow: number; startCol: number; endRow: number; endCol: number };
const reads: Rect[] = [];

vi.mock("@api/floatingRanges", () => ({
  FLOATING_RANGE_MAX_ROWS: 1000,
  FLOATING_RANGE_MAX_COLS: 256,
  listFloatingRanges: vi.fn(async () => []),
  updateFloatingRange: vi.fn(async () => ({})),
  // Every cell exists and displays "r{row}c{col}" -- so a painted string names
  // the cell it came from.
  getFloatingRangeCells: vi.fn(async (_id: string, startRow: number, startCol: number, endRow: number, endCol: number) => {
    reads.push({ startRow, startCol, endRow, endCol });
    if ((endRow - startRow + 1) * (endCol - startCol + 1) > 100_000) {
      throw new Error("range too large");
    }
    const out = [];
    for (let r = startRow; r <= endRow; r++) {
      for (let c = startCol; c <= endCol; c++) {
        out.push({ row: r, col: c, type: "text", value: `r${r}c${c}`, display: `r${r}c${c}` });
      }
    }
    return out;
  }),
}));

vi.mock("@api/lib", () => ({
  getUsedRange: vi.fn(async () => ({ startRow: 0, startCol: 0, endRow: 0, endCol: 0, empty: true })),
}));

vi.mock("../../editor/frEditor", () => ({
  layoutFrEditorForFrame: vi.fn(),
}));

import type { OverlayRenderContext } from "@api/gridOverlays";
import { renderFloatingRange, fetchFrCells, resetFrRenderCaches } from "../frRenderer";
import {
  upsertFromInfo,
  resetFloatingRangeStore,
  FLOATING_RANGE_REGION_TYPE,
  type FloatingRangeEntry,
} from "../../lib/floatingRangeStore";
import { recordFrUsedExtent } from "../../lib/frExtent";
import { setFrScroll, getFrScroll } from "../../lib/frScroll";
import { setLocalSelection, clearLocalSelection } from "../../lib/frSelection";
import {
  FR_TITLE_H,
  FR_COL_HDR_H,
  FR_ROW_HDR_W,
  FR_DEFAULT_COL_W,
  FR_DEFAULT_ROW_H,
  frameWidth,
  frameHeight,
  contentWidth,
  contentHeight,
} from "../../lib/frDimensions";
import { SCROLL_INDICATOR_SIZE } from "../../../_shared/lib/scrollIndicators";
import {
  createRecordingCtx,
  rectInside,
  visiblePart,
  type DrawOp,
  type Rect as CanvasRect,
} from "../../../_shared/lib/__tests__/recordingCtx";

const FR_ID = "fr-scroll";
/** Frame origin in sheet px; the grid's own headers are 0 (a canvas sheet). */
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
    rowCount: 10,
    colCount: 3,
    colWidths: {},
    rowHeights: {},
    showTitle: true,
    showColumnHeaders: true,
    showRowHeaders: true,
    name: "Float1",
    backingSheetIndex: 2,
    hostSheetIndex: 0,
    ...overrides,
  } as FloatingRangeInfo;
}

function overlayCtx(ctx: CanvasRenderingContext2D, canvas = { width: 2000, height: 2000 }): OverlayRenderContext {
  return {
    ctx,
    region: {
      id: `fr-${FR_ID}`,
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
    canvasWidth: canvas.width,
    canvasHeight: canvas.height,
  } as unknown as OverlayRenderContext;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** Render once, let the fetch it kicked land, render again; return the second paint's ops. */
async function paint(canvas?: { width: number; height: number }) {
  const first = createRecordingCtx();
  renderFloatingRange(overlayCtx(first.ctx, canvas));
  await flush();
  const rec = createRecordingCtx();
  renderFloatingRange(overlayCtx(rec.ctx, canvas));
  return rec;
}

const CELL_TEXT = /^r(\d+)c(\d+)$/;

/** The painted (visible) cell-value ops, as [row, col, op]. */
function paintedCells(ops: DrawOp[]): Array<{ row: number; col: number; op: DrawOp }> {
  const out = [];
  for (const op of ops) {
    if (op.op !== "fillText" || !op.text) continue;
    const m = CELL_TEXT.exec(op.text);
    if (!m || !visiblePart(op)) continue;
    out.push({ row: Number(m[1]), col: Number(m[2]), op });
  }
  return out;
}

/** The cell viewport on the canvas (grid headers are 0, the frame is unscrolled). */
function viewportRect(e: FloatingRangeEntry): CanvasRect {
  return {
    x: FRAME_X + FR_ROW_HDR_W,
    y: FRAME_Y + FR_TITLE_H + FR_COL_HDR_H,
    width: contentWidth(e),
    height: contentHeight(e),
  };
}

beforeEach(() => {
  reads.length = 0;
  resetFloatingRangeStore();
  resetFrRenderCaches();
  clearLocalSelection();
});

afterEach(() => {
  resetFloatingRangeStore();
  resetFrRenderCaches();
  clearLocalSelection();
});

describe("frRenderer under overflow scroll", () => {
  it("paints rows past the WINDOW once scrolled to them", async () => {
    upsertFromInfo(info());
    recordFrUsedExtent(FR_ID, 50, 3); // content reaches row 49; the window shows 10
    setFrScroll(FR_ID, 0, 20 * FR_DEFAULT_ROW_H);

    const rec = await paint();
    const rows = new Set(paintedCells(rec.ops).map((p) => p.row));
    expect(rows.has(20)).toBe(true);
    expect(rows.has(29)).toBe(true);
    expect(rows.has(0)).toBe(false); // scrolled away
    expect(rows.has(30)).toBe(false); // not reached yet
  });

  it("before any scroll it paints exactly the window, as before M7", async () => {
    upsertFromInfo(info());
    recordFrUsedExtent(FR_ID, 50, 3);
    const rec = await paint();
    const rows = new Set(paintedCells(rec.ops).map((p) => p.row));
    expect([...rows].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("fetches only the on-screen rows plus a margin, not the extent", async () => {
    upsertFromInfo(info());
    recordFrUsedExtent(FR_ID, 1000, 3);
    setFrScroll(FR_ID, 0, 500 * FR_DEFAULT_ROW_H);

    await paint();
    expect(reads.length).toBeGreaterThan(0);
    const last = reads[reads.length - 1];
    // Covers the ten rows on screen...
    expect(last.startRow).toBeLessThanOrEqual(500);
    expect(last.endRow).toBeGreaterThanOrEqual(509);
    // ...and is windowed around them, not the 1000-row extent.
    expect(last.startRow).toBeGreaterThan(400);
    expect(last.endRow - last.startRow + 1).toBeLessThanOrEqual(60);
  });

  it("does not re-read on a scroll that stays inside the rows already read", async () => {
    upsertFromInfo(info());
    recordFrUsedExtent(FR_ID, 1000, 3);
    await paint();
    const before = reads.length;
    setFrScroll(FR_ID, 0, 5 * FR_DEFAULT_ROW_H); // rows 5..14, inside the 0..29 read
    const rec = createRecordingCtx();
    renderFloatingRange(overlayCtx(rec.ctx));
    await flush();
    expect(reads.length).toBe(before);
    expect(paintedCells(rec.ops).some((p) => p.row === 14)).toBe(true);
  });

  it("paints nothing of the cell content outside the cell viewport", async () => {
    const e = upsertFromInfo(info());
    recordFrUsedExtent(FR_ID, 50, 6);
    // Three quarters of row 7 and of column 0 scrolled away: their text
    // ANCHORS now sit under the sticky letter strip / row gutter, so only the
    // viewport clip keeps them from painting there.
    setFrScroll(FR_ID, 0.75 * FR_DEFAULT_COL_W, 7.75 * FR_DEFAULT_ROW_H);
    // A selection from row 0 -- mostly scrolled away above the viewport.
    setLocalSelection({ frId: FR_ID, anchorRow: 0, anchorCol: 0, endRow: 20, endCol: 1 });

    const rec = await paint();
    const vp = viewportRect(e);
    const cells = paintedCells(rec.ops);
    expect(cells.length).toBeGreaterThan(0);
    for (const { op } of cells) {
      expect(rectInside(visiblePart(op)!, vp), `${op.text} painted outside the viewport`).toBe(true);
    }
    // The scrolled-away cells are not painted at all.
    expect(cells.some((p) => p.row < 7)).toBe(false);

    // The selection fill starts 155px above the viewport; what paints of it
    // is inside the viewport.
    const selFill = rec.ops.find(
      (o) => o.op === "fillRect" && o.rect.y < vp.y - 100 && o.rect.height > 20 * FR_DEFAULT_ROW_H - 1,
    );
    expect(selFill, "the selection fill was painted").toBeDefined();
    expect(rectInside(visiblePart(selFill!)!, vp)).toBe(true);

    // The gridlines are stroked under exactly the viewport clip.
    const same = (a: CanvasRect | null) =>
      !!a && [a.x - vp.x, a.y - vp.y, a.width - vp.width, a.height - vp.height].every((d) => Math.abs(d) < 1e-6);
    expect(rec.ops.some((o) => o.op === "stroke" && same(o.clip))).toBe(true);
  });

  it("shows the SCROLLED labels in the sticky headers, each inside its strip", async () => {
    const e = upsertFromInfo(info());
    recordFrUsedExtent(FR_ID, 50, 8);
    setFrScroll(FR_ID, 2 * FR_DEFAULT_COL_W, 20 * FR_DEFAULT_ROW_H);

    const rec = await paint();
    const visibleTexts = rec
      .texts()
      .filter((o) => visiblePart(o))
      .map((o) => o.text);
    // Row numbers are 1-based: row 20 is "21".
    expect(visibleTexts).toContain("21");
    expect(visibleTexts).not.toContain("1");
    // Two columns scrolled away: the first letter shown is C.
    expect(visibleTexts).toContain("C");
    expect(visibleTexts).not.toContain("A");

    const letterStrip: CanvasRect = {
      x: FRAME_X + FR_ROW_HDR_W,
      y: FRAME_Y + FR_TITLE_H,
      width: contentWidth(e),
      height: FR_COL_HDR_H,
    };
    const numberStrip: CanvasRect = {
      x: FRAME_X,
      y: FRAME_Y + FR_TITLE_H + FR_COL_HDR_H,
      width: FR_ROW_HDR_W,
      height: contentHeight(e),
    };
    for (const o of rec.texts()) {
      const part = visiblePart(o);
      if (!part || !o.text) continue;
      if (/^[A-Z]+$/.test(o.text) && o.text !== e.name) {
        expect(rectInside(part, letterStrip), `letter ${o.text}`).toBe(true);
      }
      if (/^\d+$/.test(o.text)) {
        expect(rectInside(part, numberStrip), `number ${o.text}`).toBe(true);
      }
    }
  });

  it("paints scroll indicators only on an axis that overflows", async () => {
    const e = upsertFromInfo(info());
    const vp = viewportRect(e);
    const verticalBars = (ops: DrawOp[]) =>
      ops.filter(
        (o) =>
          o.op === "fillRect" &&
          o.rect.width === SCROLL_INDICATOR_SIZE &&
          Math.abs(o.rect.x - (vp.x + vp.width - SCROLL_INDICATOR_SIZE)) < 1e-6,
      );

    recordFrUsedExtent(FR_ID, 5, 3); // fits the window
    expect(verticalBars((await paint()).ops)).toHaveLength(0);

    recordFrUsedExtent(FR_ID, 40, 3); // overflows vertically
    const bars = verticalBars((await paint()).ops);
    expect(bars).toHaveLength(2); // track + thumb
    for (const b of bars) expect(rectInside(b.rect, vp)).toBe(true);
  });

  it("re-clamps a scroll left past a shrunken end, once the extent is known", async () => {
    upsertFromInfo(info());
    recordFrUsedExtent(FR_ID, 12, 3); // 2 rows = 40px past the window
    setFrScroll(FR_ID, 0, 900);
    await paint();
    expect(getFrScroll(FR_ID).top).toBe(2 * FR_DEFAULT_ROW_H);
  });
});

describe("a window over 100,000 cells", () => {
  it("still paints: the on-screen read stays inside the backend's limit", async () => {
    const e = upsertFromInfo(info({ rowCount: 1000, colCount: 256 }));
    expect(frameWidth(e) * frameHeight(e)).toBeGreaterThan(0);
    const rec = await paint({ width: 2000, height: 1200 });
    for (const r of reads) {
      expect((r.endRow - r.startRow + 1) * (r.endCol - r.startCol + 1)).toBeLessThanOrEqual(100_000);
    }
    expect(paintedCells(rec.ops).length).toBeGreaterThan(0);
  });

  it("a whole-window read is cut into bands the backend accepts", async () => {
    const e = upsertFromInfo(info({ rowCount: 1000, colCount: 256 }));
    await fetchFrCells(e);
    expect(reads.length).toBeGreaterThan(1);
    for (const r of reads) {
      expect((r.endRow - r.startRow + 1) * (r.endCol - r.startCol + 1)).toBeLessThanOrEqual(100_000);
    }
    // The bands tile rows 0..999 with no gap and no overlap.
    const sorted = [...reads].sort((a, b) => a.startRow - b.startRow);
    expect(sorted[0].startRow).toBe(0);
    expect(sorted[sorted.length - 1].endRow).toBe(999);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i].startRow).toBe(sorted[i - 1].endRow + 1);
  });
});

