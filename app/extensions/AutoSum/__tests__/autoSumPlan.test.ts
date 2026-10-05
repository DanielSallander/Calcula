//! FILENAME: app/extensions/AutoSum/__tests__/autoSumPlan.test.ts
// PURPOSE: AutoSum guesses and writes what EXCEL guesses and writes. Every case
//          below was measured in live Excel 16 (build 20430) on 2026-10-04 by
//          driving the ribbon's AutoSum (CommandBars.ExecuteMso) over a fresh
//          workbook; the case names are the probe's (B = one cell, which opens
//          an edit; A / M = a selected range, which Excel writes directly).
//          The planner is pure over a cell reader, so the sheet here is a map.

import { describe, it, expect } from "vitest";
import {
  planAutoSum,
  planAutoSumAreas,
  guessSingleCell,
  type AutoSumAreasPlan,
  type AutoSumCellReader,
  type AutoSumFn,
  type AutoSumPlan,
} from "../lib/autoSumPlan";
import type { TypedCellData } from "@api/lib";

// ---------------------------------------------------------------------------
// An in-memory sheet addressed in A1 notation
// ---------------------------------------------------------------------------

type Spec = Record<string, number | string>;

function addr(a1: string): { row: number; col: number } {
  const m = /^([A-Z]+)(\d+)$/.exec(a1)!;
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { row: Number(m[2]) - 1, col: col - 1 };
}

function range(ref: string): { startRow: number; startCol: number; endRow: number; endCol: number } {
  const [a, b] = ref.split(":");
  const s = addr(a);
  const e = addr(b ?? a);
  return { startRow: s.row, startCol: s.col, endRow: e.row, endCol: e.col };
}

function readerOf(spec: Spec): AutoSumCellReader {
  const cells = new Map<string, TypedCellData>();
  for (const [a1, v] of Object.entries(spec)) {
    const { row, col } = addr(a1);
    const isFormula = typeof v === "string" && v.startsWith("=");
    const type = typeof v === "number" || isFormula ? "number" : "text";
    cells.set(`${row},${col}`, {
      row,
      col,
      value: isFormula ? 0 : v,
      display: String(v),
      formula: isFormula ? (v as string) : null,
      type,
    });
  }
  let maxRow = 0;
  let maxCol = 0;
  for (const c of cells.values()) {
    maxRow = Math.max(maxRow, c.row);
    maxCol = Math.max(maxCol, c.col);
  }
  return {
    read: async (r) =>
      [...cells.values()].filter(
        (c) => c.row >= r.startRow && c.row <= r.endRow && c.col >= r.startCol && c.col <= r.endCol,
      ),
    usedRange: async () => ({ endRow: maxRow, endCol: maxCol, empty: cells.size === 0 }),
  };
}

/** A single selected cell (anchor = active). */
async function one(spec: Spec, target: string, fn: AutoSumFn = "SUM", listSeparator = ","): Promise<AutoSumPlan> {
  const { row, col } = addr(target);
  return planAutoSum(fn, { startRow: row, startCol: col, endRow: row, endCol: col }, readerOf(spec), listSeparator);
}

/** A selection dragged from its top-left to its bottom-right (Core: active = bottom-right). */
async function sel(spec: Spec, ref: string, fn: AutoSumFn = "SUM"): Promise<AutoSumPlan> {
  return planAutoSum(fn, range(ref), readerOf(spec), ",");
}

function writesOf(plan: AutoSumPlan): Record<string, string> {
  expect(plan.kind, JSON.stringify(plan)).toBe("write");
  const out: Record<string, string> = {};
  if (plan.kind !== "write") return out;
  for (const w of plan.writes) {
    let n = w.col + 1;
    let letters = "";
    while (n > 0) {
      const r = (n - 1) % 26;
      letters = String.fromCharCode(65 + r) + letters;
      n = Math.floor((n - 1) / 26);
    }
    out[`${letters}${w.row + 1}`] = w.formula;
  }
  return out;
}

function editOf(plan: AutoSumPlan | AutoSumAreasPlan): { at: string; text: string; caret: number } {
  expect(plan.kind, JSON.stringify(plan)).toBe("edit");
  if (plan.kind !== "edit") return { at: "", text: "", caret: -1 };
  const letters = String.fromCharCode(65 + plan.col);
  return { at: `${letters}${plan.row + 1}`, text: plan.formula, caret: plan.caret };
}

// ---------------------------------------------------------------------------
// ONE cell: Excel opens an edit holding its guess (Enter confirms it)
// ---------------------------------------------------------------------------

describe("one cell: the guess (Excel's edit text)", () => {
  const nums = { A1: 1, A2: 2, A3: 3 };

  it("B1 numbers above", async () => {
    expect(editOf(await one(nums, "A4")).text).toBe("=SUM(A1:A3)");
  });
  it("B2 / B2b / B20: blank cells between are SKIPPED and included", async () => {
    expect(editOf(await one(nums, "A5")).text).toBe("=SUM(A1:A4)");
    expect(editOf(await one(nums, "A6")).text).toBe("=SUM(A1:A5)");
    expect(editOf(await one({ A1: 1, A2: 2 }, "A10")).text).toBe("=SUM(A1:A9)");
  });
  it("... also when the blanks are inside the sheet's used extent (they are READ and skipped)", async () => {
    // B9 / E3 push the used extent past the gap, so the walk reads the blank
    // cells instead of starting below them.
    expect(editOf(await one({ A1: 1, A2: 2, B9: "x" }, "A5")).text).toBe("=SUM(A1:A4)");
    expect(editOf(await one({ A1: 1, B1: 2, E3: "x" }, "D1")).text).toBe("=SUM(A1:C1)");
  });
  it("B3 a text header stops the range", async () => {
    expect(editOf(await one({ A1: "H", A2: 1, A3: 2, A4: 3 }, "A5")).text).toBe("=SUM(A2:A4)");
  });
  it("B4 a blank INSIDE the numbers stops it", async () => {
    expect(editOf(await one({ A1: 1, A2: 2, A4: 4, A5: 5 }, "A6")).text).toBe("=SUM(A4:A5)");
  });
  it("B17 text in the middle stops it", async () => {
    expect(editOf(await one({ A1: 1, A2: "x", A3: 3, A4: 4 }, "A5")).text).toBe("=SUM(A3:A4)");
  });
  it("B5 / B12 numbers to the left when nothing is above", async () => {
    expect(editOf(await one({ A1: 1, B1: 2, C1: 3 }, "D1")).text).toBe("=SUM(A1:C1)");
    expect(editOf(await one({ B2: 1, C2: 2, D2: 3 }, "E2")).text).toBe("=SUM(B2:D2)");
  });
  it("B14 a leading label on the left is excluded; B16 a blank gap on the left is included", async () => {
    expect(editOf(await one({ A1: "Label", B1: 1, C1: 2, D1: 3 }, "E1")).text).toBe("=SUM(B1:D1)");
    expect(editOf(await one({ A1: 1, B1: 2, C1: 3 }, "E1")).text).toBe("=SUM(A1:D1)");
  });
  it("B6 / B22 above wins over left", async () => {
    expect(editOf(await one({ C1: 1, C2: 2, C3: 3, A4: 7, B4: 8 }, "C4")).text).toBe("=SUM(C1:C3)");
    expect(editOf(await one({ B1: 1, B2: 2, A3: 4 }, "B3")).text).toBe("=SUM(B1:B2)");
  });
  it("B13 text above sends it LEFT", async () => {
    expect(editOf(await one({ B1: "a", B2: "b", B3: "c", A4: 9 }, "B4")).text).toBe("=SUM(A4)");
  });
  it("B19 an empty column above sends it left", async () => {
    expect(editOf(await one({ A3: 1, B3: 2 }, "C3")).text).toBe("=SUM(A3:B3)");
  });
  it("B8 a cell inside the numbers sums the ones above it", async () => {
    expect(editOf(await one({ A1: 1, A2: 2, A3: 3, A4: 4, A5: 5 }, "A3")).text).toBe("=SUM(A1:A2)");
  });
  it("B11 a formula's number is a number", async () => {
    expect(editOf(await one({ A1: 1, A2: 2, A3: "=A1*2" }, "A4")).text).toBe("=SUM(A1:A3)");
  });
  it("B18 a single number", async () => {
    expect(editOf(await one({ A1: 5 }, "A2")).text).toBe("=SUM(A1)");
  });
  it("B10 subtotals above: the grand total sums the SUBTOTALS, nearest first", async () => {
    const spec = { A1: 1, A2: 2, A3: "=SUM(A1:A2)", A4: 4, A5: 5, A6: "=SUM(A4:A5)" };
    expect(editOf(await one(spec, "A7")).text).toBe("=SUM(A6,A3)");
    // In the user's locale (sv-SE separates arguments with ';').
    expect(editOf(await one(spec, "A7", "SUM", ";")).text).toBe("=SUM(A6;A3)");
  });
  it("B7 / B21 nothing to guess: an empty =SUM() with the caret inside", async () => {
    const empty = editOf(await one({}, "B2"));
    expect(empty).toEqual({ at: "B2", text: "=SUM()", caret: 5 });
    expect(editOf(await one({ A1: "a", A2: "b", A3: "c" }, "A4")).text).toBe("=SUM()");
  });
  it("the caret sits before the closing parenthesis, so Enter confirms the guess", async () => {
    expect(editOf(await one(nums, "A4")).caret).toBe("=SUM(A1:A3".length);
  });
  it("B15 and the other functions", async () => {
    expect(editOf(await one(nums, "A4", "AVERAGE")).text).toBe("=AVERAGE(A1:A3)");
    expect(editOf(await one(nums, "A4", "COUNT")).text).toBe("=COUNT(A1:A3)");
    expect(editOf(await one(nums, "A4", "MAX")).text).toBe("=MAX(A1:A3)");
    expect(editOf(await one(nums, "A4", "MIN")).text).toBe("=MIN(A1:A3)");
  });
  it("guessSingleCell answers the references alone", async () => {
    expect(await guessSingleCell(3, 0, readerOf(nums))).toEqual(["A1:A3"]);
    expect(await guessSingleCell(1, 1, readerOf({}))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A RANGE: Excel writes the totals directly
// ---------------------------------------------------------------------------

describe("a selected range: the totals Excel writes", () => {
  const block = { A1: 1, B1: 2, C1: 3, A2: 4, B2: 5, C2: 6, A3: 7, B3: 8, C3: 9 };

  it("A1 a column: the total BELOW it, and the selection grows to hold it", async () => {
    const plan = await sel({ A1: 1, A2: 2, A3: 3 }, "A1:A3");
    expect(writesOf(plan)).toEqual({ A4: "=SUM(A1:A3)" });
    expect(plan.kind === "write" && plan.selection).toEqual(range("A1:A4"));
  });
  it("A2 / A17 / A18 a block: a total under EVERY column (never to the right)", async () => {
    expect(writesOf(await sel(block, "A1:C3"))).toEqual({ A4: "=SUM(A1:A3)", B4: "=SUM(B1:B3)", C4: "=SUM(C1:C3)" });
    expect(writesOf(await sel({ A1: 1, B1: 2, C1: 3, A2: 4, B2: 5, C2: 6 }, "A1:C2"))).toEqual({
      A3: "=SUM(A1:A2)", B3: "=SUM(B1:B2)", C3: "=SUM(C1:C2)",
    });
    expect(writesOf(await sel({ A1: 1, B1: 2, A2: 3, B2: 4, A3: 5, B3: 6 }, "A1:B3"))).toEqual({
      A4: "=SUM(A1:A3)", B4: "=SUM(B1:B3)",
    });
  });
  it("A3 an empty last row in the selection takes the totals", async () => {
    expect(writesOf(await sel({ A1: 1, A2: 2, A3: 3 }, "A1:A4"))).toEqual({ A4: "=SUM(A1:A3)" });
  });
  it("A4 an empty last row AND column: row totals, column totals and a grand total of the column totals", async () => {
    expect(writesOf(await sel(block, "A1:D4"))).toEqual({
      D1: "=SUM(A1:C1)", D2: "=SUM(A2:C2)", D3: "=SUM(A3:C3)",
      A4: "=SUM(A1:A3)", B4: "=SUM(B1:B3)", C4: "=SUM(C1:C3)",
      D4: "=SUM(A4:C4)",
    });
  });
  it("A20 an empty last column: row totals in it", async () => {
    expect(writesOf(await sel({ A1: 1, B1: 2, A2: 3, B2: 4, A3: 5, B3: 6 }, "A1:C3"))).toEqual({
      C1: "=SUM(A1:B1)", C2: "=SUM(A2:B2)", C3: "=SUM(A3:B3)",
    });
  });
  it("A5 / A6 / A10 a single row: the total to the RIGHT (text inside is still in the range)", async () => {
    expect(writesOf(await sel({ A1: 1, B1: 2, C1: 3 }, "A1:C1"))).toEqual({ D1: "=SUM(A1:C1)" });
    expect(writesOf(await sel({ A1: 1, B1: 2, C1: 3 }, "A1:D1"))).toEqual({ D1: "=SUM(A1:C1)" });
    expect(writesOf(await sel({ A1: 1, B1: "x", C1: 3 }, "A1:C1"))).toEqual({ D1: "=SUM(A1:C1)" });
  });
  it("A7 / M12 leading text rows (a header) are left out, and the selection moves past them", async () => {
    const plan = await sel({ A1: "H", A2: 1, A3: 2, A4: 3 }, "A1:A4");
    expect(writesOf(plan)).toEqual({ A5: "=SUM(A2:A4)" });
    expect(plan.kind === "write" && plan.selection).toEqual(range("A2:A5"));
    expect(writesOf(await sel({ A1: "H", A2: 1, A3: 2 }, "A1:A4"))).toEqual({ A4: "=SUM(A2:A3)" });
  });
  it("M1 / M6 a header ROW over a block", async () => {
    const spec = { A1: "H1", B1: "H2", A2: 1, B2: 2, A3: 3, B3: 4 };
    const plan = await sel(spec, "A1:B3");
    expect(writesOf(plan)).toEqual({ A4: "=SUM(A2:A3)", B4: "=SUM(B2:B3)" });
    expect(plan.kind === "write" && plan.selection).toEqual(range("A2:B4"));
    expect(writesOf(await sel(spec, "A1:B4"))).toEqual({ A4: "=SUM(A2:A3)", B4: "=SUM(B2:B3)" });
  });
  it("M2 a first row that HAS a number is not a header", async () => {
    expect(writesOf(await sel({ A1: "H1", B1: 9, A2: 1, B2: 2, A3: 3, B3: 4 }, "A1:B3"))).toEqual({
      A4: "=SUM(A1:A3)", B4: "=SUM(B1:B3)",
    });
  });
  it("M3 / M4 / M6b leading label COLUMNS are left out", async () => {
    const m3 = await sel({ A1: "Label", B1: 1, C1: 2, D1: 3 }, "A1:D1");
    expect(writesOf(m3)).toEqual({ E1: "=SUM(B1:D1)" });
    expect(m3.kind === "write" && m3.selection).toEqual(range("B1:E1"));
    const labels = { A1: "L1", B1: 1, C1: 2, A2: "L2", B2: 3, C2: 4 };
    const m4 = await sel(labels, "A1:C2");
    expect(writesOf(m4)).toEqual({ B3: "=SUM(B1:B2)", C3: "=SUM(C1:C2)" });
    expect(m4.kind === "write" && m4.selection).toEqual(range("B1:C3"));
    expect(writesOf(await sel(labels, "A1:D2"))).toEqual({ D1: "=SUM(B1:C1)", D2: "=SUM(B2:C2)" });
  });
  it("A8 / A8b / M9 / M10 / M11 an occupied total cell: the next row (or column) that is EMPTY", async () => {
    expect(writesOf(await sel({ A1: 1, A2: 2, A3: 3, A4: 99 }, "A1:A3"))).toEqual({ A5: "=SUM(A1:A3)" });
    expect(writesOf(await sel({ A1: 1, A2: 2, A3: 3, A4: 99, A5: 98 }, "A1:A3"))).toEqual({ A6: "=SUM(A1:A3)" });
    expect(writesOf(await sel({ A1: 1, A2: 2, A3: 3, A4: "x" }, "A1:A3"))).toEqual({ A5: "=SUM(A1:A3)" });
    // One occupied cell moves the WHOLE row of totals.
    expect(writesOf(await sel({ A1: 1, B1: 2, A2: 3, B2: 4, A3: 5, B3: 6, A4: 99 }, "A1:B3"))).toEqual({
      A5: "=SUM(A1:A3)", B5: "=SUM(B1:B3)",
    });
    expect(writesOf(await sel({ A1: 1, B1: 2, C1: 3, D1: 99 }, "A1:C1"))).toEqual({ E1: "=SUM(A1:C1)" });
  });
  it("A14 / A21 / M14 blanks and text inside the selection stay inside the range", async () => {
    expect(writesOf(await sel({ A1: 1, A2: 2, A3: 3, B2: 5, B3: 6 }, "A1:B3"))).toEqual({
      A4: "=SUM(A1:A3)", B4: "=SUM(B1:B3)",
    });
    expect(writesOf(await sel({ A1: 1, A3: 3, A4: 4 }, "A1:A4"))).toEqual({ A5: "=SUM(A1:A4)" });
    expect(writesOf(await sel({ A1: 1, B1: 2, A2: "x", B2: "y", A3: 3, B3: 4 }, "A1:B3"))).toEqual({
      A4: "=SUM(A1:A3)", B4: "=SUM(B1:B3)",
    });
  });
  it("A22 / A23 a full column and a formula row", async () => {
    expect(writesOf(await sel({ A1: 1, A2: 2, A3: 3, A4: 4 }, "A1:A4"))).toEqual({ A5: "=SUM(A1:A4)" });
    expect(writesOf(await sel({ A1: 1, A2: 2, A3: "=A1*2" }, "A1:A3"))).toEqual({ A4: "=SUM(A1:A3)" });
  });
  it("M18 / M20 / M21 / M22 the range is the SELECTION's, not the column's", async () => {
    expect(writesOf(await sel({ A1: 1, A2: 2, A3: 3 }, "A2:A4"))).toEqual({ A4: "=SUM(A2:A3)" });
    expect(writesOf(await sel({ A1: 1, A2: 2, A3: 3 }, "A3:A4"))).toEqual({ A4: "=SUM(A3)" });
    expect(writesOf(await sel({ A1: 1, B1: 2, A2: 3, B2: 4 }, "A2:B3"))).toEqual({ A3: "=SUM(A2)", B3: "=SUM(B2)" });
    expect(writesOf(await sel({ A1: 1, B1: 2, C1: 3 }, "B1:D1"))).toEqual({ D1: "=SUM(B1:C1)" });
  });
  it("M16 / M17 EMPTY cells below or beside numbers each get their own guess, written directly", async () => {
    const spec = { A1: 1, B1: 2, A2: 3, B2: 4 };
    expect(writesOf(await sel(spec, "A3:B3"))).toEqual({ A3: "=SUM(A1:A2)", B3: "=SUM(B1:B2)" });
    expect(writesOf(await sel(spec, "C1:C2"))).toEqual({ C1: "=SUM(A1:B1)", C2: "=SUM(A2:B2)" });
  });
  it("M7 / M8 / M13 no numbers to total: an edit of the active cell, as for one cell", async () => {
    expect(editOf(await sel({ A1: "a", B1: "b", A2: "c", B2: "d" }, "A1:B2"))).toMatchObject({ text: "=SUM()" });
    expect(editOf(await sel({}, "A1:B2"))).toMatchObject({ at: "B2", text: "=SUM()" });
    expect(editOf(await sel({ A1: "a", A2: "b", A3: 5 }, "A1:A3"))).toMatchObject({ at: "A3", text: "=SUM()" });
  });
  it("A11 / A12 the function is the one asked for", async () => {
    const spec = { A1: 1, A2: 2, A3: 3 };
    expect(writesOf(await sel(spec, "A1:A3", "AVERAGE"))).toEqual({ A4: "=AVERAGE(A1:A3)" });
    expect(writesOf(await sel(spec, "A1:A3", "COUNT"))).toEqual({ A4: "=COUNT(A1:A3)" });
    expect(writesOf(await sel(spec, "A1:A3", "MAX"))).toEqual({ A4: "=MAX(A1:A3)" });
    expect(writesOf(await sel(spec, "A1:A3", "MIN"))).toEqual({ A4: "=MIN(A1:A3)" });
  });
});

// ---------------------------------------------------------------------------
// The subtotal rule's other half, measured live 2026-10-04 (build 20430, case
// R1): a run of PLAIN numbers stops at a subtotal above it. Only a guess whose
// first number IS a subtotal collects subtotals (B10). Read through a second
// area so Excel wrote the guess instead of opening an edit COM cannot read.
// ---------------------------------------------------------------------------

describe("one cell: a plain run stops at the subtotal above it (R1)", () => {
  it("A1:A3, A4 =SUM(A1:A3), A5:A7: AutoSum in A8 totals A5:A7, not the subtotal", async () => {
    const spec = { A1: 1, A2: 2, A3: 3, A4: "=SUM(A1:A3)", A5: 10, A6: 20, A7: 30 };
    expect(editOf(await one(spec, "A8")).text).toBe("=SUM(A5:A7)");
  });
  it("the same rule to the left", async () => {
    const spec = { A1: 1, B1: "=SUM(A1)", C1: 5, D1: 6 };
    expect(editOf(await one(spec, "E1")).text).toBe("=SUM(C1:D1)");
  });
});

// ---------------------------------------------------------------------------
// SEVERAL areas (Ctrl+click, Go To Special > Blanks): measured live 2026-10-04
// (build 20430, a fresh hidden instance per case, ExecuteMso("AutoSum")):
//   - each area is planned by the one-area rules, IN SELECTION ORDER, against
//     the sheet as the earlier areas left it (Q2: A4 then A6 gives A6
//     =SUM(A4); A6 then A4 gives A6 =SUM(A1:A5));
//   - a one-cell area with a guess is WRITTEN, not edited (P4);
//   - one area with nothing to total sends the whole gesture to an edit, and
//     nothing is written (P5, P10, Q3, P8e);
//   - every write is ONE undo step (one Application.Undo removed them all);
//   - the areas stay selected, each grown over its totals (P3, Q6).
// ---------------------------------------------------------------------------

/** Core's areas, each dragged top-left -> bottom-right; the first is the main one. */
async function areas(spec: Spec, refs: string[], fn: AutoSumFn = "SUM"): Promise<AutoSumAreasPlan> {
  return planAutoSumAreas(fn, refs.map(range), readerOf(spec), ",");
}

function areaWrites(plan: AutoSumAreasPlan): Record<string, string> {
  expect(plan.kind, JSON.stringify(plan)).toBe("write");
  if (plan.kind !== "write") return {};
  return writesOf({ kind: "write", writes: plan.writes, selection: plan.selections[0] });
}

function refOf(r: { startRow: number; startCol: number; endRow: number; endCol: number }): string {
  const a = (row: number, col: number) => `${String.fromCharCode(65 + col)}${row + 1}`;
  const s = a(r.startRow, r.startCol);
  const e = a(r.endRow, r.endCol);
  return s === e ? s : `${s}:${e}`;
}

describe("several areas (Ctrl+click / Go To Special > Blanks), measured live", () => {
  const twoRuns = { A1: 1, A2: 2, A3: 3, A5: 50, A6: 60, A7: 70 };

  it("P1 / R3 Go To Special > Blanks then AutoSum: a total in every blank", async () => {
    const plan = await areas(twoRuns, ["A4", "A8"]);
    expect(areaWrites(plan)).toEqual({ A4: "=SUM(A1:A3)", A8: "=SUM(A5:A7)" });
    if (plan.kind === "write") expect(plan.selections.map(refOf)).toEqual(["A4", "A8"]);
  });

  it("P2 blank rows under two columns: every cell of every area", async () => {
    const spec = { A1: 1, B1: 100, A2: 2, B2: 200, A3: 3, B3: 300, A5: 5, B5: 500, A6: 6, B6: 600 };
    expect(areaWrites(await areas(spec, ["A4:B4", "A7:B7"]))).toEqual({
      A4: "=SUM(A1:A3)", B4: "=SUM(B1:B3)", A7: "=SUM(A5:A6)", B7: "=SUM(B5:B6)",
    });
  });

  it("P3 / P11 number blocks: a total under each, each area grown over its totals", async () => {
    const spec = { A1: 1, A2: 2, A3: 3, C1: 7, C2: 14, C3: 21 };
    const plan = await areas(spec, ["A1:A3", "C1:C3"]);
    expect(areaWrites(plan)).toEqual({ A4: "=SUM(A1:A3)", C4: "=SUM(C1:C3)" });
    if (plan.kind === "write") expect(plan.selections.map(refOf)).toEqual(["A1:A4", "C1:C4"]);
    const block = { A1: 1, B1: 2, A2: 2, B2: 4, A3: 3, B3: 6, D1: 7, D2: 14, D3: 21 };
    expect(areaWrites(await areas(block, ["A1:B3", "D1:D3"]))).toEqual({
      A4: "=SUM(A1:A3)", B4: "=SUM(B1:B3)", D4: "=SUM(D1:D3)",
    });
  });

  it("P4 one-cell areas are WRITTEN (a single selected cell would open an edit)", async () => {
    const spec = { A1: 1, A2: 2, A3: 3, C1: 7, C2: 14, C3: 21 };
    expect(areaWrites(await areas(spec, ["A4", "C4"]))).toEqual({ A4: "=SUM(A1:A3)", C4: "=SUM(C1:C3)" });
  });

  it("P7 a number block and an empty cell", async () => {
    const spec = { A1: 1, A2: 2, A3: 3, C1: 7, C2: 14, C3: 21 };
    const plan = await areas(spec, ["A1:A3", "C4"]);
    expect(areaWrites(plan)).toEqual({ A4: "=SUM(A1:A3)", C4: "=SUM(C1:C3)" });
    if (plan.kind === "write") expect(plan.selections.map(refOf)).toEqual(["A1:A4", "C4"]);
  });

  it("Q2 / Q2b areas are planned in selection order, each seeing the totals before it", async () => {
    const spec = { A1: 1, A2: 2, A3: 3 };
    expect(areaWrites(await areas(spec, ["A4", "A6"]))).toEqual({ A4: "=SUM(A1:A3)", A6: "=SUM(A4)" });
    expect(areaWrites(await areas(spec, ["A6", "A4"]))).toEqual({ A6: "=SUM(A1:A5)", A4: "=SUM(A1:A3)" });
  });

  it("R2 the grand total of an area still sums the subtotals", async () => {
    const spec = { A1: 1, A2: 2, A3: "=SUM(A1:A2)", A4: 4, A5: 5, A6: "=SUM(A4:A5)", C1: 1, C2: 2, C3: 3 };
    expect(areaWrites(await areas(spec, ["A7", "C4"]))).toEqual({ A7: "=SUM(A6,A3)", C4: "=SUM(C1:C3)" });
  });

  it("Q5 / Q6 / Q7 each area by its own one-area rules (occupied row below, header, rows)", async () => {
    const q5 = { A1: 1, A2: 2, A3: 3, A4: "note", C1: 7, C2: 14, C3: 21 };
    expect(areaWrites(await areas(q5, ["A1:A3", "C1:C3"]))).toEqual({ A5: "=SUM(A1:A3)", C4: "=SUM(C1:C3)" });
    const q6 = { A2: 2, A3: 3, A4: 4, C1: "Hdr", C2: 14, C3: 21, C4: 28 };
    const plan = await areas(q6, ["A2:A4", "C1:C4"]);
    expect(areaWrites(plan)).toEqual({ A5: "=SUM(A2:A4)", C5: "=SUM(C2:C4)" });
    if (plan.kind === "write") expect(plan.selections.map(refOf)).toEqual(["A2:A5", "C2:C5"]);
    const q7 = { A1: 1, B1: 2, C1: 3, A3: 7, B3: 14, C3: 21 };
    expect(areaWrites(await areas(q7, ["A1:C1", "A3:C3"]))).toEqual({ D1: "=SUM(A1:C1)", D3: "=SUM(A3:C3)" });
  });

  it("P5 / P10 / Q3 one area with nothing to total: an edit of the active cell, nothing written", async () => {
    const p5 = await areas({ A1: 1, A2: 2, A3: 3 }, ["A4", "E10"]);
    expect(editOf(p5)).toMatchObject({ at: "A4", text: "=SUM(A1:A3)" });
    const p10 = await areas({ A1: 1 }, ["E10", "G12"]);
    expect(editOf(p10).at).toBe("E10");
    // Core's active cell is the main area's END (A3 here).
    const q3 = await areas({ A1: 1, A2: 2, A3: 3 }, ["A1:A3", "E10"]);
    expect(editOf(q3)).toMatchObject({ at: "A3", text: "=SUM(A1:A2)" });
  });

  it("S1 / S2 / S3 only a SUM is a subtotal: an earlier MAX / AVERAGE total is a plain number", async () => {
    // Excel (measured): Max over blanks A4, A8 writes A8 =MAX(A1:A7) -- the
    // run walks through A4's =MAX(A1:A3); the same for Average.
    expect(areaWrites(await areas(twoRuns, ["A4", "A8"], "MAX"))).toEqual({ A4: "=MAX(A1:A3)", A8: "=MAX(A1:A7)" });
    expect(areaWrites(await areas(twoRuns, ["A4", "A8"], "AVERAGE"))).toEqual({
      A4: "=AVERAGE(A1:A3)", A8: "=AVERAGE(A1:A7)",
    });
    expect(areaWrites(await areas({ A1: 1, A2: 2, A3: 3 }, ["A4", "A6"], "MAX"))).toEqual({
      A4: "=MAX(A1:A3)", A6: "=MAX(A1:A5)",
    });
    const s3 = { A1: 1, A2: 2, A3: 3, A4: "=MAX(A1:A3)", A5: 10, A6: 20, A7: 30, C1: 1, C2: 2, C3: 3 };
    expect(areaWrites(await areas(s3, ["A8", "C4"]))).toEqual({ A8: "=SUM(A1:A7)", C4: "=SUM(C1:C3)" });
  });

  it("a single area is exactly planAutoSum's answer", async () => {
    const single = await areas({ A1: 1, A2: 2, A3: 3 }, ["A1:A3"]);
    expect(areaWrites(single)).toEqual({ A4: "=SUM(A1:A3)" });
    expect(editOf(await areas({ A1: 1, A2: 2, A3: 3 }, ["A4"]))).toMatchObject({ at: "A4", text: "=SUM(A1:A3)" });
  });
});
