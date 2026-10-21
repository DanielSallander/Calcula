//! FILENAME: app/extensions/FloatingRange/rendering/__tests__/frRendererStyled.test.ts
// PURPOSE: The floating grid paints its cells FORMATTED (P3, owner finding G3),
//          from the styled read (`get_cell_target_cells`):
//          - a bold yellow cell reaches `paintStyledCellBox` with ITS style
//            (from the read's style cache) in its own box, and the yellow
//            fill is painted there;
//          - a merged B2:C2 paints ONCE, as one box over both columns, and the
//            covered cell is skipped;
//          - a hidden row has no paint (and no hit: frDimensions.test.ts);
//          - conditional formatting comes from the BACKING evaluation: the
//            cell's results fold into `conditional`, and the glyph seam is
//            handed the read's (backing) rules -- never the host's;
//          - the selection paints every area, grown to whole merges.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FloatingRangeInfo } from "@api/floatingRanges";
import type { CellTargetCells } from "@api/cellTarget";

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

/** What the backend's styled read answers (set per test). */
const backend = { read: null as CellTargetCells | null };
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: vi.fn(async (cmd: string) => {
    if (cmd !== "get_cell_target_cells") throw new Error(`unexpected invoke ${cmd}`);
    return backend.read;
  }),
}));

// The two seams the renderer paints through, observed (the real painters run).
const paintBox = vi.fn();
vi.mock("@api/cellPaint", async (importOriginal) => {
  const real = await importOriginal<typeof import("@api/cellPaint")>();
  return {
    ...real,
    paintStyledCellBox: (...args: Parameters<typeof real.paintStyledCellBox>) => {
      paintBox(...args);
      real.paintStyledCellBox(...args);
    },
  };
});
const paintGlyphs = vi.fn();
vi.mock("@api/conditionalFormatPaint", async (importOriginal) => {
  const real = await importOriginal<typeof import("@api/conditionalFormatPaint")>();
  return {
    ...real,
    paintConditionalFormat: (...args: Parameters<typeof real.paintConditionalFormat>) => {
      paintGlyphs(...args);
      real.paintConditionalFormat(...args);
    },
  };
});

import type { OverlayRenderContext } from "@api/gridOverlays";
import type { StyleData } from "@api/types";
import { renderFloatingRange, resetFrRenderCaches } from "../frRenderer";
import { upsertFromInfo, resetFloatingRangeStore, FLOATING_RANGE_REGION_TYPE } from "../../lib/floatingRangeStore";
import { setLocalSelection, clearLocalSelection } from "../../lib/frSelection";
import {
  FR_TITLE_H,
  FR_COL_HDR_H,
  FR_ROW_HDR_W,
  FR_DEFAULT_COL_W,
  FR_DEFAULT_ROW_H,
} from "../../lib/frDimensions";
import { createRecordingCtx, visiblePart } from "../../../_shared/lib/__tests__/recordingCtx";
import { PLAIN_STYLE, styledRead, targetCell } from "../../__tests__/helpers/frStyledRead";

const FR_ID = "fr-styled";
const FRAME_X = 100;
const FRAME_Y = 60;
const YELLOW = "#ffff00";
const BOLD_YELLOW = { ...PLAIN_STYLE, bold: true, backgroundColor: YELLOW } as StyleData;
const RECT = { startRow: 0, startCol: 0, endRow: 4, endCol: 3 };

function info(overrides: Partial<FloatingRangeInfo> = {}): FloatingRangeInfo {
  return {
    id: FR_ID,
    backingSheetId: "backing",
    hostSheetId: "host",
    x: FRAME_X,
    y: FRAME_Y,
    rotation: 0,
    pinToGrid: false,
    rowCount: 5,
    colCount: 4,
    colWidths: {},
    rowHeights: {},
    hiddenRows: [],
    hiddenCols: [],
    showTitle: true,
    showColumnHeaders: true,
    showRowHeaders: true,
    name: "Float1",
    backingSheetIndex: 2,
    hostSheetIndex: 0,
    ...overrides,
  } as FloatingRangeInfo;
}

function overlayCtx(ctx: CanvasRenderingContext2D): OverlayRenderContext {
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
    canvasWidth: 2000,
    canvasHeight: 2000,
  } as unknown as OverlayRenderContext;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** Render once, let the read it kicked land, clear the spies, render again. */
async function paint() {
  renderFloatingRange(overlayCtx(createRecordingCtx().ctx));
  await flush();
  paintBox.mockClear();
  paintGlyphs.mockClear();
  const rec = createRecordingCtx();
  renderFloatingRange(overlayCtx(rec.ctx));
  return rec;
}

/** Canvas x of column c's left edge / y of row r's top (no hidden lines, no scroll). */
const colX = (c: number) => FRAME_X + FR_ROW_HDR_W + c * FR_DEFAULT_COL_W;
const rowY = (r: number) => FRAME_Y + FR_TITLE_H + FR_COL_HDR_H + r * FR_DEFAULT_ROW_H;

/** The paintStyledCellBox call for the cell displaying `text`, or undefined. */
function boxCallFor(text: string) {
  return paintBox.mock.calls.find((c) => (c[2] as { cell: { display: string } }).cell.display === text);
}

beforeEach(() => {
  backend.read = null;
  paintBox.mockClear();
  paintGlyphs.mockClear();
  resetFloatingRangeStore();
  resetFrRenderCaches();
  clearLocalSelection();
});

afterEach(() => {
  resetFloatingRangeStore();
  resetFrRenderCaches();
  clearLocalSelection();
});

describe("the floating grid paints its cells formatted (P3)", () => {
  it("a bold yellow cell reaches paintStyledCellBox with ITS style, in its own box, and paints yellow", async () => {
    upsertFromInfo(info());
    backend.read = styledRead(
      RECT,
      (r, c) => (r === 1 && c === 1 ? targetCell(1, 1, "10", { styleIndex: 5, valueKind: "number" }) : null),
      { 5: BOLD_YELLOW },
    );
    const rec = await paint();
    const call = boxCallFor("10");
    expect(call, "the cell was not painted through the styled-cell primitive").toBeDefined();
    const [, box, paintArgs] = call!;
    expect(box).toEqual({ x: colX(1), y: rowY(1), width: FR_DEFAULT_COL_W, height: FR_DEFAULT_ROW_H });
    expect(paintArgs).toMatchObject({ style: { bold: true, backgroundColor: YELLOW }, valueKind: "number" });
    // The fill landed, in the cell's box.
    const fill = rec.ops.find(
      (o) => o.op === "fillRect" && o.rect.x === colX(1) && o.rect.y === rowY(1) && o.rect.width === FR_DEFAULT_COL_W,
    );
    expect(fill, "no yellow fill in B2's box").toBeDefined();
    // The ink is bold (the font the text was painted in).
    expect(rec.texts().some((t) => t.text === "10" && visiblePart(t))).toBe(true);
  });

  it("a merged B2:C2 paints ONCE, as one box over both columns; the covered cell is skipped", async () => {
    upsertFromInfo(info());
    backend.read = styledRead(
      RECT,
      (r, c) => (r === 1 && c === 1 ? targetCell(1, 1, "merged", { colSpan: 2 }) : null),
      {},
      { merges: [{ startRow: 1, startCol: 1, endRow: 1, endCol: 2 }] },
    );
    await paint();
    const calls = paintBox.mock.calls.filter((c) => (c[2] as { cell: { display: string } }).cell.display === "merged");
    expect(calls).toHaveLength(1);
    const box = calls[0][1] as { x: number; y: number; width: number; height: number };
    expect(box.x).toBeCloseTo(colX(1), 6);
    expect(box.y).toBe(rowY(1));
    expect(box.width).toBeCloseTo(2 * FR_DEFAULT_COL_W, 6);
    expect(box.height).toBe(FR_DEFAULT_ROW_H);
    // Nothing else is painted in C2's place.
    expect(paintBox.mock.calls.some((c) => (c[1] as { x: number }).x === colX(2) && (c[1] as { y: number }).y === rowY(1))).toBe(false);
  });

  it("a hidden row has NO paint: its cell is never painted and the row below takes its place", async () => {
    upsertFromInfo(info({ hiddenRows: [1] }));
    backend.read = styledRead(RECT, (r, c) => (c === 0 && r <= 2 ? targetCell(r, 0, `row${r}`) : null));
    const rec = await paint();
    expect(boxCallFor("row1"), "the hidden row's cell was painted").toBeUndefined();
    expect(rec.texts().some((t) => t.text === "row1")).toBe(false);
    // Row 2 now sits where row 1 was.
    expect(boxCallFor("row2")?.[1]).toMatchObject({ y: rowY(1) });
    // And its number is not in the gutter either.
    expect(rec.texts().some((t) => t.text === "2")).toBe(false);
    expect(rec.texts().some((t) => t.text === "3")).toBe(true);
  });

  it("conditional formatting comes from the BACKING evaluation, with the backing rules", async () => {
    upsertFromInfo(info());
    const rule = { id: 77, priority: 1, rule: { type: "dataBar" }, format: {}, ranges: [], stopIfTrue: false, enabled: true };
    backend.read = styledRead(
      RECT,
      (r, c) => (c === 1 && (r === 2 || r === 3) ? targetCell(r, 1, String(r * 10), { valueKind: "number" }) : null),
      {},
      {
        conditional: [
          { row: 2, col: 1, format: { backgroundColor: "#ff0000" }, ruleId: 76 },
          { row: 3, col: 1, format: {}, dataBarPercent: 0.5, ruleId: 77 },
        ],
        rules: [rule as never],
      },
    );
    await paint();
    expect(boxCallFor("20")?.[2]).toMatchObject({ conditional: { backgroundColor: "#ff0000" } });
    const glyph = paintGlyphs.mock.calls.find((c) => (c[1] as { y: number }).y === rowY(3));
    expect(glyph, "the data bar's cell went past the glyph seam").toBeDefined();
    expect(glyph![2]).toEqual([{ row: 3, col: 1, format: {}, dataBarPercent: 0.5, ruleId: 77 }]);
    expect(glyph![3]).toEqual([rule]);
  });

  it("the selection paints every area, grown to whole merges", async () => {
    upsertFromInfo(info());
    backend.read = styledRead(RECT, () => null, {}, { merges: [{ startRow: 0, startCol: 0, endRow: 0, endCol: 1 }] });
    setLocalSelection({
      frId: FR_ID,
      anchorRow: 0,
      anchorCol: 0,
      endRow: 0,
      endCol: 0,
      areas: [{ startRow: 3, startCol: 2, endRow: 3, endCol: 3 }],
    });
    const rec = await paint();
    const outlines = rec.ops.filter((o) => o.op === "strokeRect");
    // The main area is the whole merged A1:B1; the second area is C4:D4.
    expect(outlines.some((o) => Math.abs(o.rect.x - (colX(0) + 1)) < 1e-6 && Math.abs(o.rect.width - (2 * FR_DEFAULT_COL_W - 2)) < 1e-6)).toBe(true);
    expect(outlines.some((o) => Math.abs(o.rect.x - (colX(2) + 1)) < 1e-6 && Math.abs(o.rect.y - (rowY(3) + 1)) < 1e-6)).toBe(true);
  });
});
