//! FILENAME: app/extensions/BuiltIn/PasteSpecial/__tests__/pasteCommentsBatch.test.ts
// PURPOSE: BUG-0725 -- Paste Special > Comments is ONE backend call for the whole
//          paste (it was one addComment per destination cell), and it is
//          Excel's paste [LIVE, Excel 16, 2026-11-06, lane obj4 c1.ps1]: the
//          copied comments REPLACE the destinations' own, and a destination
//          whose copied cell has none loses its comment.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  setDV: vi.fn(),
  pasteComments: vi.fn(),
  clearDV: vi.fn(),
  ranges: [] as unknown[],
  alert: vi.fn(),
}));

vi.mock("@api/state", () => ({
  getGridStateSnapshot: () => ({
    selection: { startRow: 0, startCol: 2, endRow: 0, endCol: 2, type: "cells" },
    config: { totalRows: 1000, totalCols: 100 },
    sheetContext: { activeSheetIndex: 0, activeSheetName: "Sheet1" },
  }),
}));
vi.mock("@api/lib", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/lib")>()),
  getCell: vi.fn(async () => null),
  getStyle: vi.fn(async () => ({ numberFormat: "General" })),
  updateCell: vi.fn(async () => ({ cells: [] })),
  setCellStyle: vi.fn(async () => null),
  setCellStyles: vi.fn(async () => undefined),
  applyFormatting: vi.fn(async () => ({ cells: [], styles: [] })),
  updateCellsBatch: vi.fn(async () => []),
  setDataValidation: (...a: unknown[]) => h.setDV(...a),
  clearDataValidation: (...a: unknown[]) => h.clearDV(...a),
  pasteComments: (...a: unknown[]) => h.pasteComments(...a),
  addComment: vi.fn(async () => { throw new Error("per-cell addComment must not be called"); }),
  getAllDataValidations: vi.fn(async () => h.ranges),
  getRangeCellsTyped: vi.fn(async () => []),
  getSheets: vi.fn(async () => ({ sheets: [{ index: 0, name: "Sheet1", sheetId: "sheet-a" }], activeIndex: 0 })),
  getMergedRegions: vi.fn(async () => []),
  beginUndoTransaction: vi.fn(async () => 5),
  commitUndoTransaction: vi.fn(async () => undefined),
  cancelUndoTransaction: vi.fn(async () => undefined),
  getSpillRanges: vi.fn(async () => []),
  isSheetProtected: vi.fn(async () => false),
  canPerformAction: vi.fn(async () => ({ canEdit: true, reason: "" })),
  canEditCells: vi.fn(async () => ({ canEdit: true, reason: "" })),
}));
// The backend's fill shifter, for the custom formula's move: a plain A1
// mover over single-cell references (enough for `=A1>0`).
vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  shiftFormulasBatch: vi.fn(async (inputs: Array<{ formula: string; rowDelta: number; colDelta: number }>) =>
    inputs.map(({ formula, rowDelta, colDelta }) =>
      formula.replace(/([A-Z]+)(\d+)/g, (_m, letters: string, digits: string) => {
        const col = letters.charCodeAt(0) - 65 + colDelta;
        const row = Number(digits) - 1 + rowDelta;
        return row < 0 || col < 0 ? "#REF!" : `${String.fromCharCode(65 + col)}${row + 1}`;
      }),
    ),
  ),
}));
vi.mock("@api/cellTarget", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/cellTarget")>()),
  getCellTargetCellsTyped: vi.fn(async () => []),
  getCellTargetCells: vi.fn(async () => ({ cells: [], merges: [], conditional: [], styles: [], rules: [] })),
  selectTargetCells: vi.fn(async () => undefined),
  cellTargetFor: () => ({ kind: "grid", selection: null }),
}));
vi.mock("@api/floatingRangeSpills", () => ({ getFloatingRangeSpillRanges: vi.fn(async () => []) }));
vi.mock("@api/cellClipboard", () => ({ internalClipboardIsCurrent: vi.fn(async () => true) }));
vi.mock("@api/dialogs", () => ({ alertAsync: (...a: unknown[]) => h.alert(...a) }));

import { executePasteSpecial } from "../pasteSpecialExecute";

const comment = (content: string) => ({ authorEmail: "a@b", authorName: "Ann", content });

/** A copy of A1:A3 of Sheet1 whose A1 and A2 carry comments and A3 none. */
const COPY = {
  cells: [0, 1, 2].map((r) => [{ row: r, col: 0, display: "", formula: null, styleIndex: 0 }]),
  values: [[null], [null], [null]],
  sourceSelection: { startRow: 0, startCol: 0, endRow: 2, endCol: 0, type: "cells" },
  sourceRows: [0, 1, 2],
  isCut: false,
  sourceSheetIndex: 0,
  sourceSheetName: "Sheet1",
  sourceSheetId: "sheet-a",
  text: "",
  comments: new Map([["0,0", comment("src-A1")], ["1,0", comment("src-A2")]]),
} as never;

const sel = (r0: number, c0: number, r1: number, c1: number) =>
  ({ startRow: r0, startCol: c0, endRow: r1, endCol: c1, type: "cells" }) as never;

beforeEach(() => {
  h.pasteComments.mockReset();
  h.alert.mockReset();
  h.alert.mockResolvedValue(undefined);
  h.pasteComments.mockResolvedValue({ pasted: 2, removed: 1, skipped: 0, firstSkip: null });
});

describe("Paste Special > Comments is one call (BUG-0725)", () => {
  // SABOTAGE (obj4-pcf): send the batch only when it holds comments (drop
  // the `commentClears` half) -- fails at the cleared destination.
  it("A1:A3 pasted at C1: ONE pasteComments: C1 and C2 pasted, C3 cleared", async () => {
    const opts = { pasteAttribute: "comments", operation: "none", skipBlanks: false, transpose: false } as const;
    expect(await executePasteSpecial(COPY, sel(0, 2, 0, 2), opts, 1000, 100)).toBe(true);
    expect(h.pasteComments).toHaveBeenCalledTimes(1);
    const [comments, cleared] = h.pasteComments.mock.calls[0] as [Array<{ row: number; col: number; content: string }>, number[][]];
    expect(comments.map((c) => [c.row, c.col, c.content])).toEqual([[0, 2, "src-A1"], [1, 2, "src-A2"]]);
    expect(cleared).toEqual([[2, 2]]);
  });

  it("a destination holding a Note is reported as skipped", async () => {
    h.pasteComments.mockResolvedValue({ pasted: 1, removed: 0, skipped: 1, firstSkip: "Cell already has a Note. Delete or convert it first." });
    const opts = { pasteAttribute: "comments", operation: "none", skipBlanks: false, transpose: false } as const;
    await executePasteSpecial(COPY, sel(0, 2, 0, 2), opts, 1000, 100);
    expect(String(h.alert.mock.calls[0]?.[0])).toContain("Note");
  });
});
