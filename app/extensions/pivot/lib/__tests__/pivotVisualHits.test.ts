//! FILENAME: app/extensions/Pivot/lib/__tests__/pivotVisualHits.test.ts
// PURPOSE: Bounds mapping for the canvas pivot box. The +/- (and filter)
//          bounds `renderPivotView` returns are box-local AFTER the scroll, so a
//          canvas point maps to them by subtracting the box ORIGIN only. The
//          defect this pins is the natural one: subtracting the scroll a second
//          time sends a click on row 8's +/- to a row the user cannot see.

import { describe, it, expect, beforeEach } from "vitest";
import type { PivotViewResponse, PivotRowData, PivotCellData } from "../pivot-api";
import { DEFAULT_PIVOT_THEME } from "../../rendering/pivot";
import {
  buildPivotVisualGeometry,
  paintPivotVisual,
  type PivotVisualBox,
  type PivotVisualScroll,
} from "../../rendering/pivotVisualRenderer";
import {
  hitPivotVisualChrome,
  setPivotVisualRecord,
  getPivotVisualRecord,
  viewCellAtCanvasPoint,
  setPivotVisualHover,
  getPivotVisualHover,
  hoverForHit,
  resetPivotVisualHits,
  type PivotVisualRecord,
} from "../pivotVisualHits";
import { createRecordingCtx } from "../../../_shared/lib/__tests__/recordingCtx";

const ROW_H = 24;

function cell(partial: Partial<PivotCellData> & Pick<PivotCellData, "cellType">): PivotCellData {
  return { value: null, backgroundStyle: "Normal", ...partial } as PivotCellData;
}

function makeView(rowCount: number, expandable: number[]): PivotViewResponse {
  const rows: PivotRowData[] = [
    {
      viewRow: 0,
      rowType: "ColumnHeader",
      depth: 0,
      visible: true,
      cells: [
        cell({ cellType: "RowLabelHeader", formattedValue: "Row Labels", backgroundStyle: "Header" }),
        cell({ cellType: "ColumnHeader", formattedValue: "Sum", backgroundStyle: "Header" }),
      ],
    },
  ];
  for (let i = 1; i < rowCount; i++) {
    rows.push({
      viewRow: i,
      rowType: "Data",
      depth: 0,
      visible: true,
      cells: [
        cell({ cellType: "RowHeader", formattedValue: `Item ${i}`, isExpandable: expandable.includes(i) }),
        cell({ cellType: "Data", value: i, formattedValue: String(i) }),
      ],
    });
  }
  return {
    pivotId: "p1",
    version: 1,
    rowCount,
    colCount: 2,
    rowLabelColCount: 1,
    columnHeaderRowCount: 1,
    filterRowCount: 0,
    filterRows: [],
    rowFieldSummaries: [],
    columnFieldSummaries: [],
    rows,
    columns: [],
  } as PivotViewResponse;
}

const BOX: PivotVisualBox = { x: 40, y: 30, width: 300, height: 200 };

/** Paint the box the way the overlay does and keep the record it would keep. */
function paintAndRecord(view: PivotViewResponse, scroll: PivotVisualScroll, box: PivotVisualBox = BOX): PivotVisualRecord {
  const geometry = buildPivotVisualGeometry(view, true, { columnWidth: () => 120, rowHeight: () => ROW_H });
  const rec = createRecordingCtx();
  const { bounds } = paintPivotVisual({ ctx: rec.ctx, view, geometry, box, scroll, theme: DEFAULT_PIVOT_THEME });
  const record: PivotVisualRecord = {
    pivotId: "p1",
    box,
    bounds,
    cancel: null,
    geometry,
    scroll,
    startRow: 0,
    startCol: 1024,
  };
  setPivotVisualRecord(record);
  return record;
}

beforeEach(() => {
  resetPivotVisualHits();
});

describe("a +/- inside the box maps to the right view cell after scrolling", () => {
  it("row 8's +/- at scroll 120 is hit at its painted canvas position (origin only, no second scroll)", () => {
    const record = paintAndRecord(makeView(50, [8, 9]), { left: 0, top: 120 });

    // Row 8 sits at 8*24 - 120 = 72 in the box; the 12px icon is centred in the row.
    const iconCenterX = BOX.x + 6 + 6;
    const iconCenterY = BOX.y + (8 * ROW_H - 120) + (ROW_H - 12) / 2 + 6;
    const hit = hitPivotVisualChrome(record, iconCenterX, iconCenterY);
    expect(hit).toMatchObject({ kind: "icon", viewRow: 8, viewCol: 0, isRow: true });

    // Row 9's icon, one row lower.
    expect(hitPivotVisualChrome(record, iconCenterX, iconCenterY + ROW_H)).toMatchObject({ kind: "icon", viewRow: 9 });
  });

  it("the same view unscrolled puts row 8's +/- 120px lower", () => {
    const tall: PivotVisualBox = { x: 40, y: 30, width: 300, height: 400 };
    const record = paintAndRecord(makeView(50, [8]), { left: 0, top: 0 }, tall);
    const x = tall.x + 12;
    expect(hitPivotVisualChrome(record, x, tall.y + 8 * ROW_H + 12)).toMatchObject({ kind: "icon", viewRow: 8 });
    expect(hitPivotVisualChrome(record, x, tall.y + 8 * ROW_H - 120 + 12)).toBeNull();
  });

  it("a +/- scrolled up UNDER the frozen header is not clickable there", () => {
    // Row 6 at scroll 140 sits at 144 - 140 = 4 in the box: its icon centre is
    // inside the header band, which paints over it.
    const record = paintAndRecord(makeView(50, [6]), { left: 0, top: 140 });
    expect(record.bounds!.expandCollapseIcons.size).toBe(0);
    expect(hitPivotVisualChrome(record, BOX.x + 12, BOX.y + 4 + 12)).toBeNull();
  });

  it("the Row Labels filter button in the frozen header is hit whatever the scroll", () => {
    const record = paintAndRecord(makeView(50, []), { left: 0, top: 600 });
    // The header button is at the right edge of column 0 (120px), 3px margin.
    const hit = hitPivotVisualChrome(record, BOX.x + 120 - 3 - 9, BOX.y + 12);
    expect(hit).toMatchObject({ kind: "headerFilter", zone: "row", viewRow: 0, viewCol: 0 });
  });

  it("a point outside the box hits nothing even where a bound would be", () => {
    const record = paintAndRecord(makeView(50, [1]), { left: 0, top: 0 });
    expect(hitPivotVisualChrome(record, BOX.x - 5, BOX.y + ROW_H + 12)).toBeNull();
  });

  it("viewCellAtCanvasPoint maps a body point through origin + scroll to the view cell", () => {
    paintAndRecord(makeView(50, []), { left: 0, top: 120 });
    const record = getPivotVisualRecord("p1")!;
    expect(viewCellAtCanvasPoint(record, BOX.x + 130, BOX.y + ROW_H + 2)).toEqual({ viewRow: 6, viewCol: 1 });
  });
});

describe("hover state", () => {
  it("changes only when the hovered chrome changes, and one box at a time", () => {
    expect(setPivotVisualHover("p1", hoverForHit({ kind: "icon", viewRow: 3, viewCol: 0, isRow: true, key: "3-0" }))).toBe(true);
    expect(getPivotVisualHover("p1")).toEqual({ iconKey: "3-0" });
    expect(setPivotVisualHover("p1", { iconKey: "3-0" })).toBe(false);
    expect(setPivotVisualHover("p2", { filterFieldIndex: 1 })).toBe(true);
    expect(getPivotVisualHover("p1")).toBeUndefined();
    expect(setPivotVisualHover(null, {})).toBe(true);
    expect(getPivotVisualHover("p2")).toBeUndefined();
  });
});
