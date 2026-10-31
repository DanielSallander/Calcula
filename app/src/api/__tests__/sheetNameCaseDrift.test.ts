//! FILENAME: app/src/api/__tests__/sheetNameCaseDrift.test.ts
// PURPOSE: The frontend sheet-name rule (@api/sheetNames) can never disagree
//          with Rust's (`identity::sheet_names_equal`, core/identity/src/
//          sheet_name_case.rs). This test READS THE RUST FILE AT TEST TIME
//          (the interpreterReachDrift precedent) and:
//            1. diffs its EXCEL_SHEET_NAME_CASE_TABLE row for row against the
//               generated TypeScript table, and
//            2. replays the Rust test's measured `same` / `different` pairs
//               (Excel's live answers) through sheetNamesEqual / sheetNameKey,
//          so a change to either side without the other fails here. The
//          direction is fixed Rust -> TypeScript: regenerate with
//          `node app/scripts/gen-sheet-name-case-table.mjs`.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { EXCEL_SHEET_NAME_CASE_TABLE } from "../sheetNameCaseTable.generated";
import {
  sheetNameKey,
  sheetNamesEqual,
  indexOfSheetName,
  findBySheetName,
  foldSheetNameCodePoint,
} from "../sheetNames";

const REPO = path.resolve(__dirname, "../../../..");
const RUST = path.join(REPO, "core/identity/src/sheet_name_case.rs");
const rustSrc = fs.readFileSync(RUST, "utf8");

/** Independent of the generator on purpose: a test that imported the
 *  generator's parser would agree with a generator bug. */
function rustTable(): Array<[number, number]> {
  const start = rustSrc.indexOf("pub static EXCEL_SHEET_NAME_CASE_TABLE");
  expect(start, "the Rust table moved or was renamed").toBeGreaterThan(0);
  const declared = /\[\(char, char\); (\d+)\]/.exec(rustSrc.slice(start));
  const body = rustSrc.slice(start, rustSrc.indexOf("];", start));
  const rows: Array<[number, number]> = [];
  const re = /\('\\u\{([0-9A-Fa-f]+)\}', '\\u\{([0-9A-Fa-f]+)\}'\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) rows.push([parseInt(m[1], 16), parseInt(m[2], 16)]);
  expect(declared && Number(declared[1]), "parsed row count vs the Rust array length").toBe(rows.length);
  return rows;
}

/** Decode a Rust string literal body that uses only `\u{..}` escapes. */
function decodeRust(lit: string): string {
  return lit.replace(/\\u\{([0-9A-Fa-f]+)\}/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)));
}

/** The Rust test's measured pairs, parsed out of `let <name>: [(&str, &str, &str); N] = [ ... ];`. */
function rustPairs(name: "same" | "different"): Array<[string, string, string]> {
  const decl = new RegExp(`let ${name}: \\[\\(&str, &str, &str\\); (\\d+)\\] = \\[`);
  const m = decl.exec(rustSrc);
  expect(m, `the Rust test's '${name}' array moved`).not.toBeNull();
  const from = m!.index + m![0].length;
  const body = rustSrc.slice(from, rustSrc.indexOf("];", from));
  const out: Array<[string, string, string]> = [];
  const re = /\("((?:[^"\\]|\\.)*)", "((?:[^"\\]|\\.)*)", "((?:[^"\\]|\\.)*)"\)/g;
  let p: RegExpExecArray | null;
  while ((p = re.exec(body)) !== null) out.push([decodeRust(p[1]), decodeRust(p[2]), p[3]]);
  expect(out.length, `'${name}' pairs parsed vs declared`).toBe(Number(m![1]));
  return out;
}

describe("@api/sheetNames is Rust's sheet-name rule (drift)", () => {
  it("the generated table equals the Rust table row for row", () => {
    const rust = rustTable();
    const ts = EXCEL_SHEET_NAME_CASE_TABLE.map(([a, b]) => [a, b]);
    expect(
      ts,
      "app/src/api/sheetNameCaseTable.generated.ts drifted from core/identity/src/sheet_name_case.rs -- " +
        "run `node app/scripts/gen-sheet-name-case-table.mjs`",
    ).toEqual(rust);
  });

  it("every measured pair Excel calls ONE name is one name here", () => {
    for (const [a, b, what] of rustPairs("same")) {
      expect(sheetNamesEqual(a, b), `${what}: Excel refuses ${a} beside ${b}`).toBe(true);
      expect(sheetNameKey(a), `${what}: keys differ`).toBe(sheetNameKey(b));
    }
  });

  it("every measured pair Excel keeps APART is two names here", () => {
    for (const [a, b, what] of rustPairs("different")) {
      expect(sheetNamesEqual(a, b), `${what}: Excel accepts ${a} beside ${b}`).toBe(false);
      expect(sheetNameKey(a), `${what}: keys collide`).not.toBe(sheetNameKey(b));
    }
  });

  // The two directions JavaScript's toLowerCase gets wrong, pinned explicitly so
  // the reason this module exists is readable without the Rust file.
  it("keeps apart a pair toLowerCase merges, and merges a pair toLowerCase splits", () => {
    // Angstrom sign U+212B lowercases to a-ring in JS; Excel accepts both [LIVE].
    expect("\u212B".toLowerCase()).toBe("\u00E5");
    expect(sheetNamesEqual("Q\u212B", "Q\u00E5")).toBe(false);
    // Final sigma and sigma stay two strings under JS lowercasing; Excel refuses
    // the pair [LIVE].
    expect("Q\u03C2".toLowerCase()).not.toBe("Q\u03C3".toLowerCase());
    expect(sheetNamesEqual("Q\u03C2", "Q\u03A3")).toBe(true);
    expect(sheetNamesEqual("Q\u03C2", "Q\u03C3")).toBe(true);
    // Sharp s: never expands (Excel accepts STRASSE beside Strasse-with-sharp-s).
    expect(sheetNamesEqual("Stra\u00DFe", "STRASSE")).toBe(false);
    expect(sheetNamesEqual("Stra\u00DFe", "STRA\u1E9EE")).toBe(true);
  });

  it("an ASCII key is the name uppercased, and lookups follow the rule", () => {
    expect(sheetNameKey("Sheet1")).toBe("SHEET1");
    expect(sheetNameKey("Q1-2026 data")).toBe("Q1-2026 DATA");
    expect(foldSheetNameCodePoint(0x7b)).toBe(0x7b);
    expect(indexOfSheetName(["Data", "\u00C4rende"], "\u00E4RENDE")).toBe(1);
    expect(indexOfSheetName(["Stra\u00DFe", "STRASSE"], "strasse")).toBe(1);
    expect(indexOfSheetName(["Stra\u00DFe", "STRASSE"], "STRA\u1E9EE")).toBe(0);
    expect(indexOfSheetName(["\u00E5"], "\u212B")).toBe(-1);
    expect(findBySheetName([{ name: "\u03A3" }], "\u03C2", (s) => s.name)).toEqual({ name: "\u03A3" });
  });
});
