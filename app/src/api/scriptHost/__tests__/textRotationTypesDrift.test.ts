//! FILENAME: app/src/api/scriptHost/__tests__/textRotationTypesDrift.test.ts
// PURPOSE: The script-facing ScriptFormat types name EVERY text rotation the
//          script gate accepts -- "vertical" (stacked text) and `custom:N`
//          included -- and nothing the gate refuses.
// CONTEXT: Home tab 2026-10-04 (rust-format "not fixed" 2). The backend and
//          the script validator learned "vertical" and `custom:N` (Excel's
//          Vertical Text and Angle Counterclockwise / Clockwise), but the two
//          ScriptFormat declarations a script is typed against still said
//          `"none" | "rotate90" | "rotate270"`: a script that set the
//          Orientation menu's own values was a TYPE error in an editor that
//          type-checks, for values the broker would then have accepted. Types
//          are erased, so this reads the declarations from source and checks
//          them against the gate's real answers (checkFormatObject), not
//          against a third hand-written list.
//
//          The vocabulary is probed, not listed: every candidate the gate
//          accepts must be in each union, and every literal in each union must
//          be accepted. A rotation added to the gate later fails here until the
//          types learn it.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { checkFormatObject } from "../validators";

const APP = path.resolve(__dirname, "../../../..");
const read = (rel: string): string => fs.readFileSync(path.join(APP, rel), "utf8").replace(/\r\n/g, "\n");

/**
 * Every declaration a script's format call is typed against: the two TS
 * interfaces the host and the worker realm compile against, AND the typings a
 * script AUTHOR actually sees -- the prose template and the objectContexts.d.ts
 * generated from it (Monaco's only extraLib for object scripts). The first
 * repair widened only the two TS unions; the editor still underlined
 * `textRotation: "vertical"` as an error, because the .d.ts is written from the
 * template, not from scriptableObjects.ts.
 */
const DECLARATIONS = [
  "src/api/scriptableObjects.ts",
  "src/api/scriptHost/worker/canonicalModel.ts",
  "scripts/scriptTypings/objectContexts.template.d.ts",
  "extensions/ScriptableObjects/objectContexts.d.ts",
] as const;

/** The type text of `textRotation?:` inside `interface ScriptFormat {` of `file`. */
function textRotationType(file: string): string {
  const src = read(file);
  const at = src.search(/interface ScriptFormat \{/);
  expect(at, `${file} declares no ScriptFormat`).toBeGreaterThan(-1);
  const body = src.slice(at, src.indexOf("\n}", at));
  const match = /\n\s*textRotation\?:\s*([^;]+);/.exec(body);
  expect(match, `${file}'s ScriptFormat has no textRotation`).not.toBeNull();
  return match![1].trim();
}

/** The members of a union written in source: a named alias resolves to core's TextRotation. */
function unionMembers(typeText: string): { literals: string[]; customTemplate: boolean } {
  let text = typeText;
  if (text === "TextRotation") {
    const core = read("src/core/types/types.ts");
    const at = core.indexOf("export type TextRotation =");
    expect(at, "core types.ts no longer declares TextRotation").toBeGreaterThan(-1);
    text = core.slice(at + "export type TextRotation =".length, core.indexOf(";", at));
  }
  const literals = [...text.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  const customTemplate = /`custom:\$\{number\}`/.test(text);
  return { literals, customTemplate };
}

/** Candidates for the gate's NAMED rotations (every spelling the backend parser
 *  or Excel's UI might suggest), probed so the test does not keep its own list. */
const NAMED_CANDIDATES = [
  "none", "rotate90", "rotate270", "vertical", "stacked", "rotate180", "up", "down",
  "0", "90", "-90", "270", "horizontal", "angleCounterclockwise", "angleClockwise",
];
const accepted = (value: string): boolean => checkFormatObject({ textRotation: value }) === true;

describe("ScriptFormat.textRotation names the gate's whole vocabulary", () => {
  const gateNamed = NAMED_CANDIDATES.filter(accepted);

  it("the probe finds the gate's named rotations (positive control for the probe itself)", () => {
    expect(gateNamed.sort()).toEqual(["none", "rotate270", "rotate90", "vertical"]);
    expect(accepted("custom:45")).toBe(true);
    expect(accepted("custom:-45")).toBe(true);
  });

  for (const file of DECLARATIONS) {
    describe(file, () => {
      const members = unionMembers(textRotationType(file));

      it("names every rotation the gate accepts", () => {
        expect([...members.literals].sort()).toEqual(expect.arrayContaining(gateNamed));
        expect(members.customTemplate, `${file}: no \`custom:\${number}\` member (Angle Counterclockwise is "custom:45")`).toBe(true);
      });

      it("names nothing the gate refuses", () => {
        for (const literal of members.literals) {
          expect(accepted(literal), `${file} names "${literal}", which the gate refuses`).toBe(true);
        }
      });
    });
  }
});
