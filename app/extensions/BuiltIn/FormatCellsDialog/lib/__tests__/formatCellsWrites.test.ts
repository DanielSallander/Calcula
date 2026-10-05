//! FILENAME: app/extensions/BuiltIn/FormatCellsDialog/lib/__tests__/formatCellsWrites.test.ts
// PURPOSE: What Format Cells' OK writes, as a pure plan.
// CONTEXT: Survey D5 -- OK used to write EVERY property of the active cell to
//          EVERY selected cell: a mixed selection became uniform, and an empty
//          active cell wrote the dialog's own defaults ("system-ui" among them)
//          over the whole range. Excel writes only what the user changed.
//          Survey D5 also found the Border tab's "Outline" setting all four
//          sides of every cell, which on a range is All Borders; on a range
//          Excel's four edge buttons are the range's OUTER edges, and Outline
//          is an outside border (`applyBorderPreset(..., "outside")`).

import { describe, it, expect } from "vitest";
import { planFormatCellsWrites, type FormatCellsRect } from "../formatCellsWrites";
import {
  useFormatCellsStore,
  snapshotOf,
  type FormatCellsSnapshot,
  type BorderSide,
} from "../../hooks/useFormatCellsState";

/** A 3 x 3 range, B2:D4. */
const RANGE: FormatCellsRect = { startRow: 1, startCol: 1, endRow: 3, endCol: 3 };
const ONE: FormatCellsRect = { startRow: 4, startCol: 4, endRow: 4, endCol: 4 };
const ROWS = [1, 2, 3];
const COLS = [1, 2, 3];

const NONE: BorderSide = { style: "none", color: "#000000" };
const THIN: BorderSide = { style: "thin", color: "#000000" };

/** A realistic loaded state: Calibri 11, General, no borders. */
function loaded(): FormatCellsSnapshot {
  useFormatCellsStore.getState().reset();
  return { ...snapshotOf(useFormatCellsStore.getState()), fontFamily: "Calibri", numberFormat: "general" };
}

function plan(change: Partial<FormatCellsSnapshot>, opts: { clearAll?: boolean; rect?: FormatCellsRect } = {}) {
  const baseline = loaded();
  return planFormatCellsWrites(baseline, { ...baseline, ...change }, opts.rect ?? RANGE, opts.clearAll ?? false);
}

describe("OK writes only what changed (D5)", () => {
  it("an untouched OK writes nothing at all", () => {
    expect(plan({})).toEqual({ calls: [], protection: null });
  });

  it("one changed property is the WHOLE write -- no font, no colours, no format", () => {
    expect(plan({ bold: true }).calls).toEqual([
      { kind: "format", rows: ROWS, cols: COLS, formatting: { bold: true } },
    ]);
  });

  it("several changes travel in ONE call", () => {
    const { calls } = plan({ fontSize: 10.5, numberFormat: "accounting_gbp", textRotation: "custom:45" });
    expect(calls).toEqual([
      {
        kind: "format",
        rows: ROWS,
        cols: COLS,
        formatting: { fontSize: 10.5, numberFormat: "accounting_gbp", textRotation: "custom:45" },
      },
    ]);
  });

  it("a fill change sends the fill and nothing about the old background colour", () => {
    const { calls } = plan({ fillMode: "solid", backgroundColor: "#ffff00" });
    expect(calls).toEqual([
      { kind: "format", rows: ROWS, cols: COLS, formatting: { fill: { type: "solid", color: "#ffff00" } } },
    ]);
  });

  it("protection is written only when it changed", () => {
    expect(plan({}).protection).toBeNull();
    expect(plan({ locked: false }).protection).toEqual({ locked: false, formulaHidden: false });
  });
});

describe("the Border tab on a RANGE (Excel's edges, not every cell's sides)", () => {
  it("Outline is ONE outside-border preset, not four sides on every cell", () => {
    const { calls } = plan({ borderTop: THIN, borderRight: THIN, borderBottom: THIN, borderLeft: THIN });
    expect(calls).toEqual([{ kind: "preset", preset: "outside", style: "solid", color: "#000000", width: 1 }]);
  });

  it("the outline carries the chosen line: medium red", () => {
    const red: BorderSide = { style: "medium", color: "#ff0000" };
    const { calls } = plan({ borderTop: red, borderRight: red, borderBottom: red, borderLeft: red });
    expect(calls).toEqual([{ kind: "preset", preset: "outside", style: "solid", color: "#ff0000", width: 2 }]);
  });

  it("Top alone is the range's top EDGE: the first row only", () => {
    expect(plan({ borderTop: THIN }).calls).toEqual([
      { kind: "format", rows: [1], cols: COLS, formatting: { borderTop: { style: "thin", color: "#000000" } } },
    ]);
  });

  it("Bottom, Left and Right are the last row, first column and last column", () => {
    const dotted: BorderSide = { style: "dotted", color: "#123456" };
    const { calls } = plan({ borderBottom: dotted, borderLeft: dotted, borderRight: dotted });
    expect(calls).toEqual([
      { kind: "format", rows: [3], cols: COLS, formatting: { borderBottom: dotted } },
      { kind: "format", rows: ROWS, cols: [1], formatting: { borderLeft: dotted } },
      { kind: "format", rows: ROWS, cols: [3], formatting: { borderRight: dotted } },
    ]);
  });

  it("the inside lines are presets between the rows / columns", () => {
    const { calls } = plan({ borderInsideHorizontal: THIN, borderInsideVertical: THIN });
    expect(calls).toEqual([
      { kind: "preset", preset: "insideHorizontal", style: "solid", color: "#000000", width: 1 },
      { kind: "preset", preset: "insideVertical", style: "solid", color: "#000000", width: 1 },
    ]);
  });

  it("turning an inside line OFF clears both cells' sides of every inner boundary", () => {
    const baseline = { ...loaded(), borderInsideHorizontal: THIN };
    const { calls } = planFormatCellsWrites(baseline, { ...baseline, borderInsideHorizontal: NONE }, RANGE, false);
    expect(calls).toEqual([
      { kind: "format", rows: [1, 2], cols: COLS, formatting: { borderBottom: { style: "none", color: "#000000" } } },
      { kind: "format", rows: [2, 3], cols: COLS, formatting: { borderTop: { style: "none", color: "#000000" } } },
    ]);
  });

  it("None clears the whole range first, and writes no redundant 'none' sides after it", () => {
    const baseline = { ...loaded(), borderTop: THIN, borderLeft: THIN, borderInsideVertical: THIN };
    const current = { ...baseline, borderTop: NONE, borderLeft: NONE, borderInsideVertical: NONE };
    expect(planFormatCellsWrites(baseline, current, RANGE, true).calls).toEqual([
      { kind: "preset", preset: "none", style: "solid", color: "#000000", width: 0 },
    ]);
  });

  it("None and then Outline: clear, then the outline", () => {
    const baseline = { ...loaded(), borderTop: THIN };
    const current = { ...baseline, borderTop: THIN, borderRight: THIN, borderBottom: THIN, borderLeft: THIN };
    expect(planFormatCellsWrites(baseline, current, RANGE, true).calls).toEqual([
      { kind: "preset", preset: "none", style: "solid", color: "#000000", width: 0 },
      { kind: "preset", preset: "outside", style: "solid", color: "#000000", width: 1 },
    ]);
  });

  it("diagonals are per cell and ride the whole-range call", () => {
    expect(plan({ bold: true, borderDiagonalDown: THIN }).calls).toEqual([
      {
        kind: "format",
        rows: ROWS,
        cols: COLS,
        formatting: { bold: true, borderDiagonalDown: { style: "thin", color: "#000000" } },
      },
    ]);
  });

  it("on ONE cell, Outline is its four sides -- the same preset", () => {
    const { calls } = plan(
      { borderTop: THIN, borderRight: THIN, borderBottom: THIN, borderLeft: THIN },
      { rect: ONE },
    );
    expect(calls).toEqual([{ kind: "preset", preset: "outside", style: "solid", color: "#000000", width: 1 }]);
  });

  it("each line style maps to the preset's style and weight", () => {
    const at = (style: BorderSide["style"]) =>
      plan({
        borderTop: { style, color: "#000000" },
        borderRight: { style, color: "#000000" },
        borderBottom: { style, color: "#000000" },
        borderLeft: { style, color: "#000000" },
      }).calls[0];
    expect(at("thick")).toMatchObject({ style: "solid", width: 3 });
    expect(at("dashed")).toMatchObject({ style: "dashed", width: 1 });
    expect(at("double")).toMatchObject({ style: "double", width: 1 });
  });
});

// ---------------------------------------------------------------------------
// A value the user CHOSE is written even when it equals the baseline
// ---------------------------------------------------------------------------
// Review finding (k), 2026-10-04. The baseline is the ACTIVE cell's style, and
// the dialog has no "mixed" state: on A1:A2 with A1 bold + Currency and A2
// plain, the dialog shows Bold and Currency, and a user who wants BOTH cells
// that way re-picks them and presses OK -- and the plan was EMPTY, so A2 stayed
// plain. A property the user touched is written, whatever its value; one they
// left alone is not (D5 stays: an untouched OK writes nothing).

describe("a TOUCHED property is written even when it equals the baseline", () => {
  function planTouched(
    change: Partial<FormatCellsSnapshot>,
    touched: Array<keyof FormatCellsSnapshot>,
    opts: { clearAll?: boolean } = {},
  ) {
    const baseline = { ...loaded(), bold: true, numberFormat: "currency_usd" };
    return planFormatCellsWrites(baseline, { ...baseline, ...change }, RANGE, opts.clearAll ?? false, new Set(touched));
  }

  it("Bold and Currency re-chosen on a mixed range: both written over the whole range", () => {
    expect(planTouched({}, ["bold", "numberFormat"]).calls).toEqual([
      { kind: "format", rows: ROWS, cols: COLS, formatting: { bold: true, numberFormat: "currency_usd" } },
    ]);
  });

  it("control: nothing touched, nothing changed -> nothing written (D5)", () => {
    expect(planTouched({}, [])).toEqual({ calls: [], protection: null });
  });

  it("a touched FILL control writes the fill", () => {
    const { calls } = planTouched({}, ["fillMode"]);
    expect(calls).toEqual([{ kind: "format", rows: ROWS, cols: COLS, formatting: { fill: { type: "none" } } }]);
  });

  it("a touched edge is written even when the corner already had it", () => {
    const { calls } = planTouched({}, ["borderBottom"]);
    expect(calls).toEqual([{ kind: "format", rows: [3], cols: COLS, formatting: { borderBottom: { ...NONE } } }]);
  });

  it("Outline re-chosen where the corners already showed it: still ONE outside preset", () => {
    const baseline = { ...loaded(), borderTop: THIN, borderRight: THIN, borderBottom: THIN, borderLeft: THIN };
    const { calls } = planFormatCellsWrites(
      baseline,
      { ...baseline },
      RANGE,
      false,
      new Set<keyof FormatCellsSnapshot>(["borderTop", "borderRight", "borderBottom", "borderLeft"]),
    );
    expect(calls).toEqual([{ kind: "preset", preset: "outside", style: "solid", color: "#000000", width: 1 }]);
  });

  it("after None (clear all) a touched 'none' side is not written twice", () => {
    const { calls } = planTouched({}, ["borderTop", "borderBottom", "borderLeft", "borderRight"], { clearAll: true });
    expect(calls).toEqual([{ kind: "preset", preset: "none", style: "solid", color: "#000000", width: 0 }]);
  });

  it("a touched Locked box writes the protection", () => {
    expect(planTouched({}, ["locked"]).protection).toEqual({ locked: true, formulaHidden: false });
  });
});

describe("the store records what the user touched", () => {
  it("every setter marks its key; loading and marking the baseline clear the marks", () => {
    const s = useFormatCellsStore.getState();
    s.reset();
    s.loadFromStyle({ bold: true });
    expect([...useFormatCellsStore.getState().touched]).toEqual([]);
    s.setBold(true);
    s.setNumberFormat("currency_usd");
    s.setBorderTop(THIN);
    s.setLocked(false);
    s.setPatternType("darkGray" as never);
    expect([...useFormatCellsStore.getState().touched].sort()).toEqual(
      ["bold", "borderTop", "locked", "numberFormat", "patternType"].sort(),
    );
    s.markBaseline();
    expect([...useFormatCellsStore.getState().touched]).toEqual([]);
    s.setItalic(true);
    s.reset();
    expect([...useFormatCellsStore.getState().touched]).toEqual([]);
  });

  it("the dialog's chrome (tab, range shape, category, None) is not a touched PROPERTY", () => {
    const s = useFormatCellsStore.getState();
    s.reset();
    s.setActiveTab("font");
    s.setRangeShape({ multiRow: true, multiCol: false });
    s.setNumberCategory("accounting");
    s.setBorderClearAll(true);
    expect([...useFormatCellsStore.getState().touched]).toEqual([]);
  });
});
