//! FILENAME: app/extensions/FormulaAssist/__tests__/insertIsTheOnlyWriter.test.ts
// PURPOSE: Fail the build the moment a second file in this extension writes a
//          cell.
// CONTEXT: A source scan rather than a behavioural test, because the property
//          being protected is architectural: "the write happens in exactly one
//          reviewed place". No runtime assertion can see a NEW call site that
//          nobody thought to test, and a call site nobody thought to test is
//          precisely how the write path stops being reviewed.
//
//          The scan reads the folder off disk, so it also covers files that do
//          not exist yet. It ignores comments and the tests themselves — a
//          paragraph explaining the rule must not break the rule — and it is
//          verified by its own final case, which proves the matcher can still
//          see a write when one is planted in the text.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

// `__dirname`, the way every other source-scan test in this repo locates its
// input (see api/__tests__/backendCommandDrift.test.ts). `import.meta.url` is
// not a file: URL under this vitest environment.
const EXTENSION_ROOT = resolve(__dirname, "..");

/** The one file allowed to write. */
const WRITER = join("lib", "insert.ts");

/** Every cell-writing door in the facade. `insert.ts` may use the first two. */
const WRITE_CALLS = [
  /\bupdateCell\s*\(/,
  /\bupdateCellsBatch\s*\(/,
  /\bupdateCellOnSheets\s*\(/,
  /\bclearRange\s*\(/,
  /\bsetCellValue\s*\(/,
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      out.push(...sourceFiles(full));
      continue;
    }
    if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * The file with comments and string literals removed.
 *
 * Comments are stripped so the long explanations in `insert.ts` and this file's
 * siblings — which necessarily name `updateCell` — cannot register as calls.
 * Stripping LINE-WISE, the way the repo's own command census learned to: a
 * chunk-wise strip swallows whatever follows a comma inside a doc comment.
 */
function code(text: string): string {
  const withoutBlocks = text.replace(/\/\*[\s\S]*?\*\//g, "");
  return withoutBlocks
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

describe("insert.ts is the only file in FormulaAssist that writes a cell", () => {
  const files = sourceFiles(EXTENSION_ROOT);

  it("finds the extension's sources at all (the scan is not vacuous)", () => {
    expect(files.length).toBeGreaterThan(5);
    expect(files.some((f) => f.endsWith(WRITER))).toBe(true);
  });

  it("finds no cell write outside lib/insert.ts", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(EXTENSION_ROOT, file);
      if (rel === WRITER || rel === WRITER.split(sep).join("/")) continue;
      const body = code(readFileSync(file, "utf8"));
      for (const pattern of WRITE_CALLS) {
        if (pattern.test(body)) offenders.push(`${rel} calls ${pattern.source}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("does write the cell in lib/insert.ts, so the scan is looking for the right thing", () => {
    const body = code(readFileSync(join(EXTENSION_ROOT, WRITER), "utf8"));
    expect(/\bupdateCell\s*\(/.test(body)).toBe(true);
    expect(/\bupdateCellsBatch\s*\(/.test(body)).toBe(true);
  });

  it("would catch a write planted in another file", () => {
    // The teeth check. A sabotage that changes nothing proves nothing, so the
    // matcher is run against text that DOES contain a write.
    const planted = code('import { updateCell } from "@api";\nawait updateCell(0, 0, "=1");\n');
    expect(WRITE_CALLS.some((p) => p.test(planted))).toBe(true);
  });
});
