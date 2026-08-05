//! FILENAME: app/src/api/scriptHost/__tests__/rangeClipboard.test.ts
// PURPOSE: Behavioural cover for the G4 executors that a policy test cannot
//          reach — what copyRange actually captures, what pasteRange actually
//          writes, and what setCellFormula actually sends to the grid.
// CONTEXT: The helpers take their `lib` facade as a PARAMETER, so they can be
//          driven here with a recording stub instead of a live worker realm
//          (jsdom has no Worker). Everything asserted below is a way this
//          feature could corrupt a workbook rather than merely fail:
//            - pasting a formatted display string back as text ("1 234,50 kr");
//            - shifting a whole block by one delta, so a transposed paste points
//              at the wrong cells;
//            - carrying formatting into a "values only" paste;
//            - writing an R1C1 string into the grid without converting it;
//            - pasting into a .calp writeback region behind the schema.

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../grid", () => ({
  convertFormulaStyle: vi.fn(
    async (formula: string, from: string, to: string, row: number, col: number) =>
      `<${from}->${to} @${row},${col}: ${formula}>`,
  ),
  refreshGridData: vi.fn(),
  refreshGridDimensions: vi.fn(),
}));

vi.mock("../writebackWriteGuard", () => ({
  captureWritebackWrite: vi.fn(async () => false),
  captureWritebackWrites: vi.fn(async (_id: string, writes: unknown[]) => ({
    plain: [...(writes as Array<{ sheetIndex: number; row: number; col: number; value: string }>)],
    drafted: [],
  })),
  workbookHasWritebackRegions: vi.fn(async () => false),
}));

import {
  clearScriptClipboard,
  copyRangeToScriptClipboard,
  pasteScriptClipboard,
  scriptClipboardSize,
  writeCellFormula,
  readCellFormula,
} from "../host";
import { captureWritebackWrites } from "../writebackWriteGuard";
import { convertFormulaStyle } from "../../grid";

const SCRIPT = "clipboard-test-script";

interface TypedCell {
  row: number;
  col: number;
  value: number | string | boolean | null;
  display: string;
  formula: string | null;
  type: string;
}
interface StyledCell {
  row: number;
  col: number;
  styleIndex: number;
}
type Update = { row: number; col: number; value: string; styleIndex?: number; invariant?: boolean };

/** A recording stand-in for the @api/lib facade — only the members these
 *  helpers touch, so an accidental new backend call fails loudly here. */
function makeLib(opts: { typed?: TypedCell[]; styled?: StyledCell[] } = {}) {
  const updates: Update[] = [];
  const singles: Array<{ row: number; col: number; value: string }> = [];
  const shiftCalls: Array<{ formula: string; rowDelta: number; colDelta: number }> = [];
  const lib = {
    getActiveSheet: vi.fn(async () => 0),
    // Sheet-ref resolution (Wave 1) reads the live list: five sheets so a test
    // can name an EXISTING non-active sheet and hit the active-sheet refusal
    // rather than the unknown-sheet one.
    getSheets: vi.fn(async () => ({
      sheets: [0, 1, 2, 3, 4].map((i) => ({ index: i, name: `Sheet${i + 1}` })),
      activeIndex: 0,
    })),
    getRangeCellsTyped: vi.fn(async () => opts.typed ?? []),
    getViewportCells: vi.fn(async () => opts.styled ?? []),
    getUndoState: vi.fn(async () => ({ transactionOpen: false })),
    beginUndoTransaction: vi.fn(async () => undefined),
    commitUndoTransaction: vi.fn(async () => undefined),
    cancelUndoTransaction: vi.fn(async () => undefined),
    shiftFormulasBatch: vi.fn(
      async (inputs: Array<{ formula: string; rowDelta: number; colDelta: number }>) => {
        shiftCalls.push(...inputs);
        return inputs.map((i) => `${i.formula}|shifted(${i.rowDelta},${i.colDelta})`);
      },
    ),
    updateCellsBatch: vi.fn(async (u: Update[]) => {
      updates.push(...u);
      return [];
    }),
    updateCell: vi.fn(async (row: number, col: number, value: string) => {
      singles.push({ row, col, value });
      return null;
    }),
    updateCellOnSheets: vi.fn(async () => undefined),
  };
  return { lib, updates, singles, shiftCalls };
}

/** Two rows x two columns anchored at (0,0): a number, a formula, a text, blank. */
function sampleSource() {
  return makeLib({
    typed: [
      { row: 0, col: 0, value: 1234.5, display: "1 234,50 kr", formula: null, type: "number" },
      { row: 0, col: 1, value: 7, display: "7", formula: "=A1*2", type: "number" },
      { row: 1, col: 0, value: "North", display: "North", formula: null, type: "text" },
    ],
    styled: [
      { row: 0, col: 0, styleIndex: 5 },
      { row: 0, col: 1, styleIndex: 6 },
      { row: 1, col: 0, styleIndex: 7 },
      // A style-only cell: no value, no formula, but it carries formatting.
      { row: 1, col: 1, styleIndex: 9 },
    ],
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asLib = (l: unknown) => l as any;

beforeEach(() => {
  clearScriptClipboard();
  vi.clearAllMocks();
});

// ============================================================================
// copyRange
// ============================================================================

describe("copyRange captures both halves of a cell", () => {
  it("reads the typed cells AND the style indexes, and reports the size", async () => {
    const { lib } = sampleSource();
    const size = await copyRangeToScriptClipboard(asLib(lib), SCRIPT, undefined, 0, 0, 1, 1);
    expect(size).toEqual({ rows: 2, cols: 2 });
    // Two reads, one rectangle: neither shape alone can express a paste.
    expect(lib.getRangeCellsTyped).toHaveBeenCalledWith(0, 0, 1, 1);
    expect(lib.getViewportCells).toHaveBeenCalledWith(0, 0, 1, 1);
    expect(scriptClipboardSize(SCRIPT)).toEqual({ rows: 2, cols: 2 });
  });

  it("refuses another sheet rather than silently copying the active one", async () => {
    const { lib } = sampleSource();
    lib.getActiveSheet.mockResolvedValue(0);
    await expect(
      copyRangeToScriptClipboard(asLib(lib), SCRIPT, 3, 0, 0, 1, 1),
    ).rejects.toThrow(/can only target the active sheet/);
    expect(lib.getRangeCellsTyped).not.toHaveBeenCalled();
  });

  it("refuses a rectangle over the bulk ceiling", async () => {
    const { lib } = sampleSource();
    await expect(
      copyRangeToScriptClipboard(asLib(lib), SCRIPT, undefined, 0, 0, 999_999, 999_999),
    ).rejects.toThrow(/range too large/);
  });

  it("belongs to ONE script: another script's buffer is untouched", async () => {
    const { lib } = sampleSource();
    await copyRangeToScriptClipboard(asLib(lib), SCRIPT, undefined, 0, 0, 1, 1);
    expect(scriptClipboardSize("some-other-script")).toBeNull();
    clearScriptClipboard(SCRIPT);
    expect(scriptClipboardSize(SCRIPT)).toBeNull();
  });
});

// ============================================================================
// pasteRange
// ============================================================================

describe("pasteRange writes what a user's Ctrl+V would write", () => {
  it("refuses when nothing was copied, instead of clearing the destination", async () => {
    const { lib, updates } = sampleSource();
    await expect(pasteScriptClipboard(asLib(lib), SCRIPT, 10, 0, {})).rejects.toThrow(
      /nothing to paste/,
    );
    expect(updates).toEqual([]);
  });

  it("mode 'all' carries value, formula and formatting", async () => {
    const src = sampleSource();
    await copyRangeToScriptClipboard(asLib(src.lib), SCRIPT, undefined, 0, 0, 1, 1);
    const dst = sampleSource();
    const size = await pasteScriptClipboard(asLib(dst.lib), SCRIPT, 10, 0, {});
    expect(size).toEqual({ rows: 2, cols: 2 });

    const at = (r: number, c: number) => dst.updates.find((u) => u.row === r && u.col === c)!;
    // The number goes back INVARIANT — never as its formatted display text,
    // which on a sv-SE workbook would store "1 234,50 kr" as a string.
    expect(at(10, 0).value).toBe("1234.5");
    expect(at(10, 0).invariant).toBe(true);
    expect(at(10, 0).styleIndex).toBe(5);
    // The formula travels shifted, not evaluated.
    expect(at(10, 1).value).toBe("=A1*2|shifted(10,0)");
    expect(at(10, 1).styleIndex).toBe(6);
    expect(at(11, 0).value).toBe("North");
    // A style-only source cell still carries its formatting.
    expect(at(11, 1).styleIndex).toBe(9);
  });

  it("mode 'values' drops BOTH the formulas and the formatting", async () => {
    const src = sampleSource();
    await copyRangeToScriptClipboard(asLib(src.lib), SCRIPT, undefined, 0, 0, 1, 1);
    const dst = sampleSource();
    await pasteScriptClipboard(asLib(dst.lib), SCRIPT, 10, 0, { mode: "values" });
    expect(dst.lib.shiftFormulasBatch).not.toHaveBeenCalled();
    for (const u of dst.updates) expect(u.styleIndex).toBeUndefined();
    // The formula cell pastes its RESULT (7), not "=A1*2".
    const formulaCell = dst.updates.find((u) => u.row === 10 && u.col === 1)!;
    expect(formulaCell.value).toBe("7");
    expect(formulaCell.invariant).toBe(true);
  });

  it("mode 'formulas' keeps the formulas and drops the formatting", async () => {
    const src = sampleSource();
    await copyRangeToScriptClipboard(asLib(src.lib), SCRIPT, undefined, 0, 0, 1, 1);
    const dst = sampleSource();
    await pasteScriptClipboard(asLib(dst.lib), SCRIPT, 10, 0, { mode: "formulas" });
    const formulaCell = dst.updates.find((u) => u.row === 10 && u.col === 1)!;
    expect(formulaCell.value).toBe("=A1*2|shifted(10,0)");
    for (const u of dst.updates) expect(u.styleIndex).toBeUndefined();
  });

  it("gives EVERY formula its own delta, which is what makes transpose correct", async () => {
    const src = makeLib({
      typed: [
        { row: 0, col: 0, value: 1, display: "1", formula: "=Z1", type: "number" },
        { row: 0, col: 1, value: 2, display: "2", formula: "=Z2", type: "number" },
      ],
      styled: [],
    });
    await copyRangeToScriptClipboard(asLib(src.lib), SCRIPT, undefined, 0, 0, 0, 1);
    const dst = sampleSource();
    const size = await pasteScriptClipboard(asLib(dst.lib), SCRIPT, 5, 5, { transpose: true });
    // A 1x2 block transposed is 2x1.
    expect(size).toEqual({ rows: 2, cols: 1 });
    // (0,0) -> (5,5): delta (5,5). (0,1) -> (6,5): delta (6,4). One block-wide
    // delta would have aimed the second formula at the wrong cell.
    expect(dst.shiftCalls).toEqual([
      { formula: "=Z1", rowDelta: 5, colDelta: 5 },
      { formula: "=Z2", rowDelta: 6, colDelta: 4 },
    ]);
  });

  it("clears the destination where the source was blank — unless skipBlanks", async () => {
    const src = makeLib({
      typed: [{ row: 0, col: 0, value: 1, display: "1", formula: null, type: "number" }],
      styled: [],
    });
    await copyRangeToScriptClipboard(asLib(src.lib), SCRIPT, undefined, 0, 0, 0, 1);

    const clearing = sampleSource();
    await pasteScriptClipboard(asLib(clearing.lib), SCRIPT, 3, 0, {});
    expect(clearing.updates).toHaveLength(2);
    expect(clearing.updates.find((u) => u.col === 1)!.value).toBe("");

    const skipping = sampleSource();
    await pasteScriptClipboard(asLib(skipping.lib), SCRIPT, 3, 0, { skipBlanks: true });
    expect(skipping.updates).toHaveLength(1);
    expect(skipping.updates[0].col).toBe(0);
  });

  it("does not shift a formula pasted onto its own position", async () => {
    const src = makeLib({
      typed: [{ row: 2, col: 2, value: 1, display: "1", formula: "=A1", type: "number" }],
      styled: [],
    });
    await copyRangeToScriptClipboard(asLib(src.lib), SCRIPT, undefined, 2, 2, 2, 2);
    const dst = sampleSource();
    await pasteScriptClipboard(asLib(dst.lib), SCRIPT, 2, 2, {});
    expect(dst.lib.shiftFormulasBatch).not.toHaveBeenCalled();
    expect(dst.updates[0].value).toBe("=A1");
  });

  it("lands as ONE undo entry", async () => {
    const src = sampleSource();
    await copyRangeToScriptClipboard(asLib(src.lib), SCRIPT, undefined, 0, 0, 1, 1);
    const dst = sampleSource();
    await pasteScriptClipboard(asLib(dst.lib), SCRIPT, 10, 0, {});
    expect(dst.lib.beginUndoTransaction).toHaveBeenCalledTimes(1);
    expect(dst.lib.commitUndoTransaction).toHaveBeenCalledTimes(1);
    expect(dst.lib.updateCellsBatch).toHaveBeenCalledTimes(1);
  });

  it("sends every destination cell through the .calp writeback draft gate", async () => {
    const src = sampleSource();
    await copyRangeToScriptClipboard(asLib(src.lib), SCRIPT, undefined, 0, 0, 1, 1);
    const dst = sampleSource();
    await pasteScriptClipboard(asLib(dst.lib), SCRIPT, 10, 0, {});
    expect(captureWritebackWrites).toHaveBeenCalledTimes(1);
    const [scriptId, writes] = vi.mocked(captureWritebackWrites).mock.calls[0];
    expect(scriptId).toBe(SCRIPT);
    expect(writes).toHaveLength(4);
  });

  it("writes a DRAFTED writeback cell on its own, because the batch drops it", async () => {
    const src = sampleSource();
    await copyRangeToScriptClipboard(asLib(src.lib), SCRIPT, undefined, 0, 0, 1, 1);
    vi.mocked(captureWritebackWrites).mockResolvedValueOnce({
      plain: [{ sheetIndex: 0, row: 10, col: 0, value: "1234.5" }],
      drafted: [{ sheetIndex: 0, row: 10, col: 1, value: "=A1*2|shifted(10,0)" }],
    } as never);
    const dst = sampleSource();
    await pasteScriptClipboard(asLib(dst.lib), SCRIPT, 10, 0, {});
    expect(dst.updates.map((u) => `${u.row},${u.col}`)).toEqual(["10,0"]);
    expect(dst.singles).toEqual([{ row: 10, col: 1, value: "=A1*2|shifted(10,0)" }]);
  });

  it("refuses a paste aimed at another sheet", async () => {
    const src = sampleSource();
    await copyRangeToScriptClipboard(asLib(src.lib), SCRIPT, undefined, 0, 0, 1, 1);
    const dst = sampleSource();
    await expect(
      pasteScriptClipboard(asLib(dst.lib), SCRIPT, 10, 0, { sheetIndex: 4 }),
    ).rejects.toThrow(/can only target the active sheet/);
    expect(dst.updates).toEqual([]);
  });
});

// ============================================================================
// Formula authoring
// ============================================================================

describe("setCellFormula always writes a FORMULA, converted from the style given", () => {
  it("adds the leading = when the caller omitted it", async () => {
    const { lib } = sampleSource();
    await writeCellFormula(asLib(lib), SCRIPT, undefined, 4, 2, "SUM(A1:A3)", undefined);
    expect(lib.updateCellsBatch).toHaveBeenCalledWith([
      { row: 4, col: 2, value: "=SUM(A1:A3)" },
    ]);
  });

  it("converts R1C1 relative to the TARGET CELL before writing", async () => {
    const { lib } = sampleSource();
    await writeCellFormula(asLib(lib), SCRIPT, undefined, 7, 3, "=RC[-1]*2", "R1C1");
    // The base is (7, 3) — the cell being written — not the active cell, and
    // not anything derived from the user's View setting.
    expect(convertFormulaStyle).toHaveBeenCalledWith("=RC[-1]*2", "R1C1", "A1", 7, 3);
    expect(lib.updateCellsBatch).toHaveBeenCalledWith([
      { row: 7, col: 3, value: "<R1C1->A1 @7,3: =RC[-1]*2>" },
    ]);
  });

  it("does not convert when the caller is speaking A1", async () => {
    const { lib } = sampleSource();
    await writeCellFormula(asLib(lib), SCRIPT, undefined, 1, 1, "=B2+1", "A1");
    expect(convertFormulaStyle).not.toHaveBeenCalled();
    expect(lib.updateCellsBatch).toHaveBeenCalledWith([{ row: 1, col: 1, value: "=B2+1" }]);
  });

  it("clears the cell for null, and for an empty string", async () => {
    const { lib } = sampleSource();
    await writeCellFormula(asLib(lib), SCRIPT, undefined, 2, 2, null, undefined);
    await writeCellFormula(asLib(lib), SCRIPT, undefined, 2, 3, "   ", undefined);
    expect(lib.updateCellsBatch).toHaveBeenNthCalledWith(1, [{ row: 2, col: 2, value: "" }]);
    expect(lib.updateCellsBatch).toHaveBeenNthCalledWith(2, [{ row: 2, col: 3, value: "" }]);
  });

  it("goes through the writeback draft gate like any other script write", async () => {
    const { lib } = sampleSource();
    await writeCellFormula(asLib(lib), SCRIPT, undefined, 0, 0, "=1+1", undefined);
    expect(captureWritebackWrites).toHaveBeenCalledTimes(1);
  });
});

describe("getCellFormula answers null where the grid withholds a formula", () => {
  it("returns the A1 formula unchanged by default", async () => {
    const { lib } = sampleSource();
    lib.getRangeCellsTyped.mockResolvedValueOnce([
      { row: 0, col: 1, value: 7, display: "7", formula: "=A1*2", type: "number" },
    ]);
    await expect(readCellFormula(asLib(lib), undefined, 0, 1, undefined)).resolves.toBe("=A1*2");
    expect(convertFormulaStyle).not.toHaveBeenCalled();
  });

  it("converts to R1C1 relative to the cell it read", async () => {
    const { lib } = sampleSource();
    lib.getRangeCellsTyped.mockResolvedValueOnce([
      { row: 4, col: 6, value: 7, display: "7", formula: "=A1*2", type: "number" },
    ]);
    await expect(readCellFormula(asLib(lib), undefined, 4, 6, "R1C1")).resolves.toBe(
      "<A1->R1C1 @4,6: =A1*2>",
    );
  });

  it("answers null for a plain value — and never leaks a hidden formula", async () => {
    const { lib } = sampleSource();
    // A protected sheet with hidden formulas makes the typed read return no
    // formula; this must stay null rather than reconstructing one.
    lib.getRangeCellsTyped.mockResolvedValueOnce([
      { row: 0, col: 0, value: 5, display: "5", formula: null, type: "number" },
    ]);
    await expect(readCellFormula(asLib(lib), undefined, 0, 0, "R1C1")).resolves.toBeNull();
    expect(convertFormulaStyle).not.toHaveBeenCalled();
  });
});
