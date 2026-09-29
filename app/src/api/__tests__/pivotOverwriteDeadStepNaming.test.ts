//! FILENAME: app/src/api/__tests__/pivotOverwriteDeadStepNaming.test.ts
// PURPOSE: X7 (wave D). Two leftovers of the undo-step shapes wave C retired:
//          (1) NAMING A SECOND STEP. A declined "overwrite existing data?" used
//              to take back one more step BY ITS HISTORY ID after the pivot
//              steps (`thenUndoSeq`), found by diffing the history ids around
//              the write (`runNamingItsUndoStep` / `undoStepPushedBetween`).
//              Its last user, the timeline selection, now JOINS its pivots'
//              step (W1), so nothing names a step any more -- and a helper
//              that can take back "the step on top" by id is exactly the tool
//              that takes back a stranger's step when the proof is wrong.
//          (2) THE "LEFT OPEN" GESTURE STEPS. `FilterGestureStep` still offered
//              "ownLeftOpen" / "joinOrLeftOpen" and `FilterGestureStepOutcome`
//              "leftOpen", which the Rust enums no longer have (W2): a caller
//              the types allowed to send one got a deserialize error, and a
//              `switch` over the outcome carried an arm that could never run.
//              The TypeScript unions must MIRROR pivot/types.rs.
// CONTEXT: The mirror is checked against the Rust source itself (read at test
//          time), in the direction Rust -> TypeScript, so a variant added on
//          either side alone fails here.

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

const invoke = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => ({
  stepsUndone: 1,
  complete: true,
  refreshDomains: [],
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invoke(cmd, args),
}));

import { undoPivotOverwrite } from "../backend";

const APP = path.resolve(__dirname, "../../..");
function read(rel: string): string {
  return fs.readFileSync(path.join(APP, rel), "utf8");
}

/** The variants of `pub enum <name> { ... }` in a Rust file, camelCased the
 *  way `#[serde(rename_all = "camelCase")]` spells them. Comments ignored. */
function rustEnumVariants(source: string, name: string): string[] {
  const start = source.indexOf(`pub enum ${name} {`);
  expect(start, `pub enum ${name} not found in pivot/types.rs`).toBeGreaterThan(-1);
  const body = source.slice(source.indexOf("{", start) + 1, source.indexOf("\n}", start));
  return body
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .filter((line) => /^[A-Z][A-Za-z0-9]*,?$/.test(line))
    .map((line) => line.replace(/,$/, ""))
    .map((v) => v[0].toLowerCase() + v.slice(1));
}

/** The string members of `export type <name> = "a" | "b" ...;` in a TS file. */
function tsUnionMembers(source: string, name: string): string[] {
  const m = new RegExp(`export type ${name} =([^;]*);`).exec(source);
  expect(m, `export type ${name} not found in pivotTypes.ts`).not.toBeNull();
  return Array.from(m![1].matchAll(/"([^"]+)"/g), (x) => x[1]);
}

beforeEach(() => {
  invoke.mockClear();
});

describe("the gesture step unions mirror pivot/types.rs (X7)", () => {
  const rust = read("src-tauri/src/pivot/types.rs");
  const ts = read("src/api/pivotTypes.ts");

  it("FilterGestureStep has exactly the Rust variants", () => {
    const rustVariants = rustEnumVariants(rust, "FilterGestureStep");
    expect(rustVariants.length, "fixture: parsed no Rust variants").toBeGreaterThan(0);
    expect(
      tsUnionMembers(ts, "FilterGestureStep").sort(),
      "FilterGestureStep offers a step the backend refuses to deserialize",
    ).toEqual(rustVariants.sort());
  });

  it("FilterGestureStepOutcome has exactly the Rust variants", () => {
    const rustVariants = rustEnumVariants(rust, "FilterGestureStepOutcome");
    expect(rustVariants.length, "fixture: parsed no Rust variants").toBeGreaterThan(0);
    expect(
      tsUnionMembers(ts, "FilterGestureStepOutcome").sort(),
      "FilterGestureStepOutcome names an outcome the backend never returns",
    ).toEqual(rustVariants.sort());
  });
});

describe("a declined overwrite names no second step (X7)", () => {
  it("undoPivotOverwrite sends the gesture's tokens and nothing else", async () => {
    await undoPivotOverwrite("pivot-1", [7, 8]);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0][0]).toBe("undo_pivot_overwrite");
    expect(invoke.mock.calls[0][1], "the take-back still names a step by its history id (thenUndoSeq)").toEqual({
      pivotId: "pivot-1",
      overwriteTokens: [7, 8],
    });
  });

  it("the step-naming helpers are gone from @api", () => {
    const pivotOverwrite = read("src/api/pivotOverwrite.ts");
    const index = read("src/api/index.ts");
    for (const dead of ["runNamingItsUndoStep", "undoStepPushedBetween", "thenUndoSeq", "ConfirmPivotOverwriteOptions"]) {
      expect(pivotOverwrite, `pivotOverwrite.ts still carries ${dead}`).not.toContain(dead);
      expect(index, `@api still exports ${dead}`).not.toContain(dead);
    }
  });
});
