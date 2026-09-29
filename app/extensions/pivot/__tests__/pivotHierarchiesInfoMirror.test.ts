//! FILENAME: app/extensions/Pivot/__tests__/pivotHierarchiesInfoMirror.test.ts
// PURPOSE: Wave E, Y4. `PivotHierarchiesInfo` (@api pivotTypes.ts) must MIRROR
//          the Rust struct `get_pivot_hierarchies` serializes
//          (app/src-tauri/src/pivot/types.rs): the TypeScript interface lacked
//          `slicerFilterFields` and `biModel`, so the Change Data Source dialog
//          could only read "is this a data-model pivot" through an `in` check
//          on a field the type said did not exist (Y5), and every other reader
//          of the answer was told it had no BI model to look at.
// CONTEXT: The Rust source is read at test time, in the direction Rust ->
//          TypeScript (the `pivotOverwriteDeadStepNaming` pattern): a field
//          added on either side alone fails here. `#[serde(rename_all =
//          "camelCase")]` spells the wire names; an `Option<..>` field is an
//          optional TypeScript member, every other field a required one.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const APP = path.resolve(__dirname, "../../..");
function read(rel: string): string {
  return fs.readFileSync(path.join(APP, rel), "utf8");
}

interface Member {
  name: string;
  optional: boolean;
}

function camel(snake: string): string {
  return snake.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** The fields of `pub struct <name> { ... }`, camelCased as serde spells them. */
function rustStructFields(source: string, name: string): Member[] {
  const start = source.indexOf(`pub struct ${name} {`);
  expect(start, `pub struct ${name} not found in pivot/types.rs`).toBeGreaterThan(-1);
  const body = source.slice(source.indexOf("{", start) + 1, source.indexOf("\n}", start));
  return body
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .map((line) => /^pub ([a-z0-9_]+):\s*(.+?),?$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ name: camel(m[1]), optional: m[2].startsWith("Option<") }));
}

/** The members of `export interface <name> { ... }`. Comments ignored. */
function tsInterfaceMembers(source: string, name: string): Member[] {
  const start = source.indexOf(`export interface ${name} {`);
  expect(start, `export interface ${name} not found in pivotTypes.ts`).toBeGreaterThan(-1);
  const body = source
    .slice(source.indexOf("{", start) + 1, source.indexOf("\n}", start))
    .replace(/\/\*[\s\S]*?\*\//g, "");
  return body
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .map((line) => /^([A-Za-z0-9_]+)(\?)?:/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ name: m[1], optional: m[2] === "?" }));
}

const byName = (a: Member, b: Member): number => a.name.localeCompare(b.name);

describe("PivotHierarchiesInfo mirrors pivot/types.rs (Y4)", () => {
  it("declares exactly the fields the backend serializes, optional where Rust is an Option", () => {
    const rust = rustStructFields(read("src-tauri/src/pivot/types.rs"), "PivotHierarchiesInfo");
    expect(rust.length, "fixture: parsed no Rust fields").toBeGreaterThan(0);
    const ts = tsInterfaceMembers(read("src/api/pivotTypes.ts"), "PivotHierarchiesInfo");
    expect([...ts].sort(byName), "PivotHierarchiesInfo drifted from the Rust struct").toEqual([...rust].sort(byName));
  });

  it("the Change Data Source dialog reads the typed BI answer, not an `in` probe", () => {
    const dialog = read("extensions/Pivot/components/ChangeDataSourceDialog.tsx");
    expect(dialog, "the dialog still probes for a field the type does not declare").not.toMatch(/['"]biModel['"]\s+in\b/);
    expect(dialog).toMatch(/\.biModel\b/);
  });
});
