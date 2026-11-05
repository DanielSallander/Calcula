// FILENAME: app/scripts/lib/formulaPatterns.mjs
// PURPOSE: The pure half of the formula-pattern generator: decide which parsed
//          candidates ship, with what expectation, and render the artifact.
// CONTEXT: `gen-formula-patterns.mjs` parses `functions/*.md`, runs every
//          candidate through Calcula's engine and writes a checked-in library
//          that `npm run check:formula-patterns` re-derives and diffs. That
//          check is only worth having if it is DETERMINISTIC: the same tree must
//          render the same bytes on every run and on every day. It was not, in
//          two ways (BUG-0451, BUG-0452):
//
//            * A pattern calling TODAY() was recorded with the date it was
//              generated on (`TODAY#1.B2: 46303`, `TEXT#1.B4: "Invoice dated
//              October 8, 2026"`), so the check went stale at midnight and
//              stayed red until someone regenerated -- a test people learn to
//              ignore. The generator's own comment said volatile patterns carry
//              no recorded result; it computed the flag and the renderer never
//              read it.
//            * A sheet of `=RANDBETWEEN(1, 5)` cells only "settles" when every
//              cell happens to draw the same number twice in a row, so its
//              patterns were IN the library on some runs and errored ("the
//              fixture did not settle") on others, and the verified count moved
//              between 583 and 584 with nothing changed.
//
//          THE RULE. A function whose value is the CLOCK or the RNG -- not a
//          cell -- makes a pattern non-deterministic. Such a pattern ships
//          SHAPE-ONLY: its expectation names the kind of value (a number, a
//          text) and nothing else, its displayed result says it is volatile, and
//          whether its sheet "converged" is never consulted, because for a
//          clock or a dice roll that is chance. It still runs, so a volatile
//          pattern that starts returning an ERROR changes its kind and the check
//          catches it -- the part worth catching.
//
//          OFFSET, INDIRECT and CELL are volatile to the RECALCULATION engine
//          (`core/engine/src/volatility.rs`, reason 2), but over a fixed fixture
//          they return the same answer every time, so they keep their recorded
//          answers here. The set below is that file's reason 1, exactly.
//
//          Volatility FOLLOWS REFERENCES. `=B2+1` next to `B2: =TODAY()` is as
//          date-dependent as TODAY itself, while `=TEXT(A2, "0.0%")` on the same
//          sheet is not, and keeps its answer. The reference scan below errs in
//          one direction only: anything it cannot bound (INDIRECT, OFFSET, a
//          whole row or column, an A1-shaped token inside a string) counts as a
//          reference, so a mistake makes a pattern shape-only, never stale.

/**
 * Functions whose result is the clock or the RNG. Mirrors reason 1 of
 * `is_volatile_builtin` in `core/engine/src/volatility.rs`.
 */
export const NONDETERMINISTIC_FUNCTIONS = ["TODAY", "NOW", "RAND", "RANDBETWEEN", "RANDARRAY"];

const NONDETERMINISTIC_CALL = new RegExp(
  `(?<![A-Za-z0-9_])(${NONDETERMINISTIC_FUNCTIONS.join("|")})\\s*\\(`,
  "i",
);

/** Functions whose reach is computed at evaluation time, so no scan can bound it. */
const UNBOUNDED_REACH_CALL = /(?<![A-Za-z0-9_])(INDIRECT|OFFSET)\s*\(/i;

/** Does this formula text call a clock or RNG function anywhere in it? */
export function callsNondeterministic(formula) {
  return NONDETERMINISTIC_CALL.test(formula);
}

/** Column letters to a 1-based column number. */
function colNumber(letters) {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

/** A fixture address ("B12") as a 1-based `{ row, col }`, or null. */
function addressOf(a1) {
  const m = /^([A-Za-z]{1,3})(\d+)$/.exec(a1);
  return m ? { row: Number(m[2]), col: colNumber(m[1]) } : null;
}

const REF = String.raw`\$?([A-Za-z]{1,3})\$?(\d+)`;
const RANGE = new RegExp(String.raw`(?<![A-Za-z0-9_.])${REF}\s*:\s*${REF}(?![A-Za-z0-9_(])`, "g");
const SINGLE = new RegExp(String.raw`(?<![A-Za-z0-9_.:$])${REF}(?![A-Za-z0-9_(:])`, "g");
const WHOLE_COLUMNS = /(?<![A-Za-z0-9_.$])\$?([A-Za-z]{1,3})\s*:\s*\$?([A-Za-z]{1,3})(?![A-Za-z0-9_(])/g;
const WHOLE_ROWS = /(?<![A-Za-z0-9_.$])\$?(\d+)\s*:\s*\$?(\d+)(?![A-Za-z0-9_.(])/g;

/**
 * The cells a formula can read, as rectangles, or `unbounded: true` when the
 * text alone cannot say.
 *
 * Deliberately over-inclusive: string contents are scanned too, so `"Q1"` is
 * read as a reference to Q1. Over-inclusion only ever makes a pattern
 * shape-only; under-inclusion would let a date-dependent answer be recorded,
 * which is the defect this module exists to close.
 */
export function referencedRects(formula) {
  if (UNBOUNDED_REACH_CALL.test(formula)) return { unbounded: true, rects: [] };
  const rects = [];
  for (const m of formula.matchAll(RANGE)) {
    const c1 = colNumber(m[1]);
    const c2 = colNumber(m[3]);
    const r1 = Number(m[2]);
    const r2 = Number(m[4]);
    rects.push({
      r1: Math.min(r1, r2),
      r2: Math.max(r1, r2),
      c1: Math.min(c1, c2),
      c2: Math.max(c1, c2),
    });
  }
  for (const m of formula.matchAll(SINGLE)) {
    const row = Number(m[2]);
    const col = colNumber(m[1]);
    rects.push({ r1: row, r2: row, c1: col, c2: col });
  }
  for (const m of formula.matchAll(WHOLE_COLUMNS)) {
    const c1 = colNumber(m[1]);
    const c2 = colNumber(m[2]);
    rects.push({ r1: 1, r2: Infinity, c1: Math.min(c1, c2), c2: Math.max(c1, c2) });
  }
  for (const m of formula.matchAll(WHOLE_ROWS)) {
    const r1 = Number(m[1]);
    const r2 = Number(m[2]);
    rects.push({ r1: Math.min(r1, r2), r2: Math.max(r1, r2), c1: 1, c2: Infinity });
  }
  return { unbounded: false, rects };
}

/** Can a formula with this reach read the cell at `a1`? */
function reaches(reach, a1) {
  if (reach.unbounded) return true;
  const at = addressOf(a1);
  if (!at) return true; // an address this scan cannot place: assume it is read
  return reach.rects.some(
    (r) => at.row >= r.r1 && at.row <= r.r2 && at.col >= r.c1 && at.col <= r.c2,
  );
}

/**
 * How volatility touches one candidate.
 *
 *  - `sheet`  -- some formula on the sheet (fixture or target) calls a clock or
 *               RNG function, so whether the grader's iteration "converged" is
 *               chance and must not decide anything.
 *  - `target` -- the target's own value depends, directly or through the cells
 *               it reads (transitively), on such a function, so it can carry no
 *               recorded answer.
 */
export function volatilityOf(pattern) {
  const formulas = pattern.fixture
    .filter((c) => c.input.startsWith("="))
    .map((c) => ({ a1: c.a1, input: c.input }));
  const sheet =
    callsNondeterministic(pattern.formula) || formulas.some((c) => callsNondeterministic(c.input));
  if (!sheet) return { sheet: false, target: false };
  if (callsNondeterministic(pattern.formula)) return { sheet: true, target: true };

  // Fixed point over the fixture's formula cells: a cell is volatile when it
  // calls a clock/RNG function or reads a cell that is.
  const volatile = new Set(formulas.filter((c) => callsNondeterministic(c.input)).map((c) => c.a1));
  const reachOf = new Map(formulas.map((c) => [c.a1, referencedRects(c.input)]));
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of formulas) {
      if (volatile.has(c.a1)) continue;
      const reach = reachOf.get(c.a1);
      if ([...volatile].some((v) => reaches(reach, v))) {
        volatile.add(c.a1);
        grew = true;
      }
    }
  }
  const targetReach = referencedRects(pattern.formula);
  return { sheet: true, target: [...volatile].some((v) => reaches(targetReach, v)) };
}

/** What a volatile pattern shows as its result: the kind, never a value. */
export function volatileDisplay(kind) {
  return `(volatile ${kind})`;
}

/** Turn what the engine produced into an expectation a task can assert. */
function expectationFrom(o) {
  switch (o.kind) {
    case "number":
      return { kind: "number", number: o.number };
    case "text":
      return { kind: "text", text: o.text };
    case "boolean":
      return { kind: "boolean", boolean: o.boolean };
    case "error":
      return { kind: "error", error: o.error };
    case "blank":
      return { kind: "number", number: 0 };
    default:
      // A spill has no single-cell answer, and `other` is a contained list or
      // dict. Neither can be a scalar expectation, so neither ships.
      return null;
  }
}

/**
 * Sort every parsed candidate into verified / mismatched / unevaluable, given
 * the grader's results by id.
 *
 * Every output field is a function of the candidate and of the DETERMINISTIC
 * part of the grader's answer, so two runs over the same tree -- on different
 * days, with different dice -- produce identical lists.
 */
export function classifyPatterns(patterns, byId) {
  const verified = [];
  const mismatches = [];
  const errored = [];
  for (const p of patterns) {
    const r = byId.get(p.id);
    if (!r || r.error) {
      errored.push({ id: p.id, reason: r ? r.error : "the grader returned no result" });
      continue;
    }
    const vol = volatilityOf(p);
    // A sheet holding a clock or a dice roll can only "settle" by chance: a
    // `=RANDBETWEEN(1, 5)` column converges when every cell draws its previous
    // number again. Gating on it made the library's membership a coin toss.
    if (!r.converged && !vol.sheet) {
      errored.push({ id: p.id, reason: "the fixture did not settle" });
      continue;
    }
    const cell = r.cells[0];
    if (cell.outcome.parseError) {
      errored.push({ id: p.id, reason: `the formula did not parse: ${cell.outcome.parseError}` });
      continue;
    }

    // A doc claim is attached only to an example with exactly ONE formula, so
    // on a volatile sheet that formula IS the volatile one and `vol.target`
    // holds; the `vol.sheet` arm is defensive. The grader's verdict for it is
    // decided by convergence, i.e. by chance, so it is not read.
    if (vol.target || (vol.sheet && p.stated)) {
      const derived = expectationFrom(cell.outcome);
      if (!derived) {
        errored.push({
          id: p.id,
          reason: `the result is a ${cell.outcome.kind} and has no single-cell value`,
        });
        continue;
      }
      verified.push({
        ...p,
        expect: { kind: derived.kind },
        oracle: "engine",
        volatile: true,
        engineDisplay: volatileDisplay(derived.kind),
      });
      continue;
    }

    if (p.stated) {
      // THE DOC MADE A CLAIM. Agreement is the strongest evidence available --
      // a human wrote the answer and the engine independently reproduced it.
      if (cell.verdict && cell.verdict.matched) {
        verified.push({ ...p, expect: p.stated, oracle: "doc", volatile: false, engineDisplay: cell.outcome.display });
      } else if (p.statedResult.trim() === cell.outcome.display) {
        // THE TYPED COMPARISON DISAGREED BUT THE RENDERING IS IDENTICAL. This is
        // a classification error on the parser's side, not a disagreement about
        // the answer: `BIN2OCT` states "011" and returns the TEXT "011", which
        // the parser had read as the number 11. The document and the engine
        // plainly agree, so the pattern ships with a display expectation.
        verified.push({
          ...p,
          expect: { kind: "display", display: cell.outcome.display },
          oracle: "doc",
          volatile: false,
          engineDisplay: cell.outcome.display,
        });
      } else {
        // Excluded AND named. Either the document is stale or the engine has a
        // defect; both are worth someone's attention and neither is noise.
        mismatches.push({
          id: p.id,
          stated: p.statedResult,
          engine: cell.outcome.display,
          why: cell.verdict ? cell.verdict.reason : "no verdict",
        });
      }
      continue;
    }

    // NO ATTRIBUTABLE CLAIM. The example is still a real, realistic formula over
    // a real fixture, so it earns its place with the engine as its oracle --
    // which is what a retrieved example is for. It cannot catch an engine bug,
    // and is marked so nobody later mistakes it for evidence that it could.
    const derived = expectationFrom(cell.outcome);
    if (!derived) {
      errored.push({
        id: p.id,
        reason: `the result is a ${cell.outcome.kind} and has no single-cell value`,
      });
      continue;
    }
    verified.push({ ...p, expect: derived, oracle: "engine", volatile: false, engineDisplay: cell.outcome.display });
  }
  return { verified, mismatches, errored };
}

/** Render the checked-in TypeScript artifact. Pure: same input, same bytes. */
export function renderArtifact(verified, sourceHash) {
  const rows = verified
    .map((p) => {
      const e = p.expect;
      const expect = p.volatile
        ? `{ kind: ${JSON.stringify(e.kind)} }`
        : e.kind === "number"
          ? `{ kind: "number", number: ${e.number}${
              e.tolerance === undefined ? "" : `, tolerance: ${e.tolerance}`
            } }`
          : e.kind === "boolean"
            ? `{ kind: "boolean", boolean: ${e.boolean} }`
            : e.kind === "error"
              ? `{ kind: "error", error: ${JSON.stringify(e.error)} }`
              : e.kind === "display"
                ? `{ kind: "display", display: ${JSON.stringify(e.display)} }`
                : `{ kind: "text", text: ${JSON.stringify(e.text)} }`;
      const fixture = p.fixture
        .map((c) => `{ a1: ${JSON.stringify(c.a1)}, input: ${JSON.stringify(c.input)} }`)
        .join(", ");
      return [
        "  {",
        `    id: ${JSON.stringify(p.id)},`,
        `    fn: ${JSON.stringify(p.function)},`,
        `    intent: ${JSON.stringify(p.intent)},`,
        `    fixture: [${fixture}],`,
        `    target: ${JSON.stringify(p.target)},`,
        `    formula: ${JSON.stringify(p.formula)},`,
        `    expect: ${expect},`,
        `    oracle: ${JSON.stringify(p.oracle)},`,
        ...(p.volatile ? ["    volatile: true,"] : []),
        `    result: ${JSON.stringify(p.engineDisplay)},`,
        "  },",
      ].join("\n");
    })
    .join("\n");

  return `// GENERATED FILE — DO NOT EDIT.
// Produced by app/scripts/gen-formula-patterns.mjs from functions/*.md.
// Every entry below was evaluated by Calcula's own engine and reproduced the
// result its document states; candidates that did not are excluded and reported
// by the generator rather than silently dropped.
// Regenerate with:  npm run gen:formula-patterns
// Verify in CI with: npm run check:formula-patterns

export interface FormulaPatternCell {
  readonly a1: string;
  readonly input: string;
}

export interface FormulaPatternExpectation {
  readonly kind: "number" | "text" | "boolean" | "error" | "display";
  readonly number?: number;
  readonly text?: string;
  readonly boolean?: boolean;
  readonly error?: string;
  readonly display?: string;
  /** Absolute tolerance, set from the precision the source document stated. */
  readonly tolerance?: number;
}

export interface FormulaPattern {
  readonly id: string;
  readonly fn: string;
  readonly intent: string;
  readonly fixture: readonly FormulaPatternCell[];
  readonly target: string;
  readonly formula: string;
  /**
   * What the target evaluates to. For a \`volatile\` pattern this carries the
   * KIND only (no number, text or other value): its answer is the clock or the
   * RNG, and a recorded one would be wrong tomorrow.
   */
  readonly expect: FormulaPatternExpectation;
  /**
   * Where the expectation came from.
   *
   * "doc" — the function document states this answer AND Calcula's engine
   * independently reproduced it. Two agreeing sources; usable as an eval task.
   *
   * "engine" — the document's example carried no answer attributable to this
   * cell, so the engine's own result is the expectation. Fine for teaching a
   * model what a real formula looks like; it CANNOT detect an engine defect,
   * because the engine wrote the answer.
   */
  readonly oracle: "doc" | "engine";
  /**
   * Present (true) when the target depends, directly or through the cells it
   * reads, on TODAY, NOW, RAND, RANDBETWEEN or RANDARRAY. Such a pattern is
   * shape-only: \`expect\` names a kind and \`result\` says "(volatile <kind>)".
   */
  readonly volatile?: true;
  /** What the engine actually displayed, kept so a reader can see the answer. */
  readonly result: string;
}

/** sha256 (truncated) of the parsed candidates this artifact was built from. */
export const FORMULA_PATTERNS_SOURCE_HASH = ${JSON.stringify(sourceHash)};

export const FORMULA_PATTERNS: readonly FormulaPattern[] = [
${rows}
];
`;
}
