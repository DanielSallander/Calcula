//! FILENAME: app/extensions/BuiltIn/PasteSpecial/__tests__/pasteValidationAnchor.test.ts
// PURPOSE: Paste Validation restates a copied rule for the pasted block, and
//          removes the destination's rule where the copied cell has none --
//          Excel's behaviour (wave-3 verifier, backmisc; BUG-0725 follow-up).
// CONTEXT: [LIVE, Excel 16, 2026-11-06, lane obj4 v1.ps1] a custom rule
//          `=A1>0` on A1:A10 (stored for A1): A5:A6 pasted with Paste Special >
//          Validation at C1 reads `=C1>0` at C1 and `=C2>0` at C2; a list
//          `=G1:H1` on E1:E10, E5 pasted at J20, lists `=L20:M20`; Z1 (no rule)
//          pasted over A3 leaves A3 with NO rule. A rule is stored for its
//          range's top-left, so the paste moves it by (the pasted block's
//          top-left - the source range's top-left). The batch (BUG-0725) sent
//          the stored text over the pasted block unmoved: a copy that began
//          inside the source range validated against the wrong cells, and a
//          no-rule cell kept the destination's rule.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  setDV: vi.fn(),
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

const custom = { rule: { custom: { formula: "=A1>0" } }, errorAlert: {}, prompt: {}, ignoreBlanks: true };
const list = {
  rule: {
    list: {
      source: {
        range: {
          sheetIndex: 0,
          startRow: 0,
          startCol: 6,
          endRow: 0,
          endCol: 7,
          relative: { startRow: true, startCol: true, endRow: true, endCol: true },
        },
      },
      inCellDropdown: true,
    },
  },
  errorAlert: {},
  prompt: {},
  ignoreBlanks: true,
};

/** A copy of `rows` x 1 cells starting at (r0, c0) of Sheet1, each with `rule` (or none). */
function copyOf(r0: number, c0: number, rules: unknown[]): never {
  const validations = new Map<string, unknown>();
  rules.forEach((v, r) => {
    if (v) validations.set(`${r},0`, v);
  });
  const cells = rules.map((_, r) => [{ row: r0 + r, col: c0, display: "", formula: null, styleIndex: 0 }]);
  return {
    cells,
    values: rules.map(() => [null]),
    sourceSelection: { startRow: r0, startCol: c0, endRow: r0 + rules.length - 1, endCol: c0, type: "cells" },
    sourceRows: rules.map((_, r) => r0 + r),
    isCut: false,
    sourceSheetIndex: 0,
    sourceSheetName: "Sheet1",
    sourceSheetId: "sheet-a",
    text: "",
    validations,
  } as never;
}

const sel = (r0: number, c0: number, r1: number, c1: number) =>
  ({ startRow: r0, startCol: c0, endRow: r1, endCol: c1, type: "cells" }) as never;

const VALIDATION = { pasteAttribute: "validation", operation: "none", skipBlanks: false, transpose: false } as const;

beforeEach(() => {
  for (const fn of [h.setDV, h.clearDV, h.alert]) fn.mockReset();
  h.setDV.mockResolvedValue({ success: true, validation: null, error: null });
  h.clearDV.mockResolvedValue({ success: true, validation: null, error: null });
  h.alert.mockResolvedValue(undefined);
  h.ranges = [
    { startRow: 0, startCol: 0, endRow: 9, endCol: 0, validation: custom },
    { startRow: 0, startCol: 4, endRow: 9, endCol: 4, validation: list },
  ];
});

describe("Paste Validation restates the copied rule for the pasted block (Excel [LIVE])", () => {
  // SABOTAGE (obj4-pv): pass `group.validation` to setDataValidation instead
  // of the moved rule -- fails with `=A1>0`.
  it("A5:A6 of a rule on A1:A10, pasted at C1, validates C1 against itself: =C1>0", async () => {
    expect(await executePasteSpecial(copyOf(4, 0, [custom, custom]), sel(0, 2, 0, 2), VALIDATION, 1000, 100)).toBe(true);
    expect(h.setDV).toHaveBeenCalledTimes(1);
    const [r0, c0, r1, c1, rule] = h.setDV.mock.calls[0] as [number, number, number, number, { rule: { custom: { formula: string } } }];
    expect([r0, c0, r1, c1]).toEqual([0, 2, 1, 2]);
    expect(rule.rule.custom.formula).toBe("=C1>0");
  });

  it("a relative list source moves by the same offset: E5 of =G1:H1 on E1:E10 at J20 lists L20:M20", async () => {
    await executePasteSpecial(copyOf(4, 4, [list]), sel(19, 9, 19, 9), VALIDATION, 1000, 100);
    const range = (h.setDV.mock.calls[0][4] as typeof list).rule.list.source.range;
    expect([range.startRow, range.startCol, range.endRow, range.endCol]).toEqual([19, 11, 19, 12]);
  });

  // SABOTAGE (obj4-pvc): drop the `validationClears.push` -- fails here.
  it("a copied cell with NO rule removes the destination's rule, one call for the block", async () => {
    h.ranges = [];
    await executePasteSpecial(copyOf(0, 25, [null, null]), sel(2, 0, 2, 0), VALIDATION, 1000, 100);
    expect(h.clearDV.mock.calls).toEqual([[2, 0, 3, 0]]);
    expect(h.setDV).not.toHaveBeenCalled();
  });

  it("a rule whose source range is no longer found is pasted as written (the old behaviour)", async () => {
    h.ranges = [];
    await executePasteSpecial(copyOf(4, 0, [custom]), sel(0, 2, 0, 2), VALIDATION, 1000, 100);
    expect((h.setDV.mock.calls[0][4] as typeof custom).rule.custom.formula).toBe("=A1>0");
  });
});
