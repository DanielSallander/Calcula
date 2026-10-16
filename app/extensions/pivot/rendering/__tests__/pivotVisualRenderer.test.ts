//! FILENAME: app/extensions/Pivot/rendering/__tests__/pivotVisualRenderer.test.ts
// PURPOSE: The canvas pivot box (M6): a 300x200 box over a 50-row view.
//          - the view is drawn under a clip that EQUALS the box and a translate
//            to its origin, with NO clearRect (it would punch a hole through the
//            page), and nothing a real canvas would paint lands outside the box;
//          - a wheel of +120 moves the first visible body row;
//          - frozen headers stay at the top while the body scrolls;
//          - a windowed view reads rows through getRow and reports the rows it
//            had to paint as placeholders;
//          - viewCellAtLocal inverts the frozen + scroll geometry;
//          - selectionPiecesInBox places a rectangle of view cells in the box,
//            one piece per frozen quadrant, with the same arithmetic.

import { describe, it, expect, vi } from "vitest";
import type { PivotViewResponse, PivotRowData, PivotCellData } from "../../lib/pivot-api";
import { DEFAULT_PIVOT_THEME } from "../pivot";
import {
  buildPivotVisualGeometry,
  clampVisualScroll,
  maxScrollOf,
  paintPivotVisual,
  selectionPiecesInBox,
  viewCellAtLocal,
  visibleCellRange,
  type PivotVisualBox,
} from "../pivotVisualRenderer";
import { applyWheelDelta, wheelDeltaPx } from "../../../_shared/lib/objectWheelScroll";
import { createRecordingCtx, rectInside, visiblePart } from "../../../_shared/lib/__tests__/recordingCtx";

const ROW_H = 24;
const COL_W = [120, 80, 80];

function cell(partial: Partial<PivotCellData> & Pick<PivotCellData, "cellType">): PivotCellData {
  return { value: null, backgroundStyle: "Normal", ...partial } as PivotCellData;
}

/** Row 0 = the header row; rows 1..rowCount-1 = "Item i" with two values. */
function makeRows(rowCount: number, expandableRows: number[] = []): PivotRowData[] {
  const rows: PivotRowData[] = [];
  rows.push({
    viewRow: 0,
    rowType: "ColumnHeader",
    depth: 0,
    visible: true,
    cells: [
      cell({ cellType: "RowLabelHeader", value: "Row Labels", formattedValue: "Row Labels", backgroundStyle: "Header" }),
      cell({ cellType: "ColumnHeader", value: "Sum A", formattedValue: "Sum A", backgroundStyle: "Header" }),
      cell({ cellType: "ColumnHeader", value: "Sum B", formattedValue: "Sum B", backgroundStyle: "Header" }),
    ],
  });
  for (let i = 1; i < rowCount; i++) {
    rows.push({
      viewRow: i,
      rowType: "Data",
      depth: 0,
      visible: true,
      cells: [
        cell({
          cellType: "RowHeader",
          value: `Item ${i}`,
          formattedValue: `Item ${i}`,
          isExpandable: expandableRows.includes(i),
          groupPath: [[0, i]],
        }),
        cell({ cellType: "Data", value: i, formattedValue: `A${i}` }),
        cell({ cellType: "Data", value: i * 2, formattedValue: `B${i}` }),
      ],
    });
  }
  return rows;
}

function makeView(rowCount = 50, expandableRows: number[] = []): PivotViewResponse {
  return {
    pivotId: "p1",
    version: 3,
    rowCount,
    colCount: 3,
    rowLabelColCount: 1,
    columnHeaderRowCount: 1,
    filterRowCount: 0,
    filterRows: [],
    rowFieldSummaries: [],
    columnFieldSummaries: [],
    rows: makeRows(rowCount, expandableRows),
    columns: [],
  } as PivotViewResponse;
}

const sizes = {
  columnWidth: (j: number) => COL_W[j] ?? 80,
  rowHeight: () => ROW_H,
};

const BOX: PivotVisualBox = { x: 40, y: 30, width: 300, height: 200 };

function labelTextsVisible(rec: ReturnType<typeof createRecordingCtx>): Array<{ text: string; y: number }> {
  return rec
    .texts()
    .filter((o) => visiblePart(o) !== null)
    .map((o) => ({ text: o.text ?? "", y: o.rect.y }));
}

describe("paintPivotVisual: the box is a clip, not a canvas of its own", () => {
  it("clips to exactly the box, translates to its origin, and never calls clearRect", () => {
    const view = makeView();
    const g = buildPivotVisualGeometry(view, true, sizes);
    const rec = createRecordingCtx();

    paintPivotVisual({ ctx: rec.ctx, view, geometry: g, box: BOX, scroll: { left: 0, top: 0 }, theme: DEFAULT_PIVOT_THEME });

    expect(rec.clips[0]).toEqual({ x: BOX.x, y: BOX.y, width: BOX.width, height: BOX.height });
    expect(rec.translations[0]).toEqual({ x: BOX.x, y: BOX.y });
    expect(rec.ops.filter((o) => o.op === "clearRect")).toEqual([]);
  });

  it("paints nothing outside the box -- every op is issued under a clip inside it", () => {
    const view = makeView();
    const g = buildPivotVisualGeometry(view, true, sizes);
    const rec = createRecordingCtx();

    paintPivotVisual({ ctx: rec.ctx, view, geometry: g, box: BOX, scroll: { left: 40, top: 120 }, theme: DEFAULT_PIVOT_THEME });

    expect(rec.ops.length).toBeGreaterThan(20);
    for (const op of rec.ops) {
      expect(op.clip, `${op.op} issued with no clip`).not.toBeNull();
      expect(rectInside(op.clip!, BOX), `${op.op} clip ${JSON.stringify(op.clip)} leaves the box`).toBe(true);
    }
    // The view is 50 rows tall: cells below the box WERE issued (the last body
    // row straddles the bottom edge) and the clip is what keeps them inside.
    const straddling = rec.ops.filter((o) => o.op === "fillRect" && o.rect.y + o.rect.height > BOX.y + BOX.height);
    expect(straddling.length).toBeGreaterThan(0);
    for (const op of straddling) {
      const vis = visiblePart(op);
      if (vis) expect(rectInside(vis, BOX)).toBe(true);
    }
  });
});

describe("scrolling a 50-row view in a 300x200 box", () => {
  it("a wheel of +120 changes the first visible body row", () => {
    const view = makeView();
    const g = buildPivotVisualGeometry(view, true, sizes);
    const { maxLeft, maxTop } = maxScrollOf(g, BOX.width, BOX.height);
    expect(maxTop).toBe(50 * ROW_H - BOX.height);

    const before = visibleCellRange(g, { left: 0, top: 0 }, BOX.width, BOX.height);
    const { dx, dy } = wheelDeltaPx({ deltaX: 0, deltaY: 120, deltaMode: 0, shiftKey: false }, ROW_H, BOX);
    const next = applyWheelDelta({ left: 0, top: 0, maxLeft, maxTop }, dx, dy);
    expect(next).toEqual({ left: 0, top: 120 });
    const after = visibleCellRange(g, next!, BOX.width, BOX.height);

    expect(before.startRow).toBe(1);
    expect(after.startRow).toBe(6);

    // And the paint agrees: "Item 6" is the first body label, right under the header.
    const rec = createRecordingCtx();
    paintPivotVisual({ ctx: rec.ctx, view, geometry: g, box: BOX, scroll: next!, theme: DEFAULT_PIVOT_THEME });
    const labels = labelTextsVisible(rec).filter((t) => t.text.startsWith("Item "));
    const topmost = labels.reduce((a, b) => (b.y < a.y ? b : a));
    expect(topmost.text).toBe("Item 6");
    expect(topmost.y).toBe(BOX.y + ROW_H + ROW_H / 2);
    expect(labels.some((t) => t.text === "Item 5")).toBe(false);
  });

  it("frozen headers stay at the top while the body scrolls", () => {
    const view = makeView();
    const frozen = buildPivotVisualGeometry(view, true, sizes);
    const rec = createRecordingCtx();
    paintPivotVisual({ ctx: rec.ctx, view, geometry: frozen, box: BOX, scroll: { left: 0, top: 240 }, theme: DEFAULT_PIVOT_THEME });

    const header = labelTextsVisible(rec).find((t) => t.text === "Row Labels");
    expect(header, "the header row is still painted").toBeDefined();
    expect(header!.y).toBe(BOX.y + ROW_H / 2);

    // Unfrozen, the same scroll carries the header out of the box.
    const loose = buildPivotVisualGeometry(view, false, sizes);
    const rec2 = createRecordingCtx();
    paintPivotVisual({ ctx: rec2.ctx, view, geometry: loose, box: BOX, scroll: { left: 0, top: 240 }, theme: DEFAULT_PIVOT_THEME });
    expect(labelTextsVisible(rec2).some((t) => t.text === "Row Labels")).toBe(false);
  });

  it("row labels stay at the left while the body scrolls horizontally", () => {
    const view = makeView();
    const g = buildPivotVisualGeometry(view, true, sizes);
    const narrow: PivotVisualBox = { x: 0, y: 0, width: 200, height: 200 };
    const s = clampVisualScroll(g, narrow.width, narrow.height, { left: 500, top: 0 });
    expect(s.left).toBe(280 - 200);

    const rec = createRecordingCtx();
    paintPivotVisual({ ctx: rec.ctx, view, geometry: g, box: narrow, scroll: s, theme: DEFAULT_PIVOT_THEME });
    const item1 = rec.texts().find((t) => t.text === "Item 1" && visiblePart(t));
    expect(item1, "the row label column is frozen").toBeDefined();
    expect(item1!.rect.x).toBeLessThan(COL_W[0]);
  });

  it("clamps the scroll when the view is smaller than the box", () => {
    const view = makeView(5);
    const g = buildPivotVisualGeometry(view, true, sizes);
    expect(clampVisualScroll(g, BOX.width, BOX.height, { left: 99, top: 99 })).toEqual({ left: 0, top: 0 });
  });
});

describe("windowed views", () => {
  it("reads rows through getRow and reports the unfetched rows it painted as placeholders", () => {
    const full = makeView(500);
    const windowed: PivotViewResponse = {
      ...full,
      rows: full.rows.slice(0, 200),
      isWindowed: true,
      totalRowCount: 500,
      windowStartRow: 0,
      rowDescriptors: full.rows.map((r) => ({ viewRow: r.viewRow, rowType: r.rowType, depth: r.depth, visible: true })),
    };
    const g = buildPivotVisualGeometry(windowed, true, sizes);
    expect(g.rowCount).toBe(500);

    const cache = new Map<number, PivotRowData>(full.rows.slice(0, 200).map((r, i) => [i, r]));
    const getRow = vi.fn((i: number) => cache.get(i) ?? null);
    const onMissingRows = vi.fn();
    const rec = createRecordingCtx();
    // Scroll past the first window.
    paintPivotVisual({
      ctx: rec.ctx,
      view: windowed,
      geometry: g,
      box: BOX,
      scroll: { left: 0, top: 300 * ROW_H },
      theme: DEFAULT_PIVOT_THEME,
      getRow,
      onMissingRows,
    });

    expect(getRow).toHaveBeenCalled();
    expect(onMissingRows).toHaveBeenCalledTimes(1);
    const [first, last] = onMissingRows.mock.calls[0];
    expect(first).toBe(301);
    expect(last).toBeGreaterThanOrEqual(307);
    // No stale label from the first window leaked into the scrolled box.
    expect(labelTextsVisible(rec).some((t) => t.text.startsWith("Item "))).toBe(false);
  });
});

describe("viewCellAtLocal inverts the frozen + scroll geometry", () => {
  const view = makeView();
  const g = buildPivotVisualGeometry(view, true, sizes);

  it("a point in the frozen header maps to header row 0 whatever the scroll", () => {
    expect(viewCellAtLocal(g, { left: 0, top: 600 }, 10, 5)).toEqual({ viewRow: 0, viewCol: 0 });
  });

  it("a point in the body adds the scroll", () => {
    // 3 rows below the header band, scrolled 120px (5 rows): view row 1 + 3 + 5.
    expect(viewCellAtLocal(g, { left: 0, top: 120 }, 130, ROW_H + 3 * ROW_H + 2)).toEqual({ viewRow: 9, viewCol: 1 });
  });

  it("round-trips with the painted position of a (visible) cell", () => {
    const s = { left: 30, top: 200 };
    for (const [r, c] of [[12, 2], [20, 2], [10, 0]] as const) {
      const x = c < g.frozenColCount ? g.colOffsets[c] : g.colOffsets[c] - s.left;
      const y = r < g.frozenRowCount ? g.rowOffsets[r] : g.rowOffsets[r] - s.top;
      expect(viewCellAtLocal(g, s, x + 2, y + 2)).toEqual({ viewRow: r, viewCol: c });
    }
  });

  it("is null past the content", () => {
    expect(viewCellAtLocal(g, { left: 0, top: 0 }, 5000, 10)).toBeNull();
  });
});

describe("selectionPiecesInBox: a rectangle of view cells, one box-local piece per frozen quadrant", () => {
  const view = makeView();

  it("no freeze: one piece, offset by the scroll", () => {
    const g = buildPivotVisualGeometry(view, false, sizes);
    expect(selectionPiecesInBox(g, { left: 0, top: 0 }, BOX.width, BOX.height, { startRow: 2, startCol: 1, endRow: 3, endCol: 2 })).toEqual([
      { x: 120, y: 48, width: 160, height: 48 },
    ]);
    // Scrolled 24px down and 20px right: the same cells, moved up and left.
    expect(selectionPiecesInBox(g, { left: 20, top: 24 }, BOX.width, BOX.height, { startRow: 2, startCol: 1, endRow: 3, endCol: 2 })).toEqual([
      { x: 100, y: 24, width: 160, height: 48 },
    ]);
  });

  it("frozen rows + columns, scrolled both ways: four pieces, each clipped to its quadrant", () => {
    const g = buildPivotVisualGeometry(view, true, sizes);
    const pieces = selectionPiecesInBox(g, { left: 30, top: 120 }, BOX.width, BOX.height, {
      startRow: 0,
      startCol: 0,
      endRow: 10,
      endCol: 2,
    });
    expect(pieces).toEqual([
      // header row x row-label column: never scrolled
      { x: 0, y: 0, width: 120, height: 24 },
      // header row x body columns 1-2 (120..280, scrolled 30 -> 90..250, clipped to start at the frozen 120)
      { x: 120, y: 0, width: 130, height: 24 },
      // body rows 1-10 (24..264, scrolled 120 -> -96..144, clipped to start under the frozen 24) x row labels
      { x: 0, y: 24, width: 120, height: 120 },
      // body x body
      { x: 120, y: 24, width: 130, height: 120 },
    ]);
  });

  it("a rectangle scrolled fully UNDER the frozen header band yields no piece; one partly under is clipped to the band's edge", () => {
    const g = buildPivotVisualGeometry(view, true, sizes);
    // Rows 1-3 sit at 24..96; scrolled 120 they are at -96..-24, under the header.
    expect(selectionPiecesInBox(g, { left: 0, top: 120 }, BOX.width, BOX.height, { startRow: 1, startCol: 1, endRow: 3, endCol: 1 })).toEqual([]);
    // Rows 3-6 (72..168) scrolled 120 -> -48..48: only 24..48 shows.
    expect(selectionPiecesInBox(g, { left: 0, top: 120 }, BOX.width, BOX.height, { startRow: 3, startCol: 1, endRow: 6, endCol: 1 })).toEqual([
      { x: 120, y: 24, width: 80, height: 24 },
    ]);
  });

  it("rows below the box are cut at its bottom; corners in either order are the same rectangle", () => {
    const g = buildPivotVisualGeometry(view, true, sizes);
    const down = selectionPiecesInBox(g, { left: 0, top: 0 }, BOX.width, BOX.height, { startRow: 5, startCol: 2, endRow: 40, endCol: 1 });
    const up = selectionPiecesInBox(g, { left: 0, top: 0 }, BOX.width, BOX.height, { startRow: 40, startCol: 1, endRow: 5, endCol: 2 });
    expect(down).toEqual(up);
    expect(down).toEqual([{ x: 120, y: 120, width: 160, height: 80 }]);
  });

  it("each piece is where viewCellAtLocal finds the cells it covers (paint == hit)", () => {
    const g = buildPivotVisualGeometry(view, true, sizes);
    const s = { left: 30, top: 200 };
    const rect = { startRow: 9, startCol: 1, endRow: 12, endCol: 2 };
    const pieces = selectionPiecesInBox(g, s, BOX.width, BOX.height, rect);
    expect(pieces.length).toBe(1);
    for (const p of pieces) {
      for (const [dx, dy] of [[1, 1], [p.width - 1, 1], [1, p.height - 1], [p.width - 1, p.height - 1]]) {
        const at = viewCellAtLocal(g, s, p.x + dx, p.y + dy)!;
        expect(at.viewRow).toBeGreaterThanOrEqual(rect.startRow);
        expect(at.viewRow).toBeLessThanOrEqual(rect.endRow);
        expect(at.viewCol).toBeGreaterThanOrEqual(rect.startCol);
        expect(at.viewCol).toBeLessThanOrEqual(rect.endCol);
      }
    }
  });

  it("hidden rows (height 0) add no height; an empty geometry or box yields nothing", () => {
    const hidden = makeView();
    hidden.rows[3] = { ...hidden.rows[3], visible: false };
    const g = buildPivotVisualGeometry(hidden, false, sizes);
    expect(selectionPiecesInBox(g, { left: 0, top: 0 }, BOX.width, BOX.height, { startRow: 2, startCol: 0, endRow: 4, endCol: 0 })).toEqual([
      { x: 0, y: 48, width: 120, height: 48 },
    ]);
    expect(selectionPiecesInBox(g, { left: 0, top: 0 }, 0, BOX.height, { startRow: 2, startCol: 0, endRow: 4, endCol: 0 })).toEqual([]);
    const none = buildPivotVisualGeometry(makeView(1), false, sizes);
    expect(selectionPiecesInBox({ ...none, rowCount: 0 }, { left: 0, top: 0 }, BOX.width, BOX.height, { startRow: 0, startCol: 0, endRow: 0, endCol: 0 })).toEqual([]);
  });
});
