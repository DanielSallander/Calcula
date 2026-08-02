//! FILENAME: app/src/api/__tests__/packageInspectionMirror.test.ts
// PURPOSE: `PackageInspection` is the PRE-PULL REVIEW — everything a user is
//          shown about a .calp package before the commit point that mounts its
//          code. Rust decides what a package contains; TypeScript decides what
//          the user is told. A field Rust returns and TypeScript does not
//          declare is invisible to the review, and therefore arrives with no
//          disclosure at all.
// CONTEXT: That is exactly what happened to `moduleScripts` and `notebooks`.
//          calp_commands.rs has returned both since C8; this interface never
//          declared them, so SubscribeDialog rendered `inspection.scripts`
//          alone and a package's module scripts — including the reserved
//          `__calcula_custom_functions__` module, whose functions run whenever a
//          cell calls them — were never mentioned. A separate consent still
//          gated EXECUTION (require_distributed_module_consent), so this was a
//          disclosure gap rather than unconsented code; disclosure before a
//          commit point is what this type is FOR.
//
//          Derived from the Rust source at test time rather than restated, for
//          the same reason interpreterReachDrift.test.ts reads manifest.rs: a
//          mirror that is retyped by hand is a mirror that drifts in silence.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const REPO = path.resolve(__dirname, "../../../..");
const rustSrc = fs.readFileSync(
  path.join(REPO, "app/src-tauri/src/calp_commands.rs"),
  "utf8",
);
const tsSrc = fs.readFileSync(path.join(__dirname, "../distribution.ts"), "utf8");

/** Field names of a `pub struct NAME { ... }`, comments stripped. */
function rustStructFields(name: string): string[] {
  const at = rustSrc.indexOf(`pub struct ${name} {`);
  expect(at, `pub struct ${name} not found in calp_commands.rs`).toBeGreaterThan(-1);
  const body = rustSrc.slice(at, rustSrc.indexOf("\n}", at));
  return [...body.matchAll(/^\s*pub (\w+):/gm)].map((m) => m[1]);
}

/** Property names of an `export interface NAME { ... }`, comments stripped. */
function tsInterfaceFields(name: string): string[] {
  const at = tsSrc.indexOf(`export interface ${name} {`);
  expect(at, `export interface ${name} not found in distribution.ts`).toBeGreaterThan(-1);
  const body = tsSrc.slice(at, tsSrc.indexOf("\n}", at));
  return [...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]);
}

const snakeToCamel = (s: string): string => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

describe("PackageInspection mirrors the Rust struct the pre-pull review is built from", () => {
  it("declares EVERY field calp_commands.rs returns", () => {
    const rust = rustStructFields("PackageInspection").map(snakeToCamel).sort();
    const ts = new Set(tsInterfaceFields("PackageInspection"));
    const undisclosed = rust.filter((f) => !ts.has(f));
    expect(
      undisclosed,
      `these fields come back from inspect_package and the API type does not declare them, so ` +
        `nothing in the Subscribe review can render them. A package's contents that the user is ` +
        `not shown before subscribing arrive undisclosed. Add them to PackageInspection in ` +
        `app/src/api/distribution.ts (camelCase, mirroring the Rust field exactly).`,
    ).toEqual([]);
  });

  it("declares nothing Rust does not send (no phantom disclosure)", () => {
    const rust = new Set(rustStructFields("PackageInspection").map(snakeToCamel));
    const phantom = tsInterfaceFields("PackageInspection").filter((f) => !rust.has(f));
    expect(
      phantom,
      `declared in TypeScript but never sent by Rust — a review that renders these shows the ` +
        `user \`undefined\``,
    ).toEqual([]);
  });

  it("moduleScripts and notebooks specifically are declared (the found gap)", () => {
    const ts = tsInterfaceFields("PackageInspection");
    expect(ts).toContain("moduleScripts");
    expect(ts).toContain("notebooks");
  });

  it("the two nested row types mirror their Rust structs too", () => {
    for (const [rustName, tsName] of [
      ["InspectedModuleScript", "InspectedModuleScript"],
      ["InspectedNotebook", "InspectedNotebook"],
      ["InspectedScript", "InspectedScript"],
      ["InspectedDataSource", "InspectedDataSource"],
    ] as const) {
      expect(
        tsInterfaceFields(tsName).sort(),
        `${tsName} must mirror ${rustName} field-for-field`,
      ).toEqual(rustStructFields(rustName).map(snakeToCamel).sort());
    }
  });
});
