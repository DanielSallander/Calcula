//! FILENAME: app/src/api/sheetNames.ts
// PURPOSE: The ONE frontend rule for when two sheet names are the same name --
//          Excel's case rule, measured live -- and the lookup key every
//          frontend sheet-name comparison is built from. The TypeScript twin of
//          `identity::sheet_names_equal` / `identity::sheet_name_key`
//          (core/identity/src/sheet_name_case.rs).
// CONTEXT: Before this module about twenty frontend lookups compared sheet names
//          with JavaScript's `toLowerCase()` (or `toLocaleLowerCase()`), which is
//          Unicode FULL lowercasing. That merges names Excel keeps apart [LIVE]
//          -- the Angstrom sign and `å`, `ϴ` and `θ`, Cherokee, Georgian
//          Mtavruli, Deseret -- and splits names Excel calls one: final `ς`
//          against `σ`/`Σ`. Rust had already moved to Excel's measured rule, so
//          the Name Box, the formula-reference colouring, chart and validation
//          sources, scripts and the CLI could pick a different sheet than the
//          engine for the same text.
//
//          THE TABLE IS RUST'S. `sheetNameCaseTable.generated.ts` is generated
//          from the Rust table by app/scripts/gen-sheet-name-case-table.mjs, and
//          app/src/api/__tests__/sheetNameCaseDrift.test.ts reads the Rust file
//          at test time and fails on any difference, so the two can never
//          disagree. The direction is fixed Rust -> TypeScript.
//
//          PURE AND DEPENDENCY-FREE apart from the generated data table, so the
//          hardened script Worker realm (scriptHost/worker/canonicalModel.ts)
//          can use it too.
//
//          Never compare sheet names with toLowerCase/toUpperCase; the census
//          app/src/api/__tests__/sheetNameFoldCensus.test.ts counts such folds.

import { EXCEL_SHEET_NAME_CASE_TABLE } from "./sheetNameCaseTable.generated";

let foldMap: Map<number, number> | null = null;

function table(): Map<number, number> {
  if (foldMap === null) {
    foldMap = new Map<number, number>();
    for (const [from, rep] of EXCEL_SHEET_NAME_CASE_TABLE) foldMap.set(from, rep);
  }
  return foldMap;
}

/** The class representative of one code point under Excel's sheet-name case
 *  rule (ASCII letters uppercase; anything not in the measured table is its own
 *  class). Mirrors `fold_sheet_name_char`. */
export function foldSheetNameCodePoint(cp: number): number {
  if (cp < 0x80) {
    return cp >= 0x61 && cp <= 0x7a ? cp - 0x20 : cp;
  }
  return table().get(cp) ?? cp;
}

/** The lookup key of a sheet name: two names have the same key exactly when
 *  Excel treats them as the same sheet name. Use it for EVERY map keyed by a
 *  sheet name. Length-preserving; an ASCII name's key is that name uppercased. */
export function sheetNameKey(name: string): string {
  let out = "";
  for (const ch of name) {
    const cp = ch.codePointAt(0)!;
    const folded = foldSheetNameCodePoint(cp);
    out += folded === cp ? ch : String.fromCodePoint(folded);
  }
  return out;
}

/** Whether two sheet names are the same name, by Excel's rule. */
export function sheetNamesEqual(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return sheetNameKey(a) === sheetNameKey(b);
}

/** The position of the sheet called `name` in `names`, by Excel's rule, or -1. */
export function indexOfSheetName(names: readonly string[], name: string): number {
  const key = sheetNameKey(name);
  for (let i = 0; i < names.length; i++) {
    if (names[i] === name || sheetNameKey(names[i]) === key) return i;
  }
  return -1;
}

/** The first item whose sheet name (read by `nameOf`) is `name` by Excel's
 *  rule, or undefined -- the `sheets.find(s => s.name ...)` shape. */
export function findBySheetName<T>(
  items: readonly T[],
  name: string,
  nameOf: (item: T) => string,
): T | undefined {
  const key = sheetNameKey(name);
  return items.find((item) => {
    const n = nameOf(item);
    return n === name || sheetNameKey(n) === key;
  });
}
