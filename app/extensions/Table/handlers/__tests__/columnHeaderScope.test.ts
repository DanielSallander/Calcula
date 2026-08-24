//! FILENAME: app/extensions/Table/handlers/__tests__/columnHeaderScope.test.ts
// PURPOSE: A click on a table's column header selects the table's DATA rows —
//          the same rows Ctrl+Space selects.
// CONTEXT: This interceptor carried its own copy of "one row down when there is
//          a header, one row short when there is a totals row", and it was the
//          only place that arithmetic was tested by using the app. When the
//          keyboard needed the same answer, the choice was a third copy or one
//          module; it is now `tableBands`, and this file is what keeps the
//          mouse and the keyboard from drifting apart while both stay green.
//
//          The failure would be silent: a click that selects the header row
//          along with the data still selects something, and the extra row only
//          shows up later, in a sum or a chart that quietly includes a caption.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — the handler's whole outside world. `registerColumnHeaderClickInterceptor`
// hands us the function under test.
// ---------------------------------------------------------------------------

type InterceptorFn = (
  col: number,
  canvasX: number,
  canvasY: number,
  colX: number,
  colWidth: number,
  colHeaderHeight: number,
) => { handled: boolean; selectionOverride?: { startRow: number; endRow: number } } | null;

let registeredInterceptor: InterceptorFn | null = null;

vi.mock("@api/ui", () => ({
  registerPanel: vi.fn(),
  unregisterPanel: vi.fn(),
}));

vi.mock("@api", () => ({
  addTaskPaneContextKey: vi.fn(),
  removeTaskPaneContextKey: vi.fn(),
  emitAppEvent: vi.fn(),
  onAppEvent: vi.fn(() => () => undefined),
  setColumnHeaderOverrideProvider: vi.fn(() => () => undefined),
  registerColumnHeaderClickInterceptor: vi.fn((fn: InterceptorFn) => {
    registeredInterceptor = fn;
    return () => {
      registeredInterceptor = null;
    };
  }),
  // eslint-disable-next-line @typescript-eslint/naming-convention
  AppEvents: {
    TABLE_CREATED: "app:table-created",
    TABLE_DEFINITIONS_UPDATED: "app:table-definitions-updated",
    TABLE_STATE: "table:state",
    TABLE_REQUEST_STATE: "table:request-state",
    GRID_REFRESH: "grid:refresh",
  },
}));

interface FakeTable {
  id: string;
  name: string;
  sheetIndex: number;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  columns: Array<{ name: string }>;
  styleOptions: { headerRow: boolean; totalRow: boolean; showFilterButton: boolean };
}

let tables: FakeTable[] = [];

vi.mock("../../lib/tableStore", () => ({
  getAllTables: () => tables,
  getTableAtCell: (row: number, col: number) =>
    tables.find(
      (t) => row >= t.startRow && row <= t.endRow && col >= t.startCol && col <= t.endCol,
    ) ?? null,
}));

vi.mock("../../manifest", () => ({
  TABLE_DESIGN_TAB_ID: "table-design",
  TableDesignPanelDefinition: { id: "table-design", title: "Table Design" },
}));

import {
  handleSelectionChange,
  initClickInterceptor,
  resetSelectionHandlerState,
} from "../selectionHandler";
import { tableBands } from "../../lib/tableBands";

// ---------------------------------------------------------------------------

/** Sales at A5:C10 with a header row and a totals row, so its data is A6:C9. */
function sales(flags: Partial<FakeTable["styleOptions"]> = {}): FakeTable {
  return {
    id: "t-1",
    name: "Sales",
    sheetIndex: 0,
    startRow: 4,
    startCol: 0,
    endRow: 9,
    endCol: 2,
    columns: [{ name: "Region" }, { name: "Units" }, { name: "Margin" }],
    styleOptions: {
      headerRow: true,
      totalRow: true,
      // Off, so a click anywhere in the header is a SELECTION rather than a
      // filter-button hit; the filter button has its own branch.
      showFilterButton: false,
      ...flags,
    },
  };
}

/** Click the middle of a 100px-wide header cell for `col`. */
function clickHeader(col: number) {
  if (!registeredInterceptor) throw new Error("no interceptor registered");
  return registeredInterceptor(col, 50 + col * 100, 10, col * 100, 100, 24);
}

beforeEach(() => {
  resetSelectionHandlerState();
  registeredInterceptor = null;
  tables = [];
});

describe("a table column header click scopes to the table's data rows", () => {
  it("selects the data rows, not the header and not the totals row", () => {
    tables = [sales()];
    initClickInterceptor();
    handleSelectionChange({ endRow: 6, endCol: 1 }); // cursor inside Sales

    expect(clickHeader(1)).toEqual({
      handled: false,
      selectionOverride: { startRow: 5, endRow: 8 },
    });
  });

  it("agrees with tableBands — the mouse and the keyboard read one module", () => {
    const table = sales();
    tables = [table];
    initClickInterceptor();
    handleSelectionChange({ endRow: 6, endCol: 1 });

    const bands = tableBands(table);
    expect(clickHeader(2)?.selectionOverride).toEqual({
      startRow: bands.dataStartRow,
      endRow: bands.dataEndRow,
    });
  });

  it("takes every row when the table has neither a header nor a totals row", () => {
    tables = [sales({ headerRow: false, totalRow: false })];
    initClickInterceptor();
    handleSelectionChange({ endRow: 6, endCol: 1 });

    expect(clickHeader(0)?.selectionOverride).toEqual({ startRow: 4, endRow: 9 });
  });

  it("declines a column outside the table, so the sheet column is selected", () => {
    tables = [sales()];
    initClickInterceptor();
    handleSelectionChange({ endRow: 6, endCol: 1 });

    expect(clickHeader(7)).toBeNull();
  });

  it("declines every column while the cursor is outside any table", () => {
    tables = [sales()];
    initClickInterceptor();
    handleSelectionChange({ endRow: 40, endCol: 1 });

    expect(clickHeader(1)).toBeNull();
  });
});
