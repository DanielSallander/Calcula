//! FILENAME: app/src/api/__tests__/sheetNameFoldCensus.test.ts
// PURPOSE: The sheet-name fold RATCHET. Two sheet names are the same name by
//          Excel's measured case rule (@api/sheetNames: sheetNamesEqual,
//          sheetNameKey, indexOfSheetName, findBySheetName), never by
//          JavaScript's toLowerCase / toUpperCase / toLocale*Case: full Unicode
//          lowercasing merges names Excel keeps apart (the Angstrom sign and
//          a-ring) and splits names Excel calls one (sigma and final sigma).
//          About twenty frontend lookups did exactly that until the
//          round-11 sheet-fold fix moved them all onto @api/sheetNames.
// CONTEXT: A lint rule cannot tell `sheetName.toLowerCase()` from a colour's
//          `hex.toLowerCase()` by type, so the shape is COUNTED instead, the
//          localeCensus way: every production line under src/ and extensions/
//          (tests, specs, .d.ts and comment-only lines skipped) that calls a
//          case-mapping method within three lines of the word "sheet". A file
//          holding more such lines than its entry below allows -- or any, with
//          no entry -- fails, naming the lines; a file holding FEWER fails too,
//          so the allowlist ratchets down and a freed slot cannot be taken by a
//          real sheet-name fold unnoticed. Every entry says why it is NOT a
//          sheet-name comparison.
//
//          THE OTHER HALF: an EXACT-match lookup (`sheets.find((s) => s.name
//          === x)`, `sheetNames.includes(x)`) disagrees with the engine just as
//          surely -- the script preview said `addSheet("SHEET1")` succeeds
//          beside `Sheet1` where the product refuses it. The second ratchet
//          below counts those two shapes, unless a fold helper follows within
//          three lines (the legitimate "exact spelling first, then by the
//          case rule" fallback). BLIND SPOT: it sees only those spellings --
//          a lookup through another variable name (`pages.find(p => p.name ===
//          x)`), a `Map` keyed by the raw name, or a `switch` on a name is not
//          counted; review those by hand.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const APP = path.resolve(__dirname, "../../..");

/** The counted shape: a case-mapping call within the window of the word "sheet". */
const CASE_MAP = /\.to(?:Locale)?(?:Lower|Upper)Case\(/;
const SHEET_WORD = /sheet/i;
const WINDOW_BEFORE = 3;
const WINDOW_AFTER = 1;

/** Files allowed to hold the shape, with how many lines and why each is not a
 *  sheet-name comparison. */
const ALLOWED: Record<string, { count: number; reason: string }> = {
  "src/api/scriptHost/scriptPreview/backend.ts": { count: 1, reason: "Find All over CELL text (caseSensitive option)" },
  "src/shell/FormulaBar/NameBox.address.ts": { count: 1, reason: "the A1 part of an address, after the sheet prefix is split off" },
  "src/shell/SheetTabs/SheetTabs.tsx": { count: 1, reason: "capitalises a role label for display" },
  "extensions/CanvasSheet/lib/canvasDelete.ts": { count: 1, reason: "builds a command id from a key combo" },
  "extensions/CanvasSheet/lib/objectNudge.ts": { count: 1, reason: "capitalises a direction label" },
  "extensions/Collaboration/components/VersionDiffView.tsx": { count: 1, reason: "lowercases a UI label in a sentence" },
  "extensions/CommandLine/cli/appWriters.ts": { count: 2, reason: "CLI option keywords (visibility, kind)" },
  "extensions/ControlsPane/lib/dropdownCellRangeSource.ts": {
    count: 2,
    reason: "a FLOATING RANGE name prefix (not a sheet name); the sheet branch uses findBySheetName",
  },
  "extensions/DefinedNames/lib/nameUtils.ts": { count: 1, reason: "column letters of an A1 reference" },
  "extensions/Hyperlinks/InsertHyperlinkDialog.tsx": { count: 1, reason: "the cell part of a hyperlink target" },
  "extensions/Table/lib/tableStyles.ts": { count: 2, reason: "colour hex strings" },
};

/** Files that are the rule itself or generated from it. */
const EXEMPT = new Set(["src/api/sheetNames.ts", "src/api/sheetNameCaseTable.generated.ts"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "__tests__") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

const rel = (full: string) => path.relative(APP, full).replace(/\\/g, "/");

const isComment = (t: string) => t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");

/** Every counted line in one source text (1-based line numbers). */
export function sheetFoldHits(source: string): Array<{ line: number; text: string }> {
  const lines = source.split(/\r?\n/);
  const hits: Array<{ line: number; text: string }> = [];
  lines.forEach((text, i) => {
    const t = text.trim();
    if (isComment(t) || !CASE_MAP.test(text)) return;
    const window = lines.slice(Math.max(0, i - WINDOW_BEFORE), i + 1 + WINDOW_AFTER).join("\n");
    if (SHEET_WORD.test(window)) hits.push({ line: i + 1, text: t.slice(0, 160) });
  });
  return hits;
}

describe("sheet-name fold census (ratchet)", () => {
  it("the counter sees the shapes it exists for, and not comments", () => {
    expect(sheetFoldHits("const s = sheets.find((s) => s.name.toLowerCase() === n.toLowerCase());")).toHaveLength(1);
    expect(sheetFoldHits("const wanted = sheetName.toLocaleLowerCase();")).toHaveLength(1);
    expect(sheetFoldHits("const sheet = list[0];\nconst k = x.name.toUpperCase();")).toHaveLength(1);
    expect(sheetFoldHits("// sheetName.toLowerCase() in a comment")).toHaveLength(0);
    expect(sheetFoldHits("const k = colour.toLowerCase();")).toHaveLength(0);
  });

  it("no production file compares sheet names by toLowerCase/toUpperCase beyond its allowlist", () => {
    const files = [...walk(path.join(APP, "src")), ...walk(path.join(APP, "extensions"))];
    const failures: string[] = [];
    const seen = new Set<string>();
    for (const full of files) {
      const file = rel(full);
      if (EXEMPT.has(file)) continue;
      const hits = sheetFoldHits(fs.readFileSync(full, "utf8"));
      if (hits.length === 0) continue;
      seen.add(file);
      const allowed = ALLOWED[file]?.count ?? 0;
      if (hits.length !== allowed) {
        failures.push(
          `${file}: ${hits.length} case-mapping line(s) near "sheet" (allowlisted ${allowed}). ` +
            (hits.length > allowed
              ? "Compare sheet names with @api/sheetNames (sheetNamesEqual / sheetNameKey / findBySheetName), " +
                "or add an entry WITH a reason if this is not a sheet name:\n"
              : "Ratchet the entry down:\n") +
            hits.map((h) => `    ${file}:${h.line}  ${h.text}`).join("\n"),
        );
      }
    }
    for (const file of Object.keys(ALLOWED)) {
      if (!seen.has(file)) failures.push(`${file}: allowlisted but holds no hit any more -- remove the entry`);
    }
    expect(failures, failures.join("\n\n")).toEqual([]);
  });
});

/** The exact-match shapes: `<...sheets>.find/findIndex/some/filter/every(s => s.name === ...)`
 *  and `<sheetNames>.includes/indexOf(...)`. */
const EXACT_LOOKUP = [
  /\bsheets?\w*\.(?:find|findIndex|some|filter|every)\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*\1\.name\s*===/i,
  /\bsheetNames\w*\.(?:includes|indexOf)\(/,
];
/** A fold helper within the window makes the exact match the first half of
 *  "exact spelling, then by the case rule" -- the broker's own resolver. */
const FOLD_HELPER = /\b(?:sheetNamesEqual|findBySheetName|indexOfSheetName|sheetNameKey)\b/;
const FALLBACK_WINDOW = 3;

/** Exact-match lookups that are deliberately exact, with why. */
const EXACT_ALLOWED: Record<string, { count: number; reason: string }> = {
  "src/api/scriptHost/host.ts": { count: 1, reason: "finds a copy by the name the backend just returned for it" },
  "src/api/sheetHistory.ts": { count: 1, reason: "the history records names read from the sheet list, never typed" },
  "extensions/Pivot/components/CreatePivotDialog.tsx": {
    count: 1,
    reason: "finds the sheet it just created; the duplicate check above uses sheetNamesEqual",
  },
};
/** In-app test suites look up the names they themselves just created; exact is
 *  the STRICTER assertion there. */
const EXACT_EXEMPT_PREFIX = "extensions/TestRunner/";

export function exactSheetLookupHits(source: string): Array<{ line: number; text: string }> {
  const lines = source.split(/\r?\n/);
  const hits: Array<{ line: number; text: string }> = [];
  lines.forEach((text, i) => {
    const t = text.trim();
    if (isComment(t) || !EXACT_LOOKUP.some((re) => re.test(text))) return;
    if (FOLD_HELPER.test(lines.slice(i, i + 1 + FALLBACK_WINDOW).join("\n"))) return;
    hits.push({ line: i + 1, text: t.slice(0, 160) });
  });
  return hits;
}

describe("exact-match sheet-name lookup census (ratchet)", () => {
  it("the counter sees an exact lookup, and lets an exact-then-fold fallback through", () => {
    expect(exactSheetLookupHits("if (state.sheetNames.includes(sheetName)) throw x;")).toHaveLength(1);
    expect(exactSheetLookupHits("const s = r.sheets.find((s) => s.name === wanted);")).toHaveLength(1);
    expect(exactSheetLookupHits("const i = sheets.findIndex(x => x.name === n);")).toHaveLength(1);
    expect(
      exactSheetLookupHits("const s = r.sheets.find((s) => s.name === n) ??\n  findBySheetName(r.sheets, n, (s) => s.name);"),
    ).toHaveLength(0);
    expect(exactSheetLookupHits("// sheets.find((s) => s.name === n)")).toHaveLength(0);
    expect(exactSheetLookupHits("const t = tables.find((t) => t.name === n);")).toHaveLength(0);
  });

  it("no production file looks a sheet up by an exact name beyond its allowlist", () => {
    const files = [...walk(path.join(APP, "src")), ...walk(path.join(APP, "extensions"))];
    const failures: string[] = [];
    const seen = new Set<string>();
    for (const full of files) {
      const file = rel(full);
      if (EXEMPT.has(file) || file.startsWith(EXACT_EXEMPT_PREFIX)) continue;
      const hits = exactSheetLookupHits(fs.readFileSync(full, "utf8"));
      if (hits.length === 0) continue;
      seen.add(file);
      const allowed = EXACT_ALLOWED[file]?.count ?? 0;
      if (hits.length !== allowed) {
        failures.push(
          `${file}: ${hits.length} exact sheet-name lookup(s) (allowlisted ${allowed}). ` +
            (hits.length > allowed
              ? "Look the name up with @api/sheetNames (indexOfSheetName / findBySheetName / sheetNamesEqual), " +
                "or fall back to one after the exact match, or add an entry WITH a reason:\n"
              : "Ratchet the entry down:\n") +
            hits.map((h) => `    ${file}:${h.line}  ${h.text}`).join("\n"),
        );
      }
    }
    for (const file of Object.keys(EXACT_ALLOWED)) {
      if (!seen.has(file)) failures.push(`${file}: allowlisted but holds no exact lookup any more -- remove the entry`);
    }
    expect(failures, failures.join("\n\n")).toEqual([]);
  });
});
