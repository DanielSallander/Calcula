// PURPOSE: Guard that the shared QuickJS type surface (calcula.d.ts, fed to every
//          Monaco editor) documents every op the script engine actually exposes.
// CONTEXT: C3 increment. Before this, the extended.rs (29) and worksheet_props.rs
//          (6) ops were registered on the `Calcula` global but missing from
//          IntelliSense. This test extracts op names from the Rust source and
//          asserts each is documented, so a future op can't be added without its
//          type — closing the drift that left ~half the API undocumented.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const OPS_DIR = path.resolve(__dirname, "../../../../core/script-engine/src/ops");
const DTS_PATH = path.resolve(__dirname, "../calcula.d.ts");

/** Extract op names from `calcula.set("opName", ...)` registrations. */
function rustOpNames(file: string): string[] {
  const src = fs.readFileSync(path.join(OPS_DIR, file), "utf8");
  const re = /\.set\(\s*"([a-zA-Z][a-zA-Z0-9]*)"/g;
  const names: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) names.push(m[1]);
  return names;
}

/** Every `function name(` declared anywhere in the d.ts (any namespace depth). */
function documentedFunctions(): Set<string> {
  const src = fs.readFileSync(DTS_PATH, "utf8");
  const re = /function\s+([a-zA-Z][a-zA-Z0-9]*)\s*\(/g;
  const names = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) names.add(m[1]);
  return names;
}

describe("calcula.d.ts op coverage (C3)", () => {
  const documented = documentedFunctions();

  it("documents every extended.rs op (the 29 that were missing)", () => {
    const ops = rustOpNames("extended.rs");
    expect(ops.length).toBe(29); // pin the count so new ops force a d.ts update
    const missing = ops.filter((op) => !documented.has(op));
    expect(missing, `extended.rs ops missing from calcula.d.ts: ${missing.join(", ")}`).toEqual([]);
  });

  it("documents every worksheet_props.rs op", () => {
    const ops = rustOpNames("worksheet_props.rs");
    expect(ops.length).toBe(6);
    const missing = ops.filter((op) => !documented.has(op));
    expect(missing, `worksheet_props.rs ops missing from calcula.d.ts: ${missing.join(", ")}`).toEqual([]);
  });

  it("documents the function-style cells/sheets/utility ops too", () => {
    // These are plain top-level functions (not Application/bookmark props), so a
    // pure function-name check is exact for them.
    const ops = [...rustOpNames("cells.rs"), ...rustOpNames("sheets.rs"), ...rustOpNames("utility.rs")];
    const missing = ops.filter((op) => !documented.has(op));
    expect(missing, `core ops missing from calcula.d.ts: ${missing.join(", ")}`).toEqual([]);
  });
});
