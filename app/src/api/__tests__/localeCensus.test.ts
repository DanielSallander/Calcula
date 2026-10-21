//! FILENAME: app/src/api/__tests__/localeCensus.test.ts
// PURPOSE: The locale RATCHET (P2 S11). Display text and user input are
//          formatted and read in the APP locale through @api/locale
//          (formatNumber / parseNumber / formatDate ...). The shapes that
//          bypass it cannot be banned outright by a lint rule -- a `toFixed`
//          in a [PERF] log, a `parseFloat` of a stored geometry literal and a
//          `Number(e.target.value)` of a <select> option are all correct -- so
//          they are COUNTED per production file instead, against an allowlist
//          where every entry says why it is not display
//          (fixtures/localeCensusAllowlist.json).
// CONTEXT: The hard bans (toLocaleString, Intl.NumberFormat/DateTimeFormat,
//          getCachedLocale, parseDisplayNumber) are lint errors in
//          eslint.boundaries.js (`dialogGuardConfigs`), proved by
//          localeGlobalsBan.test.ts. This file is the second half: the shapes
//          that are SOMETIMES right.
//
//          The shapes counted, per production file under src/ and extensions/
//          (tests, specs and .d.ts excluded; comment-only lines skipped):
//            - `.toFixed(`            -- invariant digits, binary rounding;
//            - `parseFloat(`          -- reads only the invariant spelling and
//                                        stops at the first foreign character
//                                        (de-DE "1,5" reads 1);
//            - `Number(e.target.value)` / `Number(raw)` -- the same for a typed box;
//            - `.replace(/[^0-9`      -- the display re-parse that strips
//                                        everything but digits.
//
//          A file holding MORE of a shape than its entry allows, or any of a
//          shape it has no entry for, fails naming the file and every hit line.
//          A file holding FEWER fails too (stale entry): the allowlist must
//          ratchet down when a hit is removed, or a later display hit could
//          take the freed slot unnoticed.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const APP = path.resolve(__dirname, "../../..");
const ALLOWLIST_PATH = path.join(__dirname, "fixtures", "localeCensusAllowlist.json");

/** The shapes, by the key the allowlist uses. Exported for the self-test below. */
export const LOCALE_CENSUS_SHAPES: Record<string, RegExp> = {
  toFixed: /\.toFixed\(/g,
  // `Number.parseFloat(` counts too (preceded by "."), a `myparseFloat(` does not.
  parseFloat: /(?<![\w$])parseFloat\(/g,
  // `formatSeriesNumber(raw)` / `parseNumber(raw)` are NOT this shape.
  numberOfRaw: /(?<![\w$.])Number\((?:e\.target\.value|raw)\)/g,
  regexReparse: /\.replace\(\/\[\^0-9/g,
};

const REASONS = new Set([
  "css-px",
  "geometry",
  "log",
  "wire",
  "internal",
  "script-source",
  "test-harness",
  "unloaded",
]);

interface AllowEntry {
  counts: Record<string, number>;
  reason: string;
  note: string;
}

interface Allowlist {
  files: Record<string, AllowEntry>;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "__tests__") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (
      /\.(ts|tsx)$/.test(entry.name) &&
      !/\.(test|spec)\.tsx?$/.test(entry.name) &&
      !entry.name.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

const rel = (full: string) => path.relative(APP, full).replace(/\\/g, "/");

export interface CensusHit {
  shape: string;
  line: number;
  text: string;
}

/** Every counted hit in one source text. Comment-only lines are skipped. */
export function censusHits(source: string): CensusHit[] {
  const hits: CensusHit[] = [];
  source.split(/\r?\n/).forEach((lineText, i) => {
    const t = lineText.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
    for (const [shape, re] of Object.entries(LOCALE_CENSUS_SHAPES)) {
      const n = (lineText.match(re) ?? []).length;
      for (let k = 0; k < n; k++) hits.push({ shape, line: i + 1, text: t.slice(0, 160) });
    }
  });
  return hits;
}

function scanTree(): Map<string, CensusHit[]> {
  const files = [...walk(path.join(APP, "src")), ...walk(path.join(APP, "extensions"))];
  const byFile = new Map<string, CensusHit[]>();
  for (const full of files) {
    const hits = censusHits(fs.readFileSync(full, "utf8"));
    if (hits.length > 0) byFile.set(rel(full), hits);
  }
  return byFile;
}

function countsOf(hits: CensusHit[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const h of hits) out[h.shape] = (out[h.shape] ?? 0) + 1;
  return out;
}

const allowlist = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, "utf8")) as Allowlist;
const tree = scanTree();

describe("the locale census (ratchet)", () => {
  it("no production file holds a counted shape beyond its allowlisted count", () => {
    const failures: string[] = [];
    for (const [file, hits] of tree) {
      const allowed = allowlist.files[file]?.counts ?? {};
      const actual = countsOf(hits);
      for (const [shape, n] of Object.entries(actual)) {
        const max = allowed[shape] ?? 0;
        if (n > max) {
          const lines = hits.filter((h) => h.shape === shape).map((h) => `    ${file}:${h.line}  ${h.text}`);
          failures.push(
            `${file}: ${n} x ${shape} (allowlisted ${max}). Use @api/locale (formatNumber / parseNumber) ` +
              `for display text and typed input, or add an entry WITH a reason if this is not display:\n` +
              lines.join("\n"),
          );
        }
      }
    }
    expect(failures, failures.join("\n\n")).toEqual([]);
  });

  it("no allowlist entry is stale (the count ratchets down when a hit is removed)", () => {
    const stale: string[] = [];
    for (const [file, entry] of Object.entries(allowlist.files)) {
      const actual = countsOf(tree.get(file) ?? []);
      for (const [shape, max] of Object.entries(entry.counts)) {
        const n = actual[shape] ?? 0;
        if (n < max) stale.push(`${file}: ${shape} allowlisted ${max}, found ${n} -- lower the entry`);
      }
    }
    expect(stale, stale.join("\n")).toEqual([]);
  });

  it("every allowlist entry is classified: a known reason, a note, and only known shapes", () => {
    const bad: string[] = [];
    for (const [file, entry] of Object.entries(allowlist.files)) {
      if (!REASONS.has(entry.reason)) bad.push(`${file}: unknown reason "${entry.reason}"`);
      if (typeof entry.note !== "string" || entry.note.trim().length < 8) bad.push(`${file}: no note`);
      for (const shape of Object.keys(entry.counts)) {
        if (!(shape in LOCALE_CENSUS_SHAPES)) bad.push(`${file}: unknown shape "${shape}"`);
      }
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("the swept app-locale files stay at zero (the files P2 moved onto @api/locale)", () => {
    // Not an allowlist question: these are the display sites the P2 sweep
    // fixed, named so that one regressing reads as what it is.
    const swept = [
      "extensions/Charts/rendering/visuals/visualValues.ts",
      "extensions/Charts/lib/chartFieldTypes.ts",
      "extensions/Charts/lib/encodingResolver.ts",
      "extensions/BuiltIn/StatusBarAggregation/StatusBarAggregationWidget.tsx",
      "extensions/CellTypes/types/progress.ts",
      "extensions/Sparklines/rendering.ts",
      "extensions/FillSeries/lib/seriesPlan.ts",
      "extensions/GoalSeek/components/GoalSeekDialog.tsx",
      "src/api/layout/primitives/fields.tsx",
      "src/api/scriptHost/host.ts",
      "src/shell/dialogs/DimensionInputDialog.tsx",
    ];
    const regressed = swept.filter((f) => tree.has(f)).map((f) => `${f}: ${JSON.stringify(countsOf(tree.get(f)!))}`);
    expect(regressed, regressed.join("\n")).toEqual([]);
    for (const f of swept) expect(allowlist.files[f], `${f} must not be allowlisted`).toBeUndefined();
  });
});

describe("the census scanner itself", () => {
  it("counts each shape, including two on one line", () => {
    const hits = censusHits(
      [
        "const a = x.toFixed(2) + y.toFixed(1);",
        "const b = parseFloat(s);",
        "const c = Number.parseFloat(s);",
        "const d = Number(e.target.value);",
        "const e2 = Number(raw);",
        "const f = s.replace(/[^0-9.]/g, '');",
      ].join("\n"),
    );
    expect(countsOf(hits)).toEqual({ toFixed: 2, parseFloat: 2, numberOfRaw: 2, regexReparse: 1 });
    expect(hits.find((h) => h.shape === "regexReparse")?.line).toBe(6);
  });

  it("does not count look-alikes or comment-only lines", () => {
    const hits = censusHits(
      [
        "// the old parseFloat(x) and x.toFixed(2) are gone",
        " * Number(raw) in a doc comment",
        "/* parseFloat(a) */",
        "const a = formatSeriesNumber(raw);",
        "const b = parseNumber(raw);",
        "const c = myparseFloat(s);",
        "const d = Number(rawText);",
      ].join("\n"),
    );
    expect(hits).toEqual([]);
  });
});
