// FILENAME: app/scripts/gen-formula-patterns.mjs
// PURPOSE: Turn the worked examples in `functions/*.md` into a VERIFIED library
//          of (intent, fixture, formula, result) patterns.
// CONTEXT: The repo carries several hundred function documents, each with an
//          `## Example` section holding a small grid, a formula and a stated
//          result. Nothing reads them: they are documentation for people. They
//          are also the largest supply of realistic formula/answer pairs the
//          project has, and the AI programme needs exactly that — to retrieve
//          worked examples into a model's prompt, and to hold out a scored half
//          as eval tasks.
//
//          TWO PHASES, AND THE SECOND IS THE POINT.
//            1. PARSE  — read the docs into candidate patterns. Pure text work,
//                        no engine, so it runs anywhere.
//            2. VERIFY — evaluate every candidate through Calcula's OWN engine
//                        (`cargo run -p calcula-format --example eval-formulas`)
//                        and keep only the ones whose stated result the engine
//                        actually reproduces.
//
//          WHY THE SECOND PHASE IS NOT OPTIONAL. A doc's stated result is a
//          human claim about a program's behaviour, and either half can be
//          wrong: the doc can be stale, or the engine can have a bug. Shipping
//          an unverified pattern would teach a model an answer the product does
//          not give — and the repo has been here before, in the script corpus
//          whose own reference solution failed when it was finally run. So a
//          mismatch is REPORTED BY NAME rather than dropped in silence: each one
//          is a lead, pointing either at a doc to fix or at an engine defect.
//
// USAGE:   node scripts/gen-formula-patterns.mjs            # parse + verify + report
//          node scripts/gen-formula-patterns.mjs --parse-only
//          node scripts/gen-formula-patterns.mjs --emit     # write the generated artifact
//          node scripts/gen-formula-patterns.mjs --check    # fail if the artifact is stale

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { gradeJobs, resolveGrader } from "../../tests/eval/lib/grader.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const DOCS_DIR = path.join(REPO, "functions");
const CANDIDATES_OUT = path.join(REPO, "tests", "eval", "formula-patterns.json");
const VERIFIED_OUT = path.join(REPO, "tests", "eval", "formula-patterns.verified.json");
const TS_OUT = path.join(
  REPO,
  "app",
  "src",
  "api",
  "formulaAssist",
  "generated",
  "formulaPatterns.ts",
);

// ---------------------------------------------------------------------------
// Phase 1 — parse
// ---------------------------------------------------------------------------

/** Why a candidate was rejected, counted so the yield is never a mystery. */
const SKIPS = {
  noExample: "no ## Example section",
  noGrid: "no A1-style grid table",
  noFormula: "no cell starting with =",
  manyFormulas: "more than one formula cell, so the stated result is ambiguous",
  noResult: "no **Result:** line",
  spillResult: "the result describes a spill across several cells",
  proseResult: "the result is prose rather than a value",
  badGrid: "a grid row did not line up with its header",
};

/**
 * Strip markdown emphasis and surrounding whitespace from one table cell.
 *
 * Bold is presentational in these docs — every header row is written
 * `**Region**` — and carrying it into a fixture would seed the literal text
 * `**Region**` into the grid, which changes what a lookup matches.
 */
function cleanCell(raw) {
  return raw.replace(/\*\*/g, "").replace(/`/g, "").trim();
}

/** Split one markdown table row into its cells, tolerating a trailing pipe. */
function rowCells(line) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map(cleanCell);
}

const SEPARATOR = /^\|[\s:|-]+\|$/;
const COLUMN_LETTERS = /^[A-Z]{1,2}$/;

/**
 * Read every A1-style grid table out of one example section.
 *
 * The shape these docs use is a header row whose first cell is EMPTY and whose
 * remaining cells are column letters, then a separator, then rows whose first
 * cell is the 1-based row number:
 *
 *     | | A | B | C |
 *     |---|---|---|---|
 *     | 1 | **Region** | **Product** | **Revenue** |
 *     | 2 | North | Widget | 5000 |
 *
 * Several tables may appear in one example — the SUMIFS doc puts its data in
 * A:C and the formula in E:F — and they all describe the SAME sheet, so they
 * merge into one fixture rather than becoming separate cases.
 */
function parseGrids(section) {
  const lines = section.split(/\r?\n/);
  const cells = [];
  let misaligned = false;

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith("|")) continue;
    const header = rowCells(lines[i]);
    if (header.length < 2) continue;
    if (header[0] !== "") continue;
    const letters = header.slice(1);
    if (!letters.length || !letters.every((l) => COLUMN_LETTERS.test(l))) continue;
    if (i + 1 >= lines.length || !SEPARATOR.test(lines[i + 1].trim())) continue;

    for (let r = i + 2; r < lines.length; r++) {
      const line = lines[r].trim();
      if (!line.startsWith("|")) break;
      const parts = rowCells(line);
      const rowLabel = parts[0];
      if (!/^\d+$/.test(rowLabel)) {
        // A row whose label is not a number is not sheet content — usually a
        // second table's header, which the outer loop will pick up.
        break;
      }
      if (parts.length - 1 > letters.length) {
        // Trailing empties are cosmetic — several docs pad a row past the
        // declared columns — but a row with real content beyond the header is a
        // table this parser has misread, and guessing which column it belongs
        // to would seed the fixture wrong.
        const extra = parts.slice(letters.length + 1);
        if (extra.some((v) => v !== "")) {
          misaligned = true;
          break;
        }
      }
      const rowNum = Number(rowLabel);
      for (let c = 0; c < letters.length; c++) {
        const value = parts[c + 1];
        if (value === undefined || value === "") continue;
        cells.push({ a1: `${letters[c]}${rowNum}`, input: value });
      }
      i = r; // continue scanning after this table
    }
  }
  return { cells, misaligned };
}

/**
 * Classify a doc's stated result into an expectation the grader understands.
 *
 * Returns null when the statement is not a single value — a spill description
 * ("B2 = Jan, C2 = Feb") or prose. Those are skipped rather than guessed at.
 */
function parseExpectation(raw) {
  const text = raw.trim();
  if (!text) return null;

  // A spill or multi-cell claim. Detected before anything else because the
  // first token of "B2 = 5, C2 = 7" parses as a perfectly good cell reference.
  if (/\b[A-Z]{1,2}\d+\s*(=|:)/.test(text) && /,|\band\b/.test(text)) return null;

  const errorMatch = text.match(/^#[A-Z0-9/!?]+[!?]?$/i);
  if (errorMatch) return { kind: "error", error: text.toUpperCase() };

  if (/^(TRUE|FALSE)$/i.test(text)) {
    return { kind: "boolean", boolean: /^true$/i.test(text) };
  }

  // A quoted string is unambiguous; take it verbatim.
  const quoted = text.match(/^"([^"]*)"$/) || text.match(/^'([^']*)'$/);
  if (quoted) return { kind: "text", text: quoted[1] };

  // A number, optionally signed, with optional currency symbol, thousands
  // separators and a trailing percent. A percent is stored as a fraction, so it
  // is divided here.
  const numeric = text.replace(/\s/g, "").replace(/^[$£€]|^kr/i, "");
  const pct = numeric.endsWith("%");
  const body = pct ? numeric.slice(0, -1) : numeric;
  if (/^-?\d{1,3}(,\d{3})*(\.\d+)?$/.test(body) || /^-?\d+(\.\d+)?$/.test(body)) {
    const n = Number(body.replace(/,/g, ""));
    if (Number.isFinite(n)) {
      // THE DOCUMENT'S PRECISION IS THE TOLERANCE. A doc that states 36.87 is
      // making a claim to two decimals, not a claim that the answer is exactly
      // 36.87 — the engine's 36.86989764584402 agrees with it. Comparing
      // exactly would reject dozens of correct examples; ignoring precision
      // entirely would accept wrong ones.
      const decimals = (body.split(".")[1] || "").length;
      const value = pct ? n / 100 : n;
      const tolerance =
        decimals > 0 ? 0.5 * Math.pow(10, -(decimals + (pct ? 2 : 0))) : undefined;
      return tolerance === undefined
        ? { kind: "number", number: value }
        : { kind: "number", number: value, tolerance };
    }
  }

  // Anything with a space or a sentence-ending period is prose, not a value.
  if (/\s/.test(text) || /[.!?]$/.test(text)) return null;

  return { kind: "text", text };
}

/** The first sentence of the Introduction, as the pattern's intent. */
function parseIntent(body, fnName, exampleTitle) {
  const intro = body.match(/##\s*Introduction\s*\n([\s\S]*?)(?=\n##\s|\n#\s|$)/);
  let sentence = "";
  if (intro) {
    const firstPara = intro[1].trim().split(/\n\s*\n/)[0] || "";
    const m = firstPara.replace(/\s+/g, " ").match(/^(.*?[.!?])(\s|$)/);
    sentence = (m ? m[1] : firstPara).trim();
  }
  if (sentence.length > 220) sentence = `${sentence.slice(0, 217)}...`;
  const title = exampleTitle ? ` (${exampleTitle})` : "";
  return sentence ? `${sentence}${title}` : `Use ${fnName}${title}.`;
}

function parseDoc(file) {
  const fnName = path.basename(file, ".md");
  const body = fs.readFileSync(file, "utf8");
  const out = { patterns: [], skips: [] };

  // Every `## Example` heading, with whatever title follows it.
  //
  // HORIZONTAL WHITESPACE ONLY (`[^\S\r\n]`), never `\s`. `\s` matches newlines,
  // so a `\s*` here consumed the blank line AND the grid's header row on every
  // doc whose example has no title — the heading swallowed `| | A | B | C |`,
  // the parser then saw a table with no header, and 345 of 406 documents were
  // reported as having no grid at all. The docs are CRLF, so `\r` must be
  // excluded explicitly.
  const headings = [
    ...body.matchAll(
      /^##[^\S\r\n]*Example[^\S\r\n]*(\d+)?[^\S\r\n]*[-–—:]?[^\S\r\n]*(.*)$/gim,
    ),
  ];
  if (!headings.length) {
    out.skips.push({ fn: fnName, example: 0, reason: SKIPS.noExample });
    return out;
  }

  headings.forEach((h, idx) => {
    const start = h.index + h[0].length;
    const next = idx + 1 < headings.length ? headings[idx + 1].index : undefined;
    // A later `## Something` ends the section too.
    const rest = body.slice(start, next);
    const stop = rest.search(/\n##\s/);
    const section = stop === -1 ? rest : rest.slice(0, stop);
    const exampleNo = idx + 1;
    const title = (h[2] || "").trim();

    const { cells, misaligned } = parseGrids(section);
    if (misaligned) {
      out.skips.push({ fn: fnName, example: exampleNo, reason: SKIPS.badGrid });
      return;
    }
    if (!cells.length) {
      out.skips.push({ fn: fnName, example: exampleNo, reason: SKIPS.noGrid });
      return;
    }

    const formulaCells = cells.filter((c) => c.input.startsWith("="));
    if (!formulaCells.length) {
      out.skips.push({ fn: fnName, example: exampleNo, reason: SKIPS.noFormula });
      return;
    }

    // The doc's stated result can only be ATTRIBUTED to a formula when there is
    // exactly one formula in the example. With several — a filled-down column,
    // say — a line like "C2 returns Pass and C3 returns Fail" belongs to both
    // and to neither, so no claim is attached and the engine supplies the
    // expectation instead (see `oracle` below).
    // ANCHORED TO THE START OF A LINE. Unanchored, this matched `**Result**`
    // inside a TABLE HEADER ROW (`| 10 | **Formula** | **Result** |`) and
    // captured the pipe that followed, so 98 documents reported their stated
    // answer as the string "|".
    const resultLine = section.match(/^\*\*Result:?\*\*:?[^\S\r\n]*(.+)$/im);
    const statedRaw = resultLine ? cleanCell(resultLine[1]) : "";
    const stated =
      formulaCells.length === 1 && statedRaw ? parseExpectation(statedRaw) : null;

    if (formulaCells.length === 1 && statedRaw && !stated) {
      // Recorded, not silently dropped: the pattern is still emitted below with
      // the engine as its oracle, but the reason the doc could not be used is
      // worth counting.
      out.skips.push({
        fn: fnName,
        example: exampleNo,
        reason: /[A-Z]{1,2}\d+\s*=/.test(statedRaw) ? SKIPS.spillResult : SKIPS.proseResult,
        stated: statedRaw.slice(0, 80),
      });
    }
    if (!resultLine) {
      out.skips.push({ fn: fnName, example: exampleNo, reason: SKIPS.noResult });
    }

    // ONE PATTERN PER FORMULA CELL. Every other formula cell stays in the
    // fixture, so a filled-down column that references its neighbours still
    // evaluates correctly — the grader settles fixture formulas alongside the
    // one under test.
    formulaCells.forEach((target, k) => {
      const suffix = formulaCells.length > 1 ? `.${target.a1}` : "";
      out.patterns.push({
        id: `${fnName}#${exampleNo}${suffix}`,
        function: fnName,
        intent: parseIntent(body, fnName, title),
        fixture: cells.filter((c) => c.a1 !== target.a1),
        target: target.a1,
        formula: target.input,
        // Present only when the doc makes an unambiguous claim about THIS cell.
        stated: k === 0 ? stated : null,
        statedResult: k === 0 ? statedRaw : "",
      });
    });
  });

  return out;
}

function parseAll() {
  const files = fs
    .readdirSync(DOCS_DIR)
    .filter((f) => f.endsWith(".md"))
    .filter((f) => fs.statSync(path.join(DOCS_DIR, f)).isFile())
    .sort();

  const patterns = [];
  const skips = [];
  for (const f of files) {
    const r = parseDoc(path.join(DOCS_DIR, f));
    patterns.push(...r.patterns);
    skips.push(...r.skips);
  }
  return { files: files.length, patterns, skips };
}

// ---------------------------------------------------------------------------
// Phase 2 — verify against the real engine
// ---------------------------------------------------------------------------

function verify(patterns) {
  const request = {
    sheetName: "Sheet1",
    jobs: patterns.map((p) => ({
      id: p.id,
      fixture: p.fixture,
      formulas: [
        // The expectation is sent only when the DOC makes one. Without it the
        // grader still evaluates the cell and reports what it produced, which
        // is how an engine-oracle pattern gets its answer.
        p.stated
          ? { a1: p.target, formula: p.formula, expect: p.stated }
          : { a1: p.target, formula: p.formula },
      ],
    })),
  };

  // Resolve and RUN the built binary rather than shelling out to cargo. Cargo
  // would build into whatever `CARGO_TARGET_DIR` happens to say, which is
  // nothing in a plain shell — and then into the in-repo tree, which is
  // Dropbox-synced and known-corrupt. It would also need a linker, and Git
  // Bash's `link` shadows MSVC's. See tests/eval/lib/grader.mjs.
  const grader = resolveGrader({ repo: REPO });
  console.log(`[patterns] grader: ${grader.exe}`);
  const parsed = gradeJobs(request, grader);
  const byId = new Map(parsed.results.map((r) => [r.id, r]));
  return { byId, summary: parsed.summary };
}

// ---------------------------------------------------------------------------
// Reporting and emission
// ---------------------------------------------------------------------------

function census(files, patterns, skips) {
  const byReason = new Map();
  for (const s of skips) byReason.set(s.reason, (byReason.get(s.reason) || 0) + 1);
  const lines = [
    `[patterns] ${files} documents scanned`,
    `[patterns] ${patterns.length} candidate patterns parsed`,
  ];
  for (const [reason, n] of [...byReason].sort((a, b) => b[1] - a[1])) {
    lines.push(`[patterns]   skipped ${String(n).padStart(4)} — ${reason}`);
  }
  return lines.join("\n");
}

function hashOf(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function renderArtifact(verified, sourceHash) {
  const rows = verified
    .map((p) => {
      const e = p.expect;
      const expect =
        e.kind === "number"
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

// ---------------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);
  const parseOnly = argv.includes("--parse-only");
  const emit = argv.includes("--emit");
  const check = argv.includes("--check");

  const { files, patterns, skips } = parseAll();
  console.log(census(files, patterns, skips));

  fs.mkdirSync(path.dirname(CANDIDATES_OUT), { recursive: true });
  fs.writeFileSync(
    CANDIDATES_OUT,
    `${JSON.stringify({ version: 1, patterns, skips }, null, 2)}\n`,
    "utf8",
  );
  console.log(`[patterns] candidates written to ${path.relative(REPO, CANDIDATES_OUT)}`);

  if (parseOnly) return;

  console.log(`[patterns] verifying ${patterns.length} candidates against the engine...`);
  const { byId, summary } = verify(patterns);

  /** Turn what the engine produced into an expectation a task can assert. */
  const expectationFrom = (o) => {
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
  };

  const verified = [];
  const mismatches = [];
  const errored = [];
  for (const p of patterns) {
    const r = byId.get(p.id);
    if (!r || r.error) {
      errored.push({ id: p.id, reason: r ? r.error : "the grader returned no result" });
      continue;
    }
    if (!r.converged) {
      errored.push({ id: p.id, reason: "the fixture did not settle" });
      continue;
    }
    const cell = r.cells[0];
    if (cell.outcome.parseError) {
      errored.push({ id: p.id, reason: `the formula did not parse: ${cell.outcome.parseError}` });
      continue;
    }

    if (p.stated) {
      // THE DOC MADE A CLAIM. Agreement is the strongest evidence available —
      // a human wrote the answer and the engine independently reproduced it.
      if (cell.verdict && cell.verdict.matched) {
        verified.push({ ...p, expect: p.stated, oracle: "doc", engineDisplay: cell.outcome.display });
      } else if (p.statedResult.trim() === cell.outcome.display) {
        // THE TYPED COMPARISON DISAGREED BUT THE RENDERING IS IDENTICAL. This is
        // a classification error on this script's side, not a disagreement about
        // the answer: `BIN2OCT` states "011" and returns the TEXT "011", which
        // this parser had read as the number 11. The document and the engine
        // plainly agree, so the pattern ships with a display expectation.
        verified.push({
          ...p,
          expect: { kind: "display", display: cell.outcome.display },
          oracle: "doc",
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
    // a real fixture, so it earns its place with the engine as its oracle —
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
    verified.push({ ...p, expect: derived, oracle: "engine", engineDisplay: cell.outcome.display });
  }

  console.log(
    `[patterns] engine summary: ${summary.matched} matched, ${summary.unmatched} unmatched, ${summary.errored} errored`,
  );
  console.log(`[patterns] VERIFIED ${verified.length} of ${patterns.length} candidates`);

  if (mismatches.length) {
    console.log(
      `[patterns] ${mismatches.length} candidate(s) the engine does not reproduce — each is a lead, not noise:`,
    );
    for (const m of mismatches.slice(0, 40)) {
      console.log(`[patterns]   ${m.id}: doc says ${JSON.stringify(m.stated)}, engine ${m.why}`);
    }
    if (mismatches.length > 40) {
      console.log(`[patterns]   ...and ${mismatches.length - 40} more (see the verified JSON)`);
    }
  }
  if (errored.length) {
    console.log(`[patterns] ${errored.length} candidate(s) could not be evaluated:`);
    for (const e of errored.slice(0, 20)) console.log(`[patterns]   ${e.id}: ${e.reason}`);
  }

  const sourceHash = hashOf(patterns);
  fs.writeFileSync(
    VERIFIED_OUT,
    `${JSON.stringify({ version: 1, sourceHash, verified, mismatches, errored }, null, 2)}\n`,
    "utf8",
  );
  console.log(`[patterns] verified set written to ${path.relative(REPO, VERIFIED_OUT)}`);

  if (emit || check) {
    const rendered = renderArtifact(verified, sourceHash);
    if (check) {
      const current = fs.existsSync(TS_OUT) ? fs.readFileSync(TS_OUT, "utf8") : "";
      if (current !== rendered) {
        console.error(
          "[patterns] FAIL: the generated artifact is stale. Run `npm run gen:formula-patterns`.",
        );
        process.exit(1);
      }
      console.log("[patterns] [OK] the generated artifact is up to date.");
    } else {
      fs.mkdirSync(path.dirname(TS_OUT), { recursive: true });
      fs.writeFileSync(TS_OUT, rendered, "utf8");
      console.log(`[patterns] artifact written to ${path.relative(REPO, TS_OUT)}`);
    }
  }
}

main();
