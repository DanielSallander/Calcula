//! FILENAME: app/src/core/hooks/__tests__/clipboardPastesStoredValues.test.tsx
// PURPOSE: Copy + Paste of a CONSTANT pastes the source's STORED value, never
//          its display text re-typed -- through the REAL clipboard hook.
// CONTEXT: Bug-ledger fix programme, round 4 (NEW-paste-by-display-text). The
//          copy captured `CellData`, whose only value is the formatted
//          display, and the paste wrote `formula ?? display` through the
//          typed-entry ladder: 1.23456 shown under 0.00 pasted as 1.23,
//          1234567890123456 under General ("1.23457E+15") lost ten digits,
//          "5,50 kr" and a date the parser does not read came back as TEXT,
//          and a number from a Text-formatted (@) cell was stored as text.
//          Excel, measured live through COM (2026-10-29), pastes the stored
//          value in every one of these cases (Paste and Cut + Paste of
//          1.23456 under 0.00 -> 1.23456; the text '00123 -> the text 00123;
//          the number 5 from an @ cell -> the number 5 with @; TRUE -> TRUE;
//          #N/A -> the error). Text from ANOTHER program keeps the ladder
//          (that is typing). Also pinned: Ctrl+V of external text taller than
//          a spread argument list (200,000 lines) pastes (BUG-0346).
//          The backend and the Tauri clipboard plugin are doubles.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

type Kind = "number" | "text" | "boolean" | "error" | "empty";
interface ModelCell {
  display: string;
  formula: string | null;
  styleIndex: number;
  type: Kind;
  value: number | string | boolean | null;
}

/** The sheet the doubles serve: "row,col" -> cell. A missing key is an EMPTY cell. */
const model = vi.hoisted(() => ({
  cells: new Map<string, ModelCell>(),
  failTyped: false,
  /** Style index -> number format (anything absent is General). */
  formats: new Map<number, string>(),
}));

const sys = vi.hoisted(() => ({ text: null as string | null, written: [] as string[] }));

const api = vi.hoisted(() => ({
  updateCellsBatch: vi.fn(async (_u: unknown[], _o?: unknown) => [] as unknown[]),
  applyFormatting: vi.fn(async (_r: number[], _c: number[], _f: unknown, _o?: unknown) => ({ cells: [], styles: [] })),
  getStyle: vi.fn(async (index: number) => ({ numberFormat: model.formats.get(index) ?? "General" })),
  getRangeCellsTyped: vi.fn(async (r0: number, c0: number, r1: number, c1: number) => {
    if (model.failTyped) throw new Error("typed read refused");
    const out: unknown[] = [];
    for (const [key, cell] of model.cells) {
      const [row, col] = key.split(",").map(Number);
      if (row < r0 || row > r1 || col < c0 || col > c1) continue;
      out.push({ row, col, value: cell.value, display: cell.display, formula: cell.formula, type: cell.type });
    }
    return out;
  }),
  clearCell: vi.fn(async () => {}),
  updateCell: vi.fn(async (_row: number, _col: number, _value: string) => ({ cells: [], dimensionChanges: [] })),
}));

/** Every cell of the model in rows r0..r1 (or, `byCol`, cols r0..r1), as the sparse reads answer. */
function sparse(r0: number, r1: number, byCol = false): unknown[] {
  const out: unknown[] = [];
  for (const key of model.cells.keys()) {
    const [row, col] = key.split(",").map(Number);
    const at = byCol ? col : row;
    if (at >= r0 && at <= r1) out.push(cellData(row, col));
  }
  return out;
}

function cellData(row: number, col: number): unknown {
  const cell = model.cells.get(`${row},${col}`);
  return cell ? { row, col, display: cell.display, formula: cell.formula, styleIndex: cell.styleIndex } : null;
}

vi.mock("../../lib/tauri-api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  beginUndoTransaction: vi.fn(async () => 7),
  commitUndoTransaction: vi.fn(async () => {}),
  cancelUndoTransaction: vi.fn(async () => {}),
  // A cut's paste marks the point it is taken back to when the move cannot
  // finish (round 8, rev6A#5): the door joins the paste's step 7.
  beginUndoSavepoint: vi.fn(async () => ({ ticket: null, savepoint: { transaction: 7, changes: 0 } })),
  rollBackToUndoSavepoint: vi.fn(async () => ({ success: true })),
  updateCellsBatch: (u: unknown[], o?: unknown) => api.updateCellsBatch(u, o),
  applyFormatting: (r: number[], c: number[], f: unknown, o?: unknown) => api.applyFormatting(r, c, f, o),
  getStyle: (i: number) => api.getStyle(i),
  getRangeCellsTyped: (r0: number, c0: number, r1: number, c1: number) => api.getRangeCellsTyped(r0, c0, r1, c1),
  getCell: vi.fn(async (row: number, col: number) => cellData(row, col)),
  getViewportCells: vi.fn(async (r0: number, c0: number, r1: number, c1: number) => {
    const out: unknown[] = [];
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const cell = cellData(r, c);
        if (cell) out.push(cell);
      }
    }
    return out;
  }),
  getAllComments: vi.fn(async () => []),
  getAllDataValidations: vi.fn(async () => []),
  getCellsInRows: vi.fn(async (r0: number, r1: number) => sparse(r0, r1)),
  getCellsInCols: vi.fn(async (c0: number, c1: number) => sparse(c0, c1, true)),
  hasContentInRange: vi.fn(async () => false),
  clearRange: vi.fn(async () => 0),
  relocateCellReferences: vi.fn(async () => []),
  updateCell: (row: number, col: number, value: string) => api.updateCell(row, col, value),
  clearCell: () => api.clearCell(),
  setCellStyle: vi.fn(async () => null),
  shiftFormulasBatch: vi.fn(async (inputs: { formula: string; rowDelta: number; colDelta: number }[]) =>
    // A shifted formula says by how much, so a test sees that it was shifted.
    inputs.map((i) => (i.rowDelta || i.colDelta ? i.formula + "@" + i.rowDelta + "," + i.colDelta : i.formula)),
  ),
  getCollectionTexts: vi.fn(async () => []),
  getComment: vi.fn(async () => null),
  getDataValidation: vi.fn(async () => null),
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  readText: vi.fn(async () => sys.text),
  writeText: vi.fn(async (t: string) => {
    sys.written.push(t);
  }),
  writeHtml: vi.fn(async (_html: string, t: string) => {
    sys.written.push(t);
  }),
}));

vi.mock("../../lib/dialogs", () => ({
  alertAsync: vi.fn(async () => {}),
  confirmAsync: vi.fn(async () => true),
}));

import { useClipboard, getInternalClipboard, type UseClipboardReturn } from "../useClipboard";
import { GridProvider, useGridContext } from "../../state/GridContext";
import { setSelection } from "../../state/gridActions";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let hook: UseClipboardReturn;
let dispatchOut: ReturnType<typeof useGridContext>["dispatch"];

function Harness(): React.ReactElement {
  const { dispatch } = useGridContext();
  dispatchOut = dispatch;
  hook = useClipboard();
  return <div />;
}

let root: Root;
let host: HTMLDivElement;

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function select(r0: number, c0: number, r1 = r0, c1 = c0): Promise<void> {
  await act(async () => {
    dispatchOut(setSelection({ startRow: r0, startCol: c0, endRow: r1, endCol: c1, type: "cells" }));
  });
  await settle();
}

type Update = { row: number; col: number; value: string; styleIndex?: number; invariant?: boolean };

/** Every update of the paste's FIRST batch (the one that writes the pasted cells). */
function firstBatch(): Update[] {
  return (api.updateCellsBatch.mock.calls[0]?.[0] ?? []) as Update[];
}

/** Copy (or cut) row 0, cols 0..n-1, and paste it at row 5, col 0, with the clipboard still Calcula's. */
async function copyAndPaste(width: number, cut = false): Promise<void> {
  await select(0, 0, 0, width - 1);
  await act(async () => {
    if (cut) await hook.cut();
    else await hook.copy();
  });
  sys.text = sys.written.at(-1) ?? null;
  api.updateCellsBatch.mockClear();
  await select(5, 0);
  await act(async () => {
    await hook.paste();
  });
  await settle();
}

function put(col: number, cell: ModelCell): void {
  model.cells.set(`0,${col}`, cell);
}

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  model.cells.clear();
  model.formats.clear();
  model.failTyped = false;
  sys.text = null;
  sys.written = [];
  for (const fn of Object.values(api)) fn.mockClear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <GridProvider>
        <Harness />
      </GridProvider>,
    );
  });
  await settle();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe("Copy + Paste writes the STORED value of a constant, invariant, in ONE batch", () => {
  it("numbers paste exactly, whatever their format showed", async () => {
    put(0, { display: "1.23", formula: null, styleIndex: 4, type: "number", value: 1.23456 }); // 0.00
    put(1, { display: "1.23457E+15", formula: null, styleIndex: 0, type: "number", value: 1234567890123456 });
    put(2, { display: "3.1415926536", formula: null, styleIndex: 0, type: "number", value: 3.14159265358979 });
    put(3, { display: "5,50 kr", formula: null, styleIndex: 6, type: "number", value: 5.5 });
    put(4, { display: "50%", formula: null, styleIndex: 7, type: "number", value: 0.5 });
    put(5, { display: "2020-06-01", formula: null, styleIndex: 8, type: "number", value: 43983 });
    await copyAndPaste(6);

    expect(api.updateCellsBatch, "a paste is ONE batch write").toHaveBeenCalledTimes(1);
    // Each write names its SOURCE cell too (BUG-0657, round C): the backend
    // writes what the source holds at the write, `value` is the fallback.
    expect(firstBatch(), "a constant was re-typed from its display text").toEqual([
      { row: 5, col: 0, value: "1.23456", styleIndex: 4, invariant: true, pasted: true, source: { sheetIndex: 0, row: 0, col: 0 } },
      { row: 5, col: 1, value: "1234567890123456", styleIndex: 0, invariant: true, pasted: true, source: { sheetIndex: 0, row: 0, col: 1 } },
      { row: 5, col: 2, value: "3.14159265358979", styleIndex: 0, invariant: true, pasted: true, source: { sheetIndex: 0, row: 0, col: 2 } },
      { row: 5, col: 3, value: "5.5", styleIndex: 6, invariant: true, pasted: true, source: { sheetIndex: 0, row: 0, col: 3 } },
      { row: 5, col: 4, value: "0.5", styleIndex: 7, invariant: true, pasted: true, source: { sheetIndex: 0, row: 0, col: 4 } },
      { row: 5, col: 5, value: "43983", styleIndex: 8, invariant: true, pasted: true, source: { sheetIndex: 0, row: 0, col: 5 } },
    ]);
    // The OTHER programs still get what the cells show.
    expect(sys.written.at(-1)).toBe("1.23\t1.23457E+15\t3.1415926536\t5,50 kr\t50%\t2020-06-01");
  });

  it("text stays text (behind the ladder's verbatim escape); TRUE, an error and an empty cell keep their kind", async () => {
    put(0, { display: "00123", formula: null, styleIndex: 9, type: "text", value: "00123" });
    put(1, { display: "TRUE", formula: null, styleIndex: 0, type: "boolean", value: true });
    put(2, { display: "#N/A", formula: null, styleIndex: 0, type: "error", value: "#N/A" });
    put(3, { display: "  x  ", formula: null, styleIndex: 0, type: "text", value: "  x  " });
    // col 4 empty
    await copyAndPaste(5);
    expect(firstBatch()).toEqual([
      { row: 5, col: 0, value: "'00123", styleIndex: 9, invariant: true, pasted: true, source: { sheetIndex: 0, row: 0, col: 0 } },
      { row: 5, col: 1, value: "TRUE", styleIndex: 0, invariant: true, pasted: true, source: { sheetIndex: 0, row: 0, col: 1 } },
      { row: 5, col: 2, value: "#N/A", styleIndex: 0, invariant: true, pasted: true, source: { sheetIndex: 0, row: 0, col: 2 } },
      { row: 5, col: 3, value: "'  x  ", styleIndex: 0, invariant: true, pasted: true, source: { sheetIndex: 0, row: 0, col: 3 } },
      { row: 5, col: 4, value: "", styleIndex: 0, invariant: true, pasted: true, source: { sheetIndex: 0, row: 0, col: 4 } },
    ]);
  });

  // BUG-0616 item 7. Excel 16 [LIVE, 2026-10-30, clipexcel/probe-empty.ps1]:
  // Copy + Paste of an EMPTY cell with a red fill, bold and 0.000 onto C1
  // holding 42 leaves C1 EMPTY, red, bold and 0.000; an empty UNFORMATTED cell
  // pasted onto a green C2 holding 43 leaves it empty with no fill; Cut + Paste
  // of the empty formatted cell onto E1 (7) does the same and takes the fill
  // off A1. The paste writes each position's value -- "" clears -- WITH its
  // look: the source's style, or 0 for a cell that has none (the backend keeps
  // a blank with a named style as an empty cell of that style, BUG-0598,
  // format_home_tests.rs `a_pasted_or_filled_plain_cell_stays_plain_in_a_formatted_row`).
  it("an EMPTY formatted cell pastes its format and clears the destination's value; an unformatted one clears both", async () => {
    put(0, { display: "", formula: null, styleIndex: 12, type: "empty", value: null });
    // col 1: no cell at all.
    await copyAndPaste(2);
    expect(firstBatch(), "an empty position dropped its format, or kept the destination's value").toEqual([
      { row: 5, col: 0, value: "", styleIndex: 12, invariant: true, pasted: true, source: { sheetIndex: 0, row: 0, col: 0 } },
      { row: 5, col: 1, value: "", styleIndex: 0, invariant: true, pasted: true, source: { sheetIndex: 0, row: 0, col: 1 } },
    ]);
  });

  it("Cut + Paste of an empty formatted cell moves its format the same way", async () => {
    put(0, { display: "", formula: null, styleIndex: 12, type: "empty", value: null });
    await copyAndPaste(1, true);
    // `moved` (round 16): a cut's write is a MOVE, so a protected sheet without
    // Format Cells still lands its format, as Excel moves it. Round 18: the
    // claim names its SOURCE cell, which the backend checks holds the style.
    expect(firstBatch()).toEqual([
      { row: 5, col: 0, value: "", styleIndex: 12, invariant: true, pasted: true, moved: { sheetIndex: 0, row: 0, col: 0 }, source: { sheetIndex: 0, row: 0, col: 0, unshifted: true } },
    ]);
    expect(api.clearCell, "the cut source keeps its format (Excel takes it off)").toHaveBeenCalled();
  });

  it("a FORMULA keeps its own route: the formula (not invariant), flagged as a paste", async () => {
    put(0, { display: "2.47", formula: "=A1*2", styleIndex: 4, type: "number", value: 2.46912 });
    await copyAndPaste(1);
    expect(firstBatch()).toEqual([{ row: 5, col: 0, value: "=A1*2@5,0", styleIndex: 4, pasted: true, source: { sheetIndex: 0, row: 0, col: 0 } }]);
  });

  it("Cut + Paste moves the stored value too", async () => {
    put(0, { display: "1.23", formula: null, styleIndex: 4, type: "number", value: 1.23456 });
    await copyAndPaste(1, true);
    // Marked as a MOVE (`moved`), and the COPY above is not (round 16, rev14A
    // MAJOR): Excel moves a cut cell's format on a protected sheet whatever the
    // Format Cells option says, and drops only a copy's [LIVE].
    expect(firstBatch(), "a cut's write was not marked as a move").toEqual([
      { row: 5, col: 0, value: "1.23456", styleIndex: 4, invariant: true, pasted: true, moved: { sheetIndex: 0, row: 0, col: 0 }, source: { sheetIndex: 0, row: 0, col: 0, unshifted: true } },
    ]);
    expect(api.clearCell, "the cut source was not cleared").toHaveBeenCalled();
  });

  // Round 18: `moved` is BOUND -- each write names the source cell it came
  // from, and the backend honours the move only when that cell shows the
  // style (data.rs `honoured_move_claims`). A copy names none.
  it("each written cell of a Cut + Paste names ITS source cell", async () => {
    put(0, { display: "1", formula: null, styleIndex: 4, type: "number", value: 1 });
    put(1, { display: "2", formula: null, styleIndex: 7, type: "number", value: 2 });
    await copyAndPaste(2, true);
    expect(firstBatch().map((u) => u.moved), "a cut's write named the wrong source cell").toEqual([
      { sheetIndex: 0, row: 0, col: 0 },
      { sheetIndex: 0, row: 0, col: 1 },
    ]);
    await copyAndPaste(2);
    expect(firstBatch().map((u) => u.moved), "a COPY claimed a move").toEqual([undefined, undefined]);
  });

  it("a copy that cannot read its cells typed still copies, and its paste falls back to the display text", async () => {
    model.failTyped = true;
    put(0, { display: "1.23", formula: null, styleIndex: 4, type: "number", value: 1.23456 });
    await copyAndPaste(1);
    expect(getInternalClipboard()?.values).toBeUndefined();
    // The display text is only the fallback: the write names its source, so the
    // backend still writes the stored 1.23456 (BUG-0657).
    expect(firstBatch()).toEqual([{ row: 5, col: 0, value: "1.23", styleIndex: 4, source: { sheetIndex: 0, row: 0, col: 0 } }]);
  });

  it("text from ANOTHER program keeps the entry ladder (typing): no invariant, no style", async () => {
    put(0, { display: "1.23", formula: null, styleIndex: 4, type: "number", value: 1.23456 });
    await select(0, 0);
    await act(async () => {
      await hook.copy();
    });
    sys.text = "1,5\tabc";
    api.updateCellsBatch.mockClear();
    await select(5, 0);
    await act(async () => {
      await hook.paste();
    });
    await settle();
    expect(firstBatch()).toEqual([
      { row: 5, col: 0, value: "1,5" },
      { row: 5, col: 1, value: "abc" },
    ]);
  });
});

describe("a number or formula from a Text-formatted (@) source cell stays one", () => {
  // Round 5: every pasted formula or stored value says it is a PASTE
  // (CellUpdateInput.pasted), and the backend's ladder skips its Text rung for
  // it in the same write (commands/paste_kind_tests.rs pins the backend half).
  // Round 4 wrote such a cell, then detoured it through General and back to @.
  it("the number 5, the text '007 and =A1 from @ cells: ONE batch, each flagged pasted, no detour", async () => {
    model.formats.set(9, "@");
    put(0, { display: "5", formula: null, styleIndex: 9, type: "number", value: 5 });
    put(1, { display: "007", formula: null, styleIndex: 9, type: "text", value: "007" });
    put(2, { display: "1", formula: "=A1", styleIndex: 9, type: "number", value: 1 });
    await copyAndPaste(3);

    expect(api.updateCellsBatch, "a paste from @ cells was written more than once").toHaveBeenCalledTimes(1);
    expect(firstBatch()).toEqual([
      { row: 5, col: 0, value: "5", styleIndex: 9, invariant: true, pasted: true, source: { sheetIndex: 0, row: 0, col: 0 } },
      { row: 5, col: 1, value: "'007", styleIndex: 9, invariant: true, pasted: true, source: { sheetIndex: 0, row: 0, col: 1 } },
      { row: 5, col: 2, value: "=A1@5,0", styleIndex: 9, pasted: true, source: { sheetIndex: 0, row: 0, col: 2 } },
    ]);
    expect(api.applyFormatting).not.toHaveBeenCalled();
  });

  it("no style is ever looked up to decide a paste's kind", async () => {
    model.formats.set(9, "@");
    put(0, { display: "5", formula: null, styleIndex: 9, type: "number", value: 5 });
    put(1, { display: "1.23", formula: null, styleIndex: 4, type: "number", value: 1.23456 });
    await copyAndPaste(2);
    expect(api.updateCellsBatch).toHaveBeenCalledTimes(1);
    expect(api.getStyle).not.toHaveBeenCalled();
  });
});

describe("the copy reads its stored values in bands the backend accepts", () => {
  it("a filtered copy's values line up with its COLLAPSED rows", async () => {
    for (let r = 0; r < 5; r++) {
      model.cells.set(`${r},0`, { display: String(r), formula: null, styleIndex: 0, type: "number", value: r + 0.5 });
    }
    const { copyCellRange } = await import("../useClipboard");
    const result = await copyCellRange({ startRow: 0, startCol: 0, endRow: 4, endCol: 0, skipRows: new Set([2]) });
    expect(result.copied).toBe(true);
    const clip = getInternalClipboard()!;
    expect(clip.sourceRows).toEqual([0, 1, 3, 4]);
    expect(clip.values?.map((row) => row[0]?.value)).toEqual([0.5, 1.5, 3.5, 4.5]);
  });

  it("150,000 cells are read in typed bands of at most 100,000", async () => {
    const { copyCellRange } = await import("../useClipboard");
    await copyCellRange({ startRow: 0, startCol: 0, endRow: 49_999, endCol: 2, batchRead: true });
    const areas = api.getRangeCellsTyped.mock.calls.map(([r0, c0, r1, c1]) => (r1 - r0 + 1) * (c1 - c0 + 1));
    expect(areas.length).toBeGreaterThan(1);
    expect(Math.max(...areas)).toBeLessThanOrEqual(100_000);
    expect(areas.reduce((a, b) => a + b, 0)).toBe(150_000);
  });
});

describe("Ctrl+V of external text taller than a spread argument list (BUG-0346)", () => {
  it("200,000 lines from another program paste (the width is found by a loop)", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 200_000; i++) lines.push(i === 7 ? "a\tb\tc" : String(i));
    sys.text = lines.join("\n");
    await select(0, 0);
    await act(async () => {
      await hook.paste();
    });
    await settle();
    expect(api.updateCellsBatch, "the paste threw before it wrote").toHaveBeenCalledTimes(1);
    const updates = firstBatch();
    // 200,000 rows x the widest line (3 cells).
    expect(updates).toHaveLength(600_000);
    expect(updates.find((u) => u.row === 7 && u.col === 2)?.value).toBe("c");
  });
});

describe("a MOVE or a Ctrl+drag COPY writes a constant's stored value too (same defect, same file)", () => {
  /** Every value the gesture wrote: batch updates with their flag, and per-cell updateCell entries. */
  function writes(): Array<{ row: number; col: number; value: string; invariant?: boolean }> {
    const batched = api.updateCellsBatch.mock.calls.flatMap((c) => c[0] as Update[]);
    const single = api.updateCell.mock.calls.map(([row, col, value]) => ({ row, col, value }));
    return [...batched, ...single];
  }

  it("dragging A1:B1 to A6: 1.23456 (shown 1.23) moves exactly; the formula keeps its route", async () => {
    put(0, { display: "1.23", formula: null, styleIndex: 4, type: "number", value: 1.23456 });
    put(1, { display: "2.47", formula: "=A1*2", styleIndex: 4, type: "number", value: 2.46912 });
    await act(async () => {
      await hook.moveCells({ startRow: 0, startCol: 0, endRow: 0, endCol: 1, type: "cells" }, 5, 0);
    });
    // The moved formula is written UNSHIFTED (round 5, Excel's move): the
    // relocation re-points its =A1, which moved with it, to A6. This assertion
    // pinned the shifted "=A1*2@5,0" before; clipboardMoveRelocation.test.tsx
    // pins the move rule itself.
    // Both are PASTES (they keep their kind in an @ destination, written before
    // the cell takes the source's style), so the formula goes through the batch too.
    // ONE batch, each write carrying its MOVE claim as a Cut + Paste's does
    // (NEW-drag-move-whole-table).
    expect(writes()).toEqual([
      { row: 5, col: 0, value: "1.23456", invariant: true, pasted: true, moved: { sheetIndex: 0, row: 0, col: 0 }, source: { sheetIndex: 0, row: 0, col: 0, unshifted: true } },
      { row: 5, col: 1, value: "=A1*2", pasted: true, moved: { sheetIndex: 0, row: 0, col: 1 }, source: { sheetIndex: 0, row: 0, col: 1, unshifted: true } },
    ]);
    expect(api.updateCellsBatch).toHaveBeenCalledTimes(1);
  });

  it("Ctrl+dragging a cell copies its stored value", async () => {
    put(0, { display: "1.23457E+15", formula: null, styleIndex: 0, type: "number", value: 1234567890123456 });
    await act(async () => {
      await hook.copyCellsDrag({ startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells" }, 5, 0);
    });
    expect(writes()).toEqual([{ row: 5, col: 0, value: "1234567890123456", invariant: true, pasted: true, source: { sheetIndex: 0, row: 0, col: 0 } }]);
  });

  it("moving and Ctrl+drag-copying whole rows and columns write the stored values in one batch", async () => {
    put(0, { display: "1.23", formula: null, styleIndex: 4, type: "number", value: 1.23456 });
    put(2, { display: "00123", formula: null, styleIndex: 0, type: "text", value: "00123" });
    await act(async () => {
      await hook.moveRows(0, 0, 5);
    });
    expect(api.updateCellsBatch.mock.calls[0]?.[0]).toEqual([
      { row: 5, col: 0, value: "1.23456", invariant: true, pasted: true, source: { sheetIndex: 0, row: 0, col: 0, unshifted: true }, moved: { sheetIndex: 0, row: 0, col: 0 } },
      { row: 5, col: 2, value: "'00123", invariant: true, pasted: true, source: { sheetIndex: 0, row: 0, col: 2, unshifted: true }, moved: { sheetIndex: 0, row: 0, col: 2 } },
    ]);
    api.updateCellsBatch.mockClear();
    await act(async () => {
      await hook.copyRowsDrag(0, 0, 7);
    });
    expect(api.updateCellsBatch.mock.calls[0]?.[0]).toEqual([
      { row: 7, col: 0, value: "1.23456", invariant: true, pasted: true, source: { sheetIndex: 0, row: 0, col: 0 } },
      { row: 7, col: 2, value: "'00123", invariant: true, pasted: true, source: { sheetIndex: 0, row: 0, col: 2 } },
    ]);
    api.updateCellsBatch.mockClear();
    await act(async () => {
      await hook.moveColumns(0, 0, 9);
    });
    expect(api.updateCellsBatch.mock.calls[0]?.[0]).toEqual([
      { row: 0, col: 9, value: "1.23456", invariant: true, pasted: true, source: { sheetIndex: 0, row: 0, col: 0, unshifted: true }, moved: { sheetIndex: 0, row: 0, col: 0 } },
    ]);
    api.updateCellsBatch.mockClear();
    await act(async () => {
      await hook.copyColumnsDrag(2, 2, 11);
    });
    expect(api.updateCellsBatch.mock.calls[0]?.[0]).toEqual([{ row: 0, col: 11, value: "'00123", invariant: true, pasted: true, source: { sheetIndex: 0, row: 0, col: 2 } }]);
  });

  it("a Ctrl+drag COPY shifts a formula's relative references, as Copy + Paste does (Excel: =A1 from B1 to C2 is =B2)", async () => {
    model.cells.set("0,1", { display: "1", formula: "=A1", styleIndex: 0, type: "number", value: 1 });
    await act(async () => {
      await hook.copyCellsDrag({ startRow: 0, startCol: 1, endRow: 0, endCol: 1, type: "cells" }, 1, 2);
    });
    expect(writes()).toEqual([{ row: 1, col: 2, value: "=A1@1,1", pasted: true, source: { sheetIndex: 0, row: 0, col: 1 } }]);
    api.updateCell.mockClear();
    await act(async () => {
      await hook.copyRowsDrag(0, 0, 7);
    });
    expect(api.updateCellsBatch.mock.calls.at(-1)?.[0]).toEqual([{ row: 7, col: 1, value: "=A1@7,0", pasted: true, source: { sheetIndex: 0, row: 0, col: 1 } }]);
    await act(async () => {
      await hook.copyColumnsDrag(1, 1, 4);
    });
    expect(api.updateCellsBatch.mock.calls.at(-1)?.[0]).toEqual([{ row: 0, col: 4, value: "=A1@0,3", pasted: true, source: { sheetIndex: 0, row: 0, col: 1 } }]);
  });

  // BUG-0657 (round C): a drag move or copy names each write's SOURCE, so the
  // backend writes what it holds at the write -- but never a source the
  // gesture has already written over: a line move clears the target lines
  // before its batch reads them. A drag move writes its block in ONE batch
  // (NEW-drag-move-whole-table), whose sources the backend reads before any
  // write lands, so a drag onto its own block names EVERY source -- the one
  // inside the destination too (it was per-cell, and named only those no
  // earlier write had replaced).
  // SABOTAGE: drop the source of a write whose source lies in the destination
  // in `moveCells` -- fails at "UNNAMED"; name every source in `moveRows`
  // (drop its target-rows test) -- fails at "CLEARED".
  it("a drag onto its own block names every source in one batch; a line move none it cleared", async () => {
    model.cells.set("0,0", { display: "1", formula: null, styleIndex: 0, type: "number", value: 1 });
    model.cells.set("1,0", { display: "2", formula: null, styleIndex: 0, type: "number", value: 2 });
    await act(async () => {
      await hook.moveCells({ startRow: 0, startCol: 0, endRow: 1, endCol: 0, type: "cells" }, 1, 0);
    });
    expect(api.updateCellsBatch, "the drag wrote its block in more than one batch").toHaveBeenCalledTimes(1);
    expect(
      writes().map((w) => (w as { source?: unknown }).source),
      "UNNAMED: A2's write (from A2, read before any write of the batch) names no source",
    ).toEqual([
      { sheetIndex: 0, row: 0, col: 0, unshifted: true },
      { sheetIndex: 0, row: 1, col: 0, unshifted: true },
    ]);

    api.updateCellsBatch.mockClear();
    model.cells.clear();
    model.cells.set("1,0", { display: "1", formula: null, styleIndex: 0, type: "number", value: 1 });
    model.cells.set("2,0", { display: "2", formula: null, styleIndex: 0, type: "number", value: 2 });
    await act(async () => {
      // Rows 2:3 onto rows 1:2 -- row 2 is cleared before the batch.
      await hook.moveRows(1, 2, 0);
    });
    expect(
      (api.updateCellsBatch.mock.calls[0]?.[0] as Array<{ row: number; source?: unknown }>).map((u) => [u.row, u.source]),
      "CLEARED: the batch named a source row the gesture cleared first",
    ).toEqual([
      [0, undefined],
      [1, { sheetIndex: 0, row: 2, col: 0, unshifted: true }],
    ]);
  });

  it("positive control: unreadable stored values -- the move writes the display text, as before", async () => {
    model.failTyped = true;
    put(0, { display: "1.23", formula: null, styleIndex: 4, type: "number", value: 1.23456 });
    await act(async () => {
      await hook.moveCells({ startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells" }, 5, 0);
    });
    expect(writes()).toEqual([
      {
        row: 5,
        col: 0,
        value: "1.23",
        moved: { sheetIndex: 0, row: 0, col: 0 },
        source: { sheetIndex: 0, row: 0, col: 0, unshifted: true },
      },
    ]);
  });
});

// BUG-0652 follow-up (lane dtfollow). A live data table's body cell holds the
// `=TABLE(..)` marker, which the backend refuses as a pasted formula ("That
// function isn't valid."), so a copy of it pasted nothing. Excel [LIVE, Excel 16
// over COM, 2026-11-05, dtfollow/probe1.ps1]: Paste, Paste Special Formulas and
// Values of a body cell all write its VALUE; the whole table pastes its formula
// row shifted and its body as values; a Ctrl+drag copy likewise.
// SABOTAGE: make `copiedCell` (core/lib/dataTableCopy.ts) return the cell as it is.
describe("a copy of a data table's body pastes its values", () => {
  it("Copy + Paste of the formula row and a body row: the formula shifts, the body cell is its value", async () => {
    put(0, { display: "2", formula: "=B1", styleIndex: 0, type: "number", value: 2 });
    put(1, { display: "10", formula: "=TABLE(,A1)", styleIndex: 3, type: "number", value: 10 });
    await copyAndPaste(2);
    expect(firstBatch(), "COPIED THE MARKER: the body cell must paste as its value").toEqual([
      { row: 5, col: 0, value: "=B1@5,0", styleIndex: 0, pasted: true, source: { sheetIndex: 0, row: 0, col: 0 } },
      { row: 5, col: 1, value: "10", styleIndex: 3, invariant: true, pasted: true, source: { sheetIndex: 0, row: 0, col: 1 } },
    ]);
    expect(getInternalClipboard()?.cells[0][1]?.formula ?? null, "every paste kind reads the clipboard's cells").toBeNull();
    expect(sys.written.at(-1), "other programs get the body's value, not its marker").toBe("=B1\t10");
  });

  it("a Ctrl+drag copy of a body cell writes its value", async () => {
    put(0, { display: "14", formula: "=TABLE(;A1)", styleIndex: 0, type: "number", value: 14 });
    await act(async () => {
      await hook.copyCellsDrag({ startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells" }, 5, 0);
    });
    const batched = api.updateCellsBatch.mock.calls.flatMap((c) => c[0] as Update[]);
    expect(batched).toEqual([{ row: 5, col: 0, value: "14", invariant: true, pasted: true, source: { sheetIndex: 0, row: 0, col: 0 } }]);
  });

  it("a CUT keeps the marker, so the backend refuses the move as Excel refuses it", async () => {
    put(0, { display: "10", formula: "=TABLE(,A1)", styleIndex: 0, type: "number", value: 10 });
    await copyAndPaste(1, true);
    expect(firstBatch()[0]?.value).toBe("=TABLE(,A1)");
  });
});

// NEW-drag-move-whole-table. Excel moves a whole data table with Cut + Paste
// [LIVE, dtfollow/probe1.ps1], and the backend moves it when ONE batch claims
// every cell of its range by one offset (`data_tables::whole_table_moves`). A
// drag move wrote one cell at a time with no claims, so the table's marker was
// refused as a typed formula ("That function isn't valid."); a row or column
// move sent its batch with no claims. And the old body is emptied IN the batch
// (NEW-clear-cell-datatable-gate), so the source clear -- which Excel's rule
// refuses on part of a table -- never meets it.
// SABOTAGE: drop `moved` from moveCells' writes -- fails at "NO CLAIM"; drop
// its vacated-body loop -- fails at "OLD BODY LEFT"; drop `moved` from
// moveRows -- fails at "ROW MOVE UNCLAIMED"; drop the cut's vacated-body loop
// in `paste` -- fails at "CUT LEFT THE OLD BODY".
describe("a move of a whole data table claims every cell and empties the old body in one batch", () => {
  /** The table A1:B3 in miniature: empty corner A1, formula B1, inputs A2:A3, body B2:B3. */
  function table(): void {
    model.cells.set("0,1", { display: "2", formula: "=C9", styleIndex: 0, type: "number", value: 2 });
    model.cells.set("1,0", { display: "5", formula: null, styleIndex: 0, type: "number", value: 5 });
    model.cells.set("2,0", { display: "7", formula: null, styleIndex: 0, type: "number", value: 7 });
    model.cells.set("1,1", { display: "10", formula: "=TABLE(,Z1)", styleIndex: 0, type: "number", value: 10 });
    model.cells.set("2,1", { display: "14", formula: "=TABLE(,Z1)", styleIndex: 0, type: "number", value: 14 });
  }
  type Claimed = { row: number; col: number; value: string; moved?: { sheetIndex: number; row: number; col: number } };
  const batched = (): Claimed[] => api.updateCellsBatch.mock.calls.flatMap((c) => c[0] as Claimed[]);

  it("a drag move: one batch, a claim per written cell, the vacated body emptied", async () => {
    table();
    await act(async () => {
      await hook.moveCells({ startRow: 0, startCol: 0, endRow: 2, endCol: 1, type: "cells" }, 5, 0);
    });
    expect(api.updateCellsBatch).toHaveBeenCalledTimes(1);
    expect(api.updateCell, "a cell of the block was written on its own").not.toHaveBeenCalled();
    const writes = batched();
    const dest = writes.filter((w) => w.row >= 5);
    expect(dest).toHaveLength(6);
    for (const w of dest) {
      expect(w.moved, `NO CLAIM on the write at (${w.row}, ${w.col})`).toEqual({ sheetIndex: 0, row: w.row - 5, col: w.col });
    }
    expect(
      writes.filter((w) => w.row < 5).map((w) => [w.row, w.col, w.value]),
      "OLD BODY LEFT: the vacated body cells are not emptied in the batch",
    ).toEqual([
      [1, 1, ""],
      [2, 1, ""],
    ]);
  });

  it("a row move: every write that moves a standing source carries its claim", async () => {
    table();
    await act(async () => {
      await hook.moveRows(0, 2, 6);
    });
    const writes = batched();
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) {
      expect(w.moved, `ROW MOVE UNCLAIMED: the write at (${w.row}, ${w.col})`).toEqual({ sheetIndex: 0, row: w.row - 6, col: w.col });
    }
  });

  it("a Cut + Paste on one sheet empties the vacated body in its batch", async () => {
    table();
    await select(0, 0, 2, 1);
    await act(async () => {
      await hook.cut();
    });
    sys.text = sys.written.at(-1) ?? null;
    api.updateCellsBatch.mockClear();
    await select(5, 0);
    await act(async () => {
      await hook.paste();
    });
    await settle();
    expect(
      firstBatch()
        .filter((w) => w.row < 5)
        .map((w) => [w.row, w.col, w.value]),
      "CUT LEFT THE OLD BODY: the vacated body cells are not emptied in the paste's batch",
    ).toEqual([
      [1, 1, ""],
      [2, 1, ""],
    ]);
  });
});
