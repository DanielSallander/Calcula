//! FILENAME: app/src/api/scriptHost/scriptPreview/__tests__/formulaEval.test.ts
// PURPOSE: Pin how computed formula values reach the preview grid — and how a
//          value that did NOT settle is reported rather than presented.
// CONTEXT: docs/design/local-model-script-authoring.md §5c.
//
//          The COMPUTATION is Rust's and is tested there (`ai/preview_eval.rs`:
//          literals, a two-link chain that needs a second pass, a circular
//          reference that stops, an error value). What is tested here is the
//          half that can quietly go wrong on this side: which cells are sent,
//          what happens to the answers, and what a caller is told when the
//          answers are not final.

import { describe, expect, it, vi } from "vitest";
import { PreviewGrid, cellShape } from "../grid";
import { recalculatePreviewGrid, type PreviewEvalResult } from "../formulaEval";

const evaluator = (result: Partial<PreviewEvalResult>) =>
  vi.fn(async () => ({ values: [], converged: true, passes: 1, spilled: 0, ...result }) as PreviewEvalResult);

function gridWith(cells: Array<[number, number, string]>): PreviewGrid {
  const grid = new PreviewGrid();
  for (const [r, c, input] of cells) grid.setInput(r, c, input);
  return grid;
}

describe("recalculating the preview grid", () => {
  it("stores a computed value where a script's formula reads it back", () => {
    // THE case this exists for: before it, a script that wrote `=SUM(A1:A3)`
    // and read the cell back got an empty display.
    const grid = gridWith([
      [0, 0, "1"],
      [1, 0, "=A1+1"],
    ]);
    const evaluate = evaluator({ values: [{ row: 1, col: 0, display: "2" }] });
    return recalculatePreviewGrid(grid, "Sheet1", evaluate).then((note) => {
      expect(note).toBeUndefined();
      expect(grid.cachedDisplay(1, 0)).toBe("2");
      // And it reads back through the same path `api.getCellValue` uses.
      expect(cellShape(grid, 1, 0)).toMatchObject({ display: "2", value: 2, formula: "=A1+1" });
      // The INPUT is untouched — the diff still compares formula text.
      expect(grid.input(1, 0)).toBe("=A1+1");
    });
  });

  it("sends the WHOLE grid, not just the formulas", async () => {
    // A formula's value depends on the literals it references, so sending only
    // the formula cells would evaluate `=A1+1` against an empty A1 and return
    // a confident, wrong number.
    const grid = gridWith([
      [0, 0, "1"],
      [0, 1, "text"],
      [1, 0, "=A1+1"],
    ]);
    const evaluate = evaluator({});
    await recalculatePreviewGrid(grid, "Sheet1", evaluate);
    const [cells, sheetName] = evaluate.mock.calls[0] as unknown as [
      Array<{ row: number; col: number; input: string }>,
      string,
    ];
    expect(cells).toHaveLength(3);
    expect([...cells.map((c) => c.input)].sort()).toEqual(["1", "=A1+1", "text"]);
    expect(sheetName, "the sheet name matters for cross-sheet references").toBe("Sheet1");
  });

  it("does not call the evaluator at all when there is no formula", async () => {
    // A preview of a script that only writes literals must not pay an IPC round
    // trip per settle point.
    const evaluate = evaluator({});
    expect(await recalculatePreviewGrid(gridWith([[0, 0, "42"]]), "Sheet1", evaluate)).toBeUndefined();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("stores NOTHING from a non-convergent result, and says why", async () => {
    // §5c.1 rule 1. The first version stored the half-iterated numbers as "the
    // best available" — but they are numbers the workbook would never show
    // (a 50-row running-total column read as garbage), so an unconverged pass
    // now keeps the grid exactly as it was and reports it.
    const grid = gridWith([
      [0, 0, "=B1+1"],
      [0, 1, "=A1+1"],
    ]);
    const note = await recalculatePreviewGrid(
      grid,
      "Sheet1",
      evaluator({ values: [{ row: 0, col: 0, display: "8" }], converged: false, passes: 3 }),
    );
    expect(note).toMatch(/did not settle within the evaluation budget \(3 passes/);
    expect(note).toMatch(/circular reference, or a volatile function/i);
    expect(note).toMatch(/workbook's last computed ones/);
    expect(
      grid.cachedDisplay(0, 0),
      "a half-iterated number is a value the workbook would never show",
    ).toBeUndefined();
  });

  it("stores NOTHING when any formula spills, and says why", async () => {
    // §5c.1 rule 2. A spill writes NEIGHBORS; a single-cell result cannot
    // express that, and its first element alone is a wrong answer wearing the
    // right cell.
    const grid = gridWith([
      [0, 0, "=SEQUENCE(3)"],
      [0, 1, "=1+1"],
    ]);
    const note = await recalculatePreviewGrid(
      grid,
      "Sheet1",
      evaluator({ values: [{ row: 0, col: 1, display: "2" }], spilled: 1 }),
    );
    expect(note).toMatch(/produces a spilled array/);
    expect(note).toMatch(/workbook's last computed ones/);
    expect(grid.cachedDisplay(0, 1), "even the non-spilling neighbor is withheld").toBeUndefined();
  });

  it("never lets a computed ERROR replace an existing value, and says so", async () => {
    // §5c.1 rule 3 — the worst confirmed finding of the review. The evaluator
    // sees ONE sheet with no names and no UDFs, so `=Sheet2!A1` computes #REF!
    // where the workbook computed 250; storing that replaced truth with the
    // evaluator's horizon, and the script's own reads then branched on it.
    const grid = new PreviewGrid();
    grid.seedFromDocument(0, 0, "=Sheet2!A1*2", "250");
    grid.setInput(1, 0, "=1/0"); // script-written, no prior display
    const note = await recalculatePreviewGrid(
      grid,
      "Sheet1",
      evaluator({
        values: [
          { row: 0, col: 0, display: "#REF!" },
          { row: 1, col: 0, display: "#DIV/0!" },
        ],
      }),
    );
    expect(grid.cachedDisplay(0, 0), "the workbook's 250 outranks the evaluator's #REF!").toBe("250");
    expect(
      grid.cachedDisplay(1, 0),
      "a script-written formula with no prior display genuinely errors",
    ).toBe("#DIV/0!");
    expect(note).toMatch(/1 formula the preview cannot evaluate/);
    expect(note).toMatch(/kept the workbook's computed value/);
  });

  it("REPORTS a deliberate refusal — a refusal is an answer, not an outage", async () => {
    // The cap used to travel as an Err into the silent catch below, making
    // "the evaluator refused this batch" indistinguishable from "there is no
    // evaluator here" — a script that grew the grid past the cap had its
    // formulas read back empty with no note anywhere.
    const grid = gridWith([
      [0, 0, "1"],
      [1, 0, "=A1+1"],
    ]);
    const note = await recalculatePreviewGrid(
      grid,
      "Sheet1",
      evaluator({ refused: "the sheet holds 20001 cells, more than the 20000 this preview will evaluate" }),
    );
    expect(note).toContain("20001 cells");
    expect(note).toContain("workbook's last computed ones");
    expect(note).toContain("formulas the script wrote have none");
    expect(grid.cachedDisplay(1, 0), "a refused batch stores nothing").toBeUndefined();
  });

  it("leaves the grid exactly as it was when the evaluator is unavailable", async () => {
    // An enrichment that cannot run must not turn a working preview into a
    // failed one — the grid keeps the values it had before this existed.
    const grid = gridWith([
      [0, 0, "1"],
      [1, 0, "=A1+1"],
    ]);
    const note = await recalculatePreviewGrid(grid, "Sheet1", async () => {
      throw new Error("no backend here");
    });
    expect(note).toBeUndefined();
    expect(grid.cachedDisplay(1, 0)).toBeUndefined();
    expect(grid.input(1, 0)).toBe("=A1+1");
  });

  it("never invents a cell for a value it was handed", async () => {
    // A value for a coordinate the grid does not hold is a bug in the caller;
    // materialising a cell for it would put content in the diff that no script
    // ever wrote.
    const grid = gridWith([[0, 0, "=1+1"]]);
    await recalculatePreviewGrid(
      grid,
      "Sheet1",
      evaluator({ values: [{ row: 99, col: 99, display: "boom" }] }),
    );
    expect(grid.entries().map((e) => `${e.row},${e.col}`)).toEqual(["0,0"]);
  });
});
