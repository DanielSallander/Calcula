//! FILENAME: app/extensions/Table/lib/tableStyleInterceptor.test.ts
// PURPOSE: The table style interceptor paints each table in its STORED style.
// CONTEXT: The Table Styles gallery writes `Table.styleName`, but the
//          interceptor used to hardcode Medium 2's header (#4472C4) and stripe
//          (#D9E2F3) for every table, so choosing a style changed nothing on the
//          grid. These tests drive the REAL interceptor (the function it
//          registers with the @api pipeline) over tables whose style differs,
//          and pin the default to exactly the two colours the visual E2E
//          goldens (tables, comments-notes, zz-workbook-residue) photograph.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Table } from "@api/backend";

const h = vi.hoisted(() => ({
  registered: [] as Array<{ id: string; fn: (...a: unknown[]) => unknown; priority: number }>,
  tables: [] as unknown[],
}));

vi.mock("@api", () => ({
  registerStyleInterceptor: (id: string, fn: (...a: unknown[]) => unknown, priority: number) => {
    h.registered.push({ id, fn, priority });
    return () => {
      h.registered = h.registered.filter((r) => r.fn !== fn);
    };
  },
}));

// tableStyles.ts carries the style write, which reaches the backend.
vi.mock("@api/backend", () => ({ updateTableStyle: vi.fn() }));

vi.mock("./tableStore", () => ({
  refreshCache: vi.fn(() => Promise.resolve()),
  getTableAtCell: (row: number, col: number) =>
    (h.tables as Table[]).find(
      (t) => row >= t.startRow && row <= t.endRow && col >= t.startCol && col <= t.endCol,
    ) ?? null,
}));

import {
  registerTableStyleInterceptor,
  resolveTablePaint,
  tableCellStyle,
} from "./tableStyleInterceptor";
import { TABLE_STYLES, TABLE_STYLES_BY_ID, tableStyleNameForId } from "./tableStyles";

// ============================================================================
// Fixtures
// ============================================================================

/** A 4-column table: header row 0, data rows 1..5, (optional) total row 6. */
function makeTable(overrides: Partial<Table> = {}, options: Partial<Table["styleOptions"]> = {}): Table {
  return {
    id: "t1",
    name: "Sales",
    sheetIndex: 0,
    startRow: 0,
    startCol: 0,
    endRow: 6,
    endCol: 3,
    columns: [],
    styleName: "TableStyleMedium2",
    styleOptions: {
      headerRow: true,
      totalRow: false,
      bandedRows: true,
      bandedColumns: false,
      firstColumn: false,
      lastColumn: false,
      showFilterButton: true,
      ...options,
    },
    ...overrides,
  };
}

const lower = (c: string | undefined): string | undefined => c?.toLowerCase();

/** The registered interceptor, called the way the render pipeline calls it. */
function paintAt(row: number, col: number): Record<string, unknown> | null {
  const reg = h.registered.find((r) => r.id === "calcula.table.style");
  if (!reg) throw new Error("the table style interceptor is not registered");
  return reg.fn("", { styleIndex: 0 }, { row, col }) as Record<string, unknown> | null;
}

let unregister: (() => void) | null = null;

beforeEach(() => {
  unregister?.();
  h.registered = [];
  h.tables = [];
  unregister = registerTableStyleInterceptor();
});

// ============================================================================
// The default style: exactly what the goldens photograph
// ============================================================================

describe("a default (Medium 2) table", () => {
  it("registers with the pipeline as before: id and priority", () => {
    expect(h.registered.map((r) => [r.id, r.priority])).toEqual([["calcula.table.style", 5]]);
  });

  it("paints the #4472C4 header with white bold text", () => {
    h.tables = [makeTable()];
    const header = paintAt(0, 1)!;
    expect(lower(header.backgroundColor as string)).toBe("#4472c4");
    expect(lower(header.textColor as string)).toBe("#ffffff");
    expect(header.bold).toBe(true);
  });

  it("stripes the first, third and fifth data rows #D9E2F3 and leaves the others alone", () => {
    h.tables = [makeTable()];
    expect(lower(paintAt(1, 2)!.backgroundColor as string)).toBe("#d9e2f3");
    expect(paintAt(2, 2)).toBeNull();
    expect(lower(paintAt(3, 2)!.backgroundColor as string)).toBe("#d9e2f3");
    expect(paintAt(4, 2)).toBeNull();
    expect(lower(paintAt(5, 2)!.backgroundColor as string)).toBe("#d9e2f3");
  });

  it("totals in the stripe colour, bold", () => {
    h.tables = [makeTable({}, { totalRow: true })];
    const total = paintAt(6, 0)!;
    expect(lower(total.backgroundColor as string)).toBe("#d9e2f3");
    expect(total.bold).toBe(true);
    expect(total.textColor).toBeUndefined();
  });

  it("marks the first/last column by weight alone, keeping the stripe", () => {
    h.tables = [makeTable({}, { firstColumn: true, lastColumn: true })];
    expect(paintAt(2, 0)).toEqual({ bold: true });
    expect(paintAt(2, 3)).toEqual({ bold: true });
    expect(paintAt(2, 1)).toBeNull();
    const stripedEdge = paintAt(1, 0)!;
    expect(lower(stripedEdge.backgroundColor as string)).toBe("#d9e2f3");
    expect(stripedEdge.bold).toBe(true);
  });

  it("banded columns stripe every other column from the first", () => {
    h.tables = [makeTable({}, { bandedRows: false, bandedColumns: true })];
    expect(lower(paintAt(2, 0)!.backgroundColor as string)).toBe("#d9e2f3");
    expect(paintAt(2, 1)).toBeNull();
    expect(lower(paintAt(2, 2)!.backgroundColor as string)).toBe("#d9e2f3");
  });

  it("respects the flags: no header row makes the first row data; no banding paints no body", () => {
    h.tables = [makeTable({}, { headerRow: false })];
    // Row 0 is now the first DATA row, so it is a stripe, not a header.
    expect(paintAt(0, 1)).toEqual({ backgroundColor: expect.any(String) });
    expect(paintAt(1, 1)).toBeNull();

    h.tables = [makeTable({}, { bandedRows: false })];
    for (let row = 1; row <= 6; row++) expect(paintAt(row, 1)).toBeNull();
  });

  it("paints nothing outside a table", () => {
    h.tables = [makeTable()];
    expect(paintAt(0, 9)).toBeNull();
    expect(paintAt(20, 0)).toBeNull();
  });
});

// ============================================================================
// Another style: the gallery's choice reaches the grid
// ============================================================================

describe("a table whose stored style is not the default", () => {
  it("paints that style's header colour", () => {
    const def = TABLE_STYLES_BY_ID.get("table-medium-4")!;
    h.tables = [makeTable({ styleName: tableStyleNameForId(def.id) })];
    const header = paintAt(0, 1)!;
    expect(lower(header.backgroundColor as string)).toBe(lower(def.thumb.headerBg));
    expect(lower(header.backgroundColor as string)).not.toBe("#4472c4");
    expect(header.bold).toBe(true);
  });

  it("alternates banded rows in THAT style's stripe", () => {
    const def = TABLE_STYLES_BY_ID.get("table-medium-6")!;
    h.tables = [makeTable({ styleName: "TableStyleMedium6" })];
    const stripe = lower(def.cells.stripeBg);
    expect(stripe).toBeTruthy();
    expect(stripe).not.toBe("#d9e2f3");
    expect(lower(paintAt(1, 1)!.backgroundColor as string)).toBe(stripe);
    expect(paintAt(2, 1)).toBeNull();
    expect(lower(paintAt(3, 1)!.backgroundColor as string)).toBe(stripe);
  });

  it("a Light style with an unfilled header still bolds and colours its header text", () => {
    const def = TABLE_STYLES_BY_ID.get("table-light-2")!;
    h.tables = [makeTable({ styleName: "TableStyleLight2" })];
    const header = paintAt(0, 1)!;
    expect(header.backgroundColor).toBeUndefined();
    expect(lower(header.textColor as string)).toBe(lower(def.thumb.headerFg));
    expect(header.bold).toBe(true);
  });

  it("a Dark style fills its body, and totals/edges in the header's paint", () => {
    const def = TABLE_STYLES_BY_ID.get("table-dark-2")!;
    h.tables = [makeTable({ styleName: "TableStyleDark2" }, { totalRow: true, firstColumn: true })];
    const header = paintAt(0, 1)!;
    expect(lower(header.backgroundColor as string)).toBe(lower(def.thumb.headerBg));
    // Unstriped body rows are filled too (the thumbnail's base row).
    expect(lower(paintAt(2, 1)!.backgroundColor as string)).toBe(lower(def.thumb.baseBg));
    expect(lower(paintAt(6, 1)!.backgroundColor as string)).toBe(lower(def.thumb.headerBg));
    const edge = paintAt(2, 0)!;
    expect(lower(edge.backgroundColor as string)).toBe(lower(def.thumb.headerBg));
    expect(lower(edge.textColor as string)).toBe("#ffffff");
    expect(edge.bold).toBe(true);
  });

  it("two tables on the grid wear their own styles side by side", () => {
    h.tables = [
      makeTable({ id: "a", styleName: "TableStyleMedium2" }),
      makeTable({ id: "b", startCol: 10, endCol: 13, styleName: "TableStyleMedium7" }),
    ];
    const a = lower(paintAt(0, 1)!.backgroundColor as string);
    const b = lower(paintAt(0, 11)!.backgroundColor as string);
    expect(a).toBe("#4472c4");
    expect(b).toBe(lower(TABLE_STYLES_BY_ID.get("table-medium-7")!.thumb.headerBg));
    expect(a).not.toBe(b);
  });
});

// ============================================================================
// None, unknown names, and the cache
// ============================================================================

describe("the None style and names the catalogue cannot draw", () => {
  it("None (an empty style name) paints no fill, no text colour, no weight", () => {
    h.tables = [makeTable({ styleName: "" }, { totalRow: true, firstColumn: true, bandedColumns: true })];
    for (let row = 0; row <= 6; row++) {
      for (let col = 0; col <= 3; col++) expect(paintAt(row, col)).toBeNull();
    }
  });

  it("an imported custom style falls back to the default Medium 2 rather than vanishing", () => {
    h.tables = [makeTable({ styleName: "MyCompanyStyle" })];
    expect(lower(paintAt(0, 1)!.backgroundColor as string)).toBe("#4472c4");
    h.tables = [makeTable({ styleName: "TableStyleMedium29" })];
    expect(lower(paintAt(0, 1)!.backgroundColor as string)).toBe("#4472c4");
  });

  it("resolves each style name once: the per-cell path reuses frozen overrides", () => {
    const first = resolveTablePaint("TableStyleDark5");
    expect(resolveTablePaint("TableStyleDark5")).toBe(first);
    expect(Object.isFrozen(first!.header)).toBe(true);
    const table = makeTable({ styleName: "TableStyleMedium2" });
    // Two different stripe cells get the SAME object: no allocation per cell.
    expect(tableCellStyle(table, 1, 1)).toBe(tableCellStyle(table, 3, 2));
    expect(resolveTablePaint("")).toBeNull();
  });
});

// ============================================================================
// Every style in the catalogue
// ============================================================================

describe("every catalogue style", () => {
  it("resolves, paints its header, and never puts white text on an unfilled cell", () => {
    for (const def of TABLE_STYLES) {
      const table = makeTable(
        { styleName: tableStyleNameForId(def.id) },
        { totalRow: true, firstColumn: true, lastColumn: true },
      );
      const header = tableCellStyle(table, 0, 1);
      expect(header?.bold, def.id).toBe(true);
      for (let row = 0; row <= 6; row++) {
        for (let col = 0; col <= 3; col++) {
          const o = tableCellStyle(table, row, col);
          if (lower(o?.textColor) === "#ffffff") {
            expect(o?.backgroundColor, `${def.id} r${row}c${col}`).toBeTruthy();
          }
        }
      }
    }
  });
});
