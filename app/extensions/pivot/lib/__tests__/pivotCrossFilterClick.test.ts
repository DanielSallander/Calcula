//! FILENAME: app/extensions/Pivot/lib/__tests__/pivotCrossFilterClick.test.ts
// PURPOSE: A canvas BI pivot box as a cross-filter SOURCE (P4 S7,
//          lib/pivotCrossFilterClick.ts), over the REAL @api/reportFilters
//          selections:
//            - a row header, a column header and a data cell name their
//              MemberPath: the groupPath mapped through `groupMembers` (keys,
//              never labels), the value field left out;
//            - a grand total, a valueId the view did not key, and a view
//              without groupMembers name nothing ("noPaths", said once);
//            - the grammar of S6: a plain click replaces every selection on the
//              page, the sole selected cell clears, Ctrl toggles and keeps the
//              other sources;
//            - a FILTERED box reads the cell it SHOWS.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@api/grid", () => ({
  getGridStateSnapshot: () => ({ zoom: 1, surface: "canvas", sheetContext: { activeSheetIndex: 2 } }),
}));

vi.mock("@api/reportPages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/reportPages")>()),
  startReportPages: () => () => {},
  getReportPagesSnapshot: () => ({
    pages: [{ index: 2, sheetId: "sheet-2", name: "Page 1" }],
    sheetIdByIndex: new Map([[2, "sheet-2"]]),
    activeIndex: 2,
    version: 1,
  }),
}));

import { clearCrossFilters, getCrossFilters, setCrossFilter } from "@api/reportFilters";
import { pivotBackend } from "../pivotBackend";
import { deleteCachedPivotView, setCachedPivotView } from "../pivotViewStore";
import { installPivotCrossFilter, resetPivotCrossFilterViews, setFilteredPivotViewForTest } from "../pivotCrossFilterView";
import {
  applyPivotCrossFilterClick,
  pivotCellMemberPath,
  resetPivotCrossFilterClickNotes,
} from "../pivotCrossFilterClick";
import { PivotEvents } from "../../../_shared/lib/pivotEvents";
import type { PivotCellData, PivotRegionData, PivotViewResponse } from "../pivot-api";

const REGION = "Geo.Region";
const YEAR = "Date.Year";

/**
 * Region (field 0) on rows, Year (field 2) on columns, one value field
 * (field 7 in groupPaths: not a model member). Row 0 = column headers, rows
 * 1-2 = East / West, row 3 = the grand total.
 */
function view(label = "real"): PivotViewResponse {
  const cell = (c: Partial<PivotCellData>): PivotCellData => ({ value: null, backgroundStyle: "Normal", cellType: "Data", ...c }) as PivotCellData;
  return {
    pivotId: "p1",
    version: 1,
    rowCount: 4,
    colCount: 3,
    rowLabelColCount: 1,
    columnHeaderRowCount: 1,
    filterRowCount: 0,
    filterRows: [],
    rowFieldSummaries: [],
    columnFieldSummaries: [],
    rows: [
      {
        viewRow: 0,
        rowType: "ColumnHeader",
        depth: 0,
        visible: true,
        cells: [
          cell({ cellType: "RowLabelHeader", value: "Row Labels" }),
          cell({ cellType: "ColumnHeader", value: "2024", groupPath: [[2, 10]] }),
          cell({ cellType: "ColumnHeader", value: "2025", groupPath: [[2, 11]] }),
        ],
      },
      {
        viewRow: 1,
        rowType: "Data",
        depth: 0,
        visible: true,
        cells: [
          cell({ cellType: "RowHeader", value: `East ${label}`, groupPath: [[0, 1]] }),
          cell({ value: 5, groupPath: [[0, 1], [2, 10], [7, 0]] }),
          cell({ value: 6, groupPath: [[0, 1], [2, 11], [7, 0]] }),
        ],
      },
      {
        viewRow: 2,
        rowType: "Data",
        depth: 0,
        visible: true,
        cells: [
          cell({ cellType: "RowHeader", value: "West", groupPath: [[0, 2]] }),
          cell({ value: 7, groupPath: [[0, 2], [2, 10], [7, 0]] }),
          cell({ value: 8, groupPath: [[0, 2], [2, 99]] }),
        ],
      },
      {
        viewRow: 3,
        rowType: "GrandTotal",
        depth: 0,
        visible: true,
        cells: [cell({ cellType: "GrandTotal", value: "Grand Total" }), cell({ cellType: "GrandTotalRow", value: 12 }), cell({ cellType: "GrandTotalRow", value: 14 })],
      },
    ],
    columns: [],
    groupMembers: [
      { fieldIndex: 0, fieldKey: REGION, members: [[1, "East"], [2, "West"]] },
      { fieldIndex: 2, fieldKey: YEAR, members: [[10, "2024"], [11, "2025"]] },
    ],
  } as unknown as PivotViewResponse;
}

const box: PivotRegionData = {
  pivotId: "p1",
  name: "Sales by region",
  startRow: 0,
  startCol: 1024,
  endRow: 3,
  endCol: 1026,
  isEmpty: false,
  isModel: true,
  canvasFrame: { x: 0, y: 0, width: 300, height: 200 },
} as PivotRegionData;

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

const click = (viewRow: number, viewCol: number, ctrl = false) => applyPivotCrossFilterClick({ pivotId: "p1", viewRow, viewCol, ctrl });

let cleanups: Array<() => void> = [];

beforeEach(async () => {
  pivotBackend.set((async (command: string) => {
    if (command === "get_pivot_bi_metadata") return { connectionId: "conn-1", tables: [{ name: "Geo" }, { name: "Date" }], measures: [] };
    if (command === "run_bi_pivot_filtered_view") return view("filtered");
    throw new Error(`unexpected ${command}`);
  }) as never);
  clearCrossFilters();
  resetPivotCrossFilterViews();
  resetPivotCrossFilterClickNotes();
  setCachedPivotView("p1", view());
  cleanups = installPivotCrossFilter();
  window.dispatchEvent(new CustomEvent(PivotEvents.PIVOT_REGIONS_UPDATED, { detail: { regions: [box] } }));
  await settle();
});

afterEach(() => {
  cleanups.forEach((c) => c());
  cleanups = [];
  clearCrossFilters();
  deleteCachedPivotView("p1");
});

describe("a cell's member path", () => {
  const v = view();
  const at = (r: number, c: number) => v.rows[r].cells[c];

  it("a row header, a column header and a data cell name KEYS; the value field is left out", () => {
    expect(pivotCellMemberPath(at(1, 0), v)).toEqual([{ field: REGION, key: "East" }]);
    expect(pivotCellMemberPath(at(0, 2), v)).toEqual([{ field: YEAR, key: "2025" }]);
    expect(pivotCellMemberPath(at(1, 1), v)).toEqual([
      { field: REGION, key: "East" },
      { field: YEAR, key: "2024" },
    ]);
  });

  it("a total, an unkeyed valueId and a view without groupMembers name nothing", () => {
    expect(pivotCellMemberPath(at(3, 1), v)).toBeNull();
    expect(pivotCellMemberPath(at(0, 0), v)).toBeNull();
    expect(pivotCellMemberPath(at(2, 2), v), "valueId 99 is not keyed: never a narrower tuple").toBeNull();
    expect(pivotCellMemberPath(at(1, 1), { ...v, groupMembers: undefined })).toBeNull();
  });
});

describe("the click grammar", () => {
  it("a plain click on a header selects its member, replacing every other selection on the page", () => {
    setCrossFilter({
      source: { kind: "chart", id: "c1" },
      sourceName: "Chart",
      pageSheetId: "sheet-2",
      connectionId: "conn-1",
      fields: [YEAR],
      tuples: [["2024"]],
    });
    expect(click(1, 0)).toBe("selected");
    expect(getCrossFilters()).toEqual([
      {
        source: { kind: "pivot", id: "p1" },
        sourceName: "Sales by region",
        pageSheetId: "sheet-2",
        connectionId: "conn-1",
        fields: [REGION],
        tuples: [["East"]],
      },
    ]);
  });

  it("a plain click on the sole selected cell clears it", () => {
    click(1, 1);
    expect(click(1, 1)).toBe("cleared");
    expect(getCrossFilters()).toEqual([]);
  });

  it("Ctrl toggles within the box and keeps the other sources", () => {
    setCrossFilter({
      source: { kind: "chart", id: "c1" },
      sourceName: "Chart",
      pageSheetId: "sheet-2",
      connectionId: "conn-1",
      fields: [YEAR],
      tuples: [["2024"]],
    });
    expect(click(1, 0, true)).toBe("toggled");
    expect(click(2, 0, true)).toBe("toggled");
    const mine = getCrossFilters().find((s) => s.source.kind === "pivot")!;
    expect(mine.tuples).toEqual([["East"], ["West"]]);
    expect(getCrossFilters().some((s) => s.source.kind === "chart")).toBe(true);
    click(1, 0, true);
    expect(getCrossFilters().find((s) => s.source.kind === "pivot")!.tuples).toEqual([["West"]]);
  });

  it("a total does nothing and says so once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(click(3, 1)).toBe("noPaths");
    expect(click(3, 2)).toBe("noPaths");
    expect(getCrossFilters()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("a FILTERED box reads the cell it shows", () => {
    const shown = view("filtered");
    shown.groupMembers = [{ fieldIndex: 0, fieldKey: REGION, members: [[1, "North"]] }];
    setFilteredPivotViewForTest("p1", { view: shown, sources: ["Chart"] });
    click(1, 0);
    expect(getCrossFilters()[0].tuples).toEqual([["North"]]);
    setFilteredPivotViewForTest("p1", null);
  });
});
