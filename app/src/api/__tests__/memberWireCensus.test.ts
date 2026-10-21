//! FILENAME: app/src/api/__tests__/memberWireCensus.test.ts
// PURPOSE: The member wire (P2 S7) has no UNTYPED readers left. Every pivot
//          item, BI column value and slicer item crosses the backend boundary
//          as `MemberRef { key, label }`; a typed consumer of the old shape
//          fails to COMPILE (the fields were renamed), but an untyped one --
//          `invoke<string[]>("bi_get_column_values", ...)`, a
//          `data.uniqueValues as string[]` cast -- compiles and then reads
//          `[object Object]` or `undefined` at run time. This census is the
//          guard for exactly those.
// CONTEXT: Production files only (tests double the old shapes on purpose).
//          Read as TEXT. A hit names its file and line. The patterns:
//            - an `invoke<string[]>` (any invoker) of bi_get_column_values;
//            - a `.uniqueValues` property read in the Pivot extension or the
//              shared pivot-layout DSL (the pivot filter lists now carry
//              `members`; the DSL's own `filterUniqueValues` map is keys and
//              is not a property read of the wire);
//            - the deleted `pivotCellLabel` (identity from the KEY via
//              `pivotCellItemKey`, display from the LABEL via
//              `pivotCellDisplayText`; it is not aliased).

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const APP = path.resolve(__dirname, "../../..");

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

interface Rule {
  name: string;
  pattern: RegExp;
  /** Which production files the rule scans (app-relative, "/" separated). */
  scope: (file: string) => boolean;
}

/** An untyped invoke of the member list command: `invoke<string[]>(`, any invoker, any whitespace. */
const UNTYPED_COLUMN_VALUES = /invoke\s*<\s*string\s*\[\s*\]\s*>\s*\(\s*["']bi_get_column_values["']/;
const UNIQUE_VALUES_READ = /\.uniqueValues\b/;
const PIVOT_CELL_LABEL = /\bpivotCellLabel\b/;

const RULES: Rule[] = [
  {
    name: 'invoke<string[]>("bi_get_column_values") -- the command answers MemberRef[]',
    pattern: UNTYPED_COLUMN_VALUES,
    scope: (f) => f.startsWith("src/") || f.startsWith("extensions/"),
  },
  {
    name: "a `.uniqueValues` read -- the pivot filter lists carry `members` (MemberRef[])",
    pattern: UNIQUE_VALUES_READ,
    scope: (f) => f.startsWith("extensions/Pivot/") || f.startsWith("extensions/_shared/dsl/"),
  },
  {
    name: "pivotCellLabel -- deleted: pivotCellItemKey for identity, pivotCellDisplayText for display",
    pattern: PIVOT_CELL_LABEL,
    scope: (f) => f.startsWith("src/") || f.startsWith("extensions/"),
  },
];

/** Every `file:line` of `source` (named `file`) a rule hits, comments stripped line-wise. */
export function censusHits(file: string, source: string): string[] {
  const hits: string[] = [];
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  for (const rule of RULES) {
    if (!rule.scope(file)) continue;
    lines.forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, "");
      if (rule.pattern.test(code)) hits.push(`${file}:${i + 1}  ${rule.name}`);
    });
  }
  return hits;
}

describe("the member wire has no untyped readers (P2 S7 census)", () => {
  const files = [...walk(path.join(APP, "src")), ...walk(path.join(APP, "extensions"))];

  it("the walk sees the real tree (the scan is not the thing passing)", () => {
    const names = files.map(rel);
    expect(names).toContain("extensions/Slicer/lib/slicerFilterBridge.ts");
    expect(names).toContain("extensions/ControlsPane/lib/filterPaneApi.ts");
    expect(names).toContain("extensions/Pivot/lib/pivot-api.ts");
    expect(names).toContain("src/api/backend.ts");
    expect(names.some((n) => n.includes("__tests__") || /\.test\.tsx?$/.test(n))).toBe(false);
    // The typed reads the census protects are really there.
    const bridge = fs.readFileSync(path.join(APP, "extensions/Slicer/lib/slicerFilterBridge.ts"), "utf8");
    expect(bridge).toMatch(/invoke<MemberRef\[\]>\("bi_get_column_values"/);
  });

  it("no production file reads the old member wire", () => {
    const hits = files.flatMap((f) => censusHits(rel(f), fs.readFileSync(f, "utf8")));
    expect(hits, `untyped readers of the member wire:\n${hits.join("\n")}`).toEqual([]);
  });

  it("non-vacuity: each planted shape is named with its file and line", () => {
    expect(
      censusHits(
        "extensions/Slicer/lib/x.ts",
        'const a = 1;\nconst v = await slicerBackend.invoke<string[]>("bi_get_column_values", { table });\n',
      ),
    ).toEqual([expect.stringMatching(/^extensions\/Slicer\/lib\/x\.ts:2 .*bi_get_column_values/)]);
    expect(censusHits("extensions/Pivot/manifest.ts", "uniqueValues: (data.uniqueValues as string[]) ?? [],")).toHaveLength(1);
    expect(censusHits("extensions/Pivot/a.ts", "return pivotCellLabel(cell);")).toHaveLength(1);
    // Scope and comments: AutoFilter's own uniqueValues and a comment are not hits.
    expect(censusHits("extensions/AutoFilter/a.ts", "x.uniqueValues")).toEqual([]);
    expect(censusHits("extensions/Pivot/a.ts", "// was resp.uniqueValues")).toEqual([]);
    expect(censusHits("extensions/Pivot/a.ts", 'invoke<MemberRef[]>("bi_get_column_values")')).toEqual([]);
  });
});
