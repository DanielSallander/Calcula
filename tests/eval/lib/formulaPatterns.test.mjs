//! FILENAME: tests/eval/lib/formulaPatterns.test.mjs
// PURPOSE: The verified formula-pattern library (the one the eval mines its
//          held-out tasks from and the formula assistant retrieves examples
//          from) renders the SAME BYTES whatever day it is generated on and
//          whatever the dice say.
// CONTEXT: `npm run check:formula-patterns` re-derives the checked-in
//          `app/src/api/formulaAssist/generated/formulaPatterns.ts` and fails
//          when it differs. Two defects made that check lie:
//            BUG-0451 -- TODAY-based answers were recorded (`TODAY#1.B2: 46303`),
//                        so the check went stale every midnight.
//            BUG-0452 -- a sheet of RANDBETWEEN cells "settled" about one run in
//                        six, so three patterns joined and left the library by
//                        chance and the verified count moved 583 / 584.
//          These tests drive the generator's pure half
//          (`app/scripts/lib/formulaPatterns.mjs`) with two SIMULATED grader runs
//          that differ only in what a clock and an RNG would change -- the date,
//          the random draws, and whether the random sheet happened to converge --
//          and require identical output. No engine is needed, so this runs in
//          the ordinary vitest gate rather than only where the grader is built.

import { describe, it, expect } from "vitest";

import {
  classifyPatterns,
  renderArtifact,
  volatilityOf,
  referencedRects,
  callsNondeterministic,
  NONDETERMINISTIC_FUNCTIONS,
} from "../../../app/scripts/lib/formulaPatterns.mjs";
import { FORMULA_PATTERNS } from "../../../app/src/api/formulaAssist/generated/formulaPatterns.ts";

/** A parsed candidate in the shape `gen-formula-patterns.mjs` produces. */
function candidate(id, target, formula, fixture, stated = null) {
  return {
    id,
    function: id.split("#")[0],
    intent: `Use ${id.split("#")[0]}.`,
    fixture,
    target,
    formula,
    stated,
    statedResult: stated ? String(stated.number ?? stated.text ?? "") : "",
  };
}

// TODAY#1-like: three formulas on one sheet, all reading the clock.
const todaySheet = [
  { a1: "B2", input: "=TODAY()" },
  { a1: "B3", input: "1990-06-15" },
  { a1: "B4", input: "=TODAY()-B3" },
  { a1: "B5", input: "=DATEDIF(B3, TODAY(), \"Y\")" },
];
// TEXT#1-like: two deterministic formulas beside one date-dependent one.
const textSheet = [
  { a1: "A2", input: "1234567.8" },
  { a1: "B2", input: "=TEXT(A2, \"$#,##0.00\")" },
  { a1: "A3", input: "0.156" },
  { a1: "B3", input: "=TEXT(A3, \"0.0%\")" },
  { a1: "B4", input: "=\"Invoice dated \" & TEXT(TODAY(), \"mmmm d, yyyy\")" },
];
// RANDBETWEEN#1-like: three dice.
const diceSheet = [
  { a1: "B2", input: "=RANDBETWEEN(1, 5)" },
  { a1: "B3", input: "=RANDBETWEEN(1, 5)" },
  { a1: "B4", input: "=RANDBETWEEN(1, 5)" },
];

function others(sheet, target) {
  return sheet.filter((c) => c.a1 !== target);
}

const PATTERNS = [
  candidate("TODAY#1.B2", "B2", "=TODAY()", others(todaySheet, "B2")),
  candidate("TODAY#1.B4", "B4", "=TODAY()-B3", others(todaySheet, "B4")),
  candidate("TODAY#1.B5", "B5", "=DATEDIF(B3, TODAY(), \"Y\")", others(todaySheet, "B5")),
  candidate("TEXT#1.B2", "B2", textSheet[1].input, others(textSheet, "B2")),
  candidate("TEXT#1.B3", "B3", textSheet[3].input, others(textSheet, "B3")),
  candidate("TEXT#1.B4", "B4", textSheet[4].input, others(textSheet, "B4")),
  candidate("RANDBETWEEN#1.B2", "B2", "=RANDBETWEEN(1, 5)", others(diceSheet, "B2")),
  candidate("RANDBETWEEN#1.B3", "B3", "=RANDBETWEEN(1, 5)", others(diceSheet, "B3")),
  candidate("RANDBETWEEN#1.B4", "B4", "=RANDBETWEEN(1, 5)", others(diceSheet, "B4")),
  candidate("SUM#1", "A4", "=SUM(A1:A3)", [
    { a1: "A1", input: "1" },
    { a1: "A2", input: "2" },
    { a1: "A3", input: "3" },
  ], { kind: "number", number: 6 }),
];

function number(n) {
  return { kind: "number", display: String(n), number: n };
}
function text(t) {
  return { kind: "text", display: t, text: t };
}

/**
 * What the grader would answer on a given day with given dice. Only the
 * clock- and RNG-dependent parts move between the two runs below; the
 * deterministic cells answer the same both times.
 */
function graderRun({ serial, dateText, ageDays, ageYears, dice, diceConverged }) {
  const results = new Map();
  const put = (id, converged, outcome, verdict) =>
    results.set(id, { id, converged, passes: 3, cells: [{ outcome, verdict }] });
  put("TODAY#1.B2", true, number(serial));
  put("TODAY#1.B4", true, number(ageDays));
  put("TODAY#1.B5", true, number(ageYears));
  put("TEXT#1.B2", true, text("$1,234,567.80"));
  put("TEXT#1.B3", true, text("15.6%"));
  put("TEXT#1.B4", true, text(`Invoice dated ${dateText}`));
  put("RANDBETWEEN#1.B2", diceConverged, number(dice[0]));
  put("RANDBETWEEN#1.B3", diceConverged, number(dice[1]));
  put("RANDBETWEEN#1.B4", diceConverged, number(dice[2]));
  put("SUM#1", true, number(6), { matched: true });
  return results;
}

const OCTOBER_8 = graderRun({
  serial: 46303,
  dateText: "October 8, 2026",
  ageDays: 13264,
  ageYears: 36,
  dice: [3, 1, 4],
  diceConverged: true, // the one-run-in-six lucky draw
});
const NOVEMBER_4 = graderRun({
  serial: 46330,
  dateText: "November 4, 2026",
  ageDays: 13291,
  ageYears: 36,
  dice: [5, 2, 2],
  diceConverged: false,
});

function render(byId) {
  const { verified } = classifyPatterns(PATTERNS, byId);
  return renderArtifact(verified, "0000000000000000");
}

describe("formula-pattern library determinism (BUG-0451 / BUG-0452)", () => {
  it("renders identical bytes on two days with different dice", () => {
    expect(render(NOVEMBER_4)).toBe(render(OCTOBER_8));
  });

  it("a random sheet that did not settle still ships, shape-only (membership is not chance)", () => {
    for (const run of [OCTOBER_8, NOVEMBER_4]) {
      const { verified, errored } = classifyPatterns(PATTERNS, run);
      const ids = verified.map((p) => p.id);
      expect(ids).toEqual(PATTERNS.map((p) => p.id));
      expect(errored).toEqual([]);
      const dice = verified.find((p) => p.id === "RANDBETWEEN#1.B3");
      expect(dice.expect).toEqual({ kind: "number" });
      expect(dice.volatile).toBe(true);
      expect(dice.engineDisplay).toBe("(volatile number)");
    }
  });

  it("a date-dependent target records no value, directly or through a cell it reads", () => {
    const { verified } = classifyPatterns(PATTERNS, OCTOBER_8);
    for (const id of ["TODAY#1.B2", "TODAY#1.B4", "TODAY#1.B5", "TEXT#1.B4"]) {
      const p = verified.find((v) => v.id === id);
      expect(p.volatile, id).toBe(true);
      expect(Object.keys(p.expect), id).toEqual(["kind"]);
      expect(p.engineDisplay, id).toMatch(/^\(volatile (number|text)\)$/);
    }
    const artifact = render(OCTOBER_8);
    expect(artifact).not.toContain("46303");
    expect(artifact).not.toContain("October 8, 2026");
    // The rendered row names the kind and nothing else -- not `number: undefined`.
    expect(artifact).not.toContain("undefined");
    expect(artifact).toContain(
      '    formula: "=TODAY()",\n    expect: { kind: "number" },\n    oracle: "engine",\n    volatile: true,\n    result: "(volatile number)",\n',
    );
  });

  it("a deterministic formula on a volatile sheet keeps its recorded answer", () => {
    const { verified } = classifyPatterns(PATTERNS, NOVEMBER_4);
    const b3 = verified.find((v) => v.id === "TEXT#1.B3");
    expect(b3.volatile).toBe(false);
    expect(b3.expect).toEqual({ kind: "text", text: "15.6%" });
    const sum = verified.find((v) => v.id === "SUM#1");
    expect(sum.oracle).toBe("doc");
    expect(sum.expect).toEqual({ kind: "number", number: 6 });
  });

  it("a non-volatile sheet that does not settle is still refused", () => {
    const byId = graderRun({
      serial: 1, dateText: "x", ageDays: 1, ageYears: 1, dice: [1, 1, 1], diceConverged: true,
    });
    byId.set("SUM#1", { id: "SUM#1", converged: false, passes: 99, cells: [{ outcome: number(6) }] });
    const { errored } = classifyPatterns(PATTERNS, byId);
    expect(errored).toEqual([{ id: "SUM#1", reason: "the fixture did not settle" }]);
  });
});

describe("volatility follows references, and errs only toward shape-only", () => {
  const sheet = (formula, fixture) => volatilityOf({ formula, fixture });

  it("names exactly the clock and RNG functions", () => {
    expect(NONDETERMINISTIC_FUNCTIONS).toEqual(["TODAY", "NOW", "RAND", "RANDBETWEEN", "RANDARRAY"]);
    expect(callsNondeterministic("=ROUND(now(), 2)")).toBe(true);
    expect(callsNondeterministic("=_xlfn.RANDARRAY(3)")).toBe(true);
    expect(callsNondeterministic("=OFFSET(A1, 1, 0)")).toBe(false);
    expect(callsNondeterministic("=MYRAND(1)")).toBe(false);
  });

  it("a chain through fixture cells is followed", () => {
    const fx = [
      { a1: "B2", input: "=TODAY()" },
      { a1: "C2", input: "=B2+1" },
      { a1: "A1", input: "5" },
    ];
    expect(sheet("=C2*2", fx)).toEqual({ sheet: true, target: true });
    expect(sheet("=A1*2", fx)).toEqual({ sheet: true, target: false });
    expect(sheet("=A1*2", [{ a1: "A1", input: "5" }])).toEqual({ sheet: false, target: false });
  });

  it("ranges, whole columns, whole rows and unbounded reach all count as reading the cell", () => {
    const fx = [{ a1: "C7", input: "=RAND()" }];
    expect(sheet("=SUM(A1:D9)", fx).target).toBe(true);
    expect(sheet("=SUM($B$1:$D$7)", fx).target).toBe(true);
    expect(sheet("=SUM(C:C)", fx).target).toBe(true);
    expect(sheet("=SUM(7:7)", fx).target).toBe(true);
    expect(sheet("=INDIRECT(\"A1\")", fx).target).toBe(true);
    expect(sheet("=OFFSET(A1, 6, 2)", fx).target).toBe(true);
    expect(sheet("=SUM(A1:B9)", fx).target).toBe(false);
    expect(sheet("=SUM(D:E)", fx).target).toBe(false);
  });

  it("an A1-shaped token inside a string is over-included, never missed", () => {
    expect(referencedRects("=\"C7\"").rects).toEqual([{ r1: 7, r2: 7, c1: 3, c2: 3 }]);
  });
});

describe("the checked-in library", () => {
  it("records no answer for any pattern whose formula reads the clock or the RNG", () => {
    const offenders = FORMULA_PATTERNS.filter(
      (p) =>
        callsNondeterministic(p.formula) &&
        (p.volatile !== true || Object.keys(p.expect).join() !== "kind" || !/^\(volatile /.test(p.result)),
    ).map((p) => `${p.id}: ${JSON.stringify(p.expect)} ${p.result}`);
    expect(offenders).toEqual([]);
    expect(FORMULA_PATTERNS.some((p) => p.volatile === true)).toBe(true);
  });
});
