//! FILENAME: app/extensions/BuiltIn/PasteSpecial/__tests__/pasteLinkSource.test.ts
// PURPOSE: Paste Link links to the cells that were COPIED -- on the sheet they
//          were copied from, the rows they were copied from -- and spells the
//          link the way Excel does.
// CONTEXT: Survey clipboard.md section 9, defects 1 and 2:
//            1. `buildAbsoluteRef` wrote `=$A$1` with no sheet name, because
//               ClipboardData did not record the source sheet: a Paste Link on
//               another sheet linked to the same addresses on the DESTINATION.
//            2. After a FILTERED copy (the hidden rows collapse away) it used
//               `sourceMinRow + r`, linking every row after the first hidden
//               gap to the wrong row. ClipboardData's own comment says matrix
//               rows map back through `sourceRows`.
//          Excel, measured live through COM (2026-10-04, Worksheet.Paste
//          Link:=True):
//            same sheet,  one cell  -> =$A$1
//            same sheet,  a range   -> =A1, =B2        (RELATIVE)
//            other sheet, one cell  -> =Sheet1!$A$1
//            other sheet, a range   -> =Sheet1!A1, =Sheet1!B2
//            a sheet named "My Data" -> ='My Data'!$A$1

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  activeSheet: 0,
  updates: [] as Array<[number, number, string]>,
}));

vi.mock("@api/state", () => ({
  getGridStateSnapshot: () => ({
    selection: { startRow: 4, startCol: 4, endRow: 4, endCol: 4, type: "cells" },
    config: { totalRows: 100, totalCols: 50 },
    sheetContext: { activeSheetIndex: h.activeSheet, activeSheetName: `S${h.activeSheet}` },
    surface: "grid",
  }),
}));
vi.mock("@api/lib", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/lib")>()),
  updateCell: vi.fn(async (r: number, c: number, v: string) => {
    h.updates.push([r, c, v]);
    return { cells: [] };
  }),
  beginUndoTransaction: vi.fn(async () => 1),
  commitUndoTransaction: vi.fn(async () => {}),
  cancelUndoTransaction: vi.fn(async () => {}),
}));
vi.mock("@api/dialogs", () => ({ alertAsync: vi.fn(async () => {}) }));
vi.mock("@api/cellClipboard", () => ({ internalClipboardIsCurrent: vi.fn(async () => true) }));

import { executePasteLink } from "../pasteSpecialExecute";

const TARGET = { startRow: 4, startCol: 4, endRow: 4, endCol: 4, type: "cells" } as never;

function copied(
  rows: number,
  cols: number,
  over: Partial<{ startRow: number; startCol: number; sourceRows: number[]; sheet: number; name: string; endRow: number }> = {},
): never {
  const startRow = over.startRow ?? 0;
  const startCol = over.startCol ?? 0;
  const cells = Array.from({ length: rows }, (_, r) =>
    Array.from({ length: cols }, (_, c) => ({ row: r, col: c, display: "v", formula: null, styleIndex: 0 })),
  );
  return {
    cells,
    sourceSelection: {
      startRow,
      startCol,
      endRow: over.endRow ?? startRow + rows - 1,
      endCol: startCol + cols - 1,
      type: "cells",
    },
    sourceRows: over.sourceRows ?? Array.from({ length: rows }, (_, r) => startRow + r),
    isCut: false,
    sourceSheetIndex: over.sheet ?? 0,
    sourceSheetName: over.name ?? "Sheet1",
    text: "v",
  } as never;
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  h.activeSheet = 0;
  h.updates = [];
});

describe("Paste Link on the SAME sheet", () => {
  it("one cell: an absolute link (=$A$1)", async () => {
    await executePasteLink(copied(1, 1), TARGET, 100, 50);
    expect(h.updates).toEqual([[4, 4, "=$A$1"]]);
  });

  it("a range: relative links, cell by cell (=A1 ... =B2)", async () => {
    await executePasteLink(copied(2, 2), TARGET, 100, 50);
    expect(h.updates).toEqual([
      [4, 4, "=A1"],
      [4, 5, "=B1"],
      [5, 4, "=A2"],
      [5, 5, "=B2"],
    ]);
  });
});

describe("Paste Link on ANOTHER sheet names the source sheet", () => {
  it("one cell copied on Sheet1, linked on sheet 1: =Sheet1!$A$1", async () => {
    h.activeSheet = 1;
    await executePasteLink(copied(1, 1, { sheet: 0, name: "Sheet1" }), TARGET, 100, 50);
    expect(h.updates).toEqual([[4, 4, "=Sheet1!$A$1"]]);
  });

  it("a range: =Sheet1!A1 ... =Sheet1!B2", async () => {
    h.activeSheet = 1;
    await executePasteLink(copied(2, 2, { sheet: 0, name: "Sheet1" }), TARGET, 100, 50);
    expect(h.updates).toEqual([
      [4, 4, "=Sheet1!A1"],
      [4, 5, "=Sheet1!B1"],
      [5, 4, "=Sheet1!A2"],
      [5, 5, "=Sheet1!B2"],
    ]);
  });

  it("a name the parser cannot read bare is quoted: ='My Data'!$A$1", async () => {
    h.activeSheet = 2;
    await executePasteLink(copied(1, 1, { sheet: 0, name: "My Data" }), TARGET, 100, 50);
    expect(h.updates).toEqual([[4, 4, "='My Data'!$A$1"]]);
  });
});

describe("Paste Link after a FILTERED copy maps rows through sourceRows", () => {
  it("rows 1 and 3 hidden: the second pasted row links to row 3, not row 2", async () => {
    // Copied A1:A4 with rows 2 and 4 (index 1 and 3) filtered out: the matrix
    // holds rows 0 and 2.
    await executePasteLink(copied(2, 1, { endRow: 3, sourceRows: [0, 2] }), TARGET, 100, 50);
    expect(h.updates).toEqual([
      [4, 4, "=A1"],
      [5, 4, "=A3"],
    ]);
  });
});
