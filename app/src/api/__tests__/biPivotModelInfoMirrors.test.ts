//! FILENAME: app/src/api/__tests__/biPivotModelInfoMirrors.test.ts
// PURPOSE: The two TypeScript mirrors of the Rust `BiPivotModelInfo` carry the
//          same fields, so a field added to one cannot go missing from the other.
// CONTEXT: `app/src/api/pivotTypes.ts` and
//          `app/extensions/_shared/components/types.ts` both declare an
//          interface of that name, and both claim to mirror the same Rust
//          struct (`app/src-tauri/src/pivot/types.rs`). They are separate
//          because the facade may not import an extension and the extension
//          side needs its own local shape — but "separate" became "drifted" on
//          2026-09-10: Step 2 of the AI programme put `strategy` on the
//          `_shared` copy only, and for a day the facade's own type could not
//          see a field the wire was already sending. Nothing failed, because
//          nothing compared them; the drift surfaced only when a NEW consumer
//          read `strategy` off the facade's type and the type checker refused.
//
//          This test reads both files as TEXT and diffs the field names. Text,
//          not types, for the same reason `interpreterReachDrift.test.ts` reads
//          Rust as text: a structural type comparison would need the two to be
//          assignable, and they deliberately are not (one types `measures` as
//          `MeasureField[]`, the other as `BiMeasureFieldInfo[]`, and
//          `connectionId` is required on one side and optional on the other).
//          Field NAMES are the contract with the wire; their spellings are not.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const APP = path.resolve(__dirname, "../../..");

const MIRRORS = [
  { label: "@api/pivotTypes", file: "src/api/pivotTypes.ts" },
  { label: "_shared/components/types", file: "extensions/_shared/components/types.ts" },
] as const;

/**
 * The field names of one `export interface BiPivotModelInfo { … }` block.
 *
 * Deliberately a small hand parser rather than a regex over the whole file: the
 * body carries doc comments with braces and colons in them, so the scan tracks
 * brace depth and only takes `name?:` / `name:` at depth 1, with comments
 * stripped first.
 */
export function mirrorFields(source: string): string[] {
  const start = source.indexOf("export interface BiPivotModelInfo");
  if (start < 0) throw new Error("no `export interface BiPivotModelInfo` in this file");
  const open = source.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) throw new Error("unterminated BiPivotModelInfo body");
  const body = source
    .slice(open + 1, end)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

  const fields: string[] = [];
  let level = 0;
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (level === 0) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\??\s*:/.exec(line);
      if (m) fields.push(m[1]);
    }
    for (const ch of line) {
      if (ch === "{" || ch === "(" || ch === "[") level++;
      else if (ch === "}" || ch === ")" || ch === "]") level = Math.max(0, level - 1);
    }
  }
  return fields;
}

describe("the two TypeScript mirrors of BiPivotModelInfo", () => {
  const read = (rel: string) => fs.readFileSync(path.join(APP, rel), "utf8");

  it("the field scan finds a real, non-trivial list in both", () => {
    for (const m of MIRRORS) {
      const fields = mirrorFields(read(m.file));
      expect(fields.length, `${m.label} parsed as ${fields.length} fields — the scan is broken, not the file`).toBeGreaterThan(8);
      expect(fields, m.label).toContain("tables");
      expect(fields, m.label).toContain("measures");
      // Non-vacuity: the scan must not be swallowing doc comments as fields.
      expect(fields.every((f) => /^[a-z][A-Za-z0-9]*$/.test(f)), `${m.label}: ${fields.join(", ")}`).toBe(true);
    }
  });

  it("carry exactly the same field names", () => {
    const [a, b] = MIRRORS.map((m) => ({ label: m.label, fields: new Set(mirrorFields(read(m.file))) }));
    const onlyA = [...a.fields].filter((f) => !b.fields.has(f)).sort();
    const onlyB = [...b.fields].filter((f) => !a.fields.has(f)).sort();
    expect(
      { [`only in ${a.label}`]: onlyA, [`only in ${b.label}`]: onlyB },
      "These two interfaces mirror ONE Rust struct. A field on one and not the other means a consumer " +
        "typed through that side cannot see something the wire is sending — which is exactly how " +
        "`strategy` went missing from the facade for a day. Add it to both, or explain in both.",
    ).toEqual({ [`only in ${a.label}`]: [], [`only in ${b.label}`]: [] });
  });

  it("both carry `strategy`, the field whose absence this test was written for", () => {
    for (const m of MIRRORS) {
      expect(mirrorFields(read(m.file)), m.label).toContain("strategy");
    }
  });
});
