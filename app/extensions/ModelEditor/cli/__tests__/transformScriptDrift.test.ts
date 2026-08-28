// FILENAME: app/extensions/ModelEditor/cli/__tests__/transformScriptDrift.test.ts
// PURPOSE: Pin the ONE piece of the transform-step vocabulary that still lives
//          in TypeScript — the command line's completion/help word list — to
//          the engine's own published vocabulary, by reading the Rust source at
//          test time instead of re-typing it.
// CONTEXT: `transformSteps.ts` used to BUILD steps from a hand-written mirror
//          of the engine's serde, and that mirror was measurably wrong: one
//          rename per step, a homogeneous changeType only, `parts >= 2` where
//          the engine allows 1..=64, a required `groupby=` the engine does not
//          require, and no spelling for Decimal at all. The builder is gone.
//          What survives cannot construct anything — but a completion list that
//          offers an option the parser rejects, or omits one it accepts, is
//          still a lie to the user, so it is diffed here.
//
//          Same shape and same reason as `interpreterReachDrift.test.ts` and
//          the `include_str!` guard on `capabilityIds.ts`: derive, never
//          restate, and fix the direction of the diff. Rust states what parses;
//          TypeScript must match, never the reverse.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  TRANSFORM_STEP_OPTIONS,
  TRANSFORM_STEP_TYPES,
  renameStepOutput,
} from "../transformSteps";

const REPO = path.resolve(__dirname, "../../../../..");
const SCRIPT_DIR = path.join(REPO, "model-engine-lib/crates/engine-core/src/transform/script");
const VOCABULARY_RS = path.join(SCRIPT_DIR, "vocabulary.rs");
const STEP_RS = path.join(REPO, "model-engine-lib/crates/engine-core/src/transform/step.rs");
const PARTS_RS = path.join(REPO, "model-engine-lib/crates/engine-core/src/transform/parts.rs");

function readVocabulary(): string {
  expect(
    fs.existsSync(VOCABULARY_RS),
    `the engine's script vocabulary moved; this guard points at ${VOCABULARY_RS}`,
  ).toBe(true);
  return fs.readFileSync(VOCABULARY_RS, "utf8");
}

/** Every `tag: "..."` in the engine's STEPS table, in declaration order.
 *
 *  Whitespace-tolerant: rustfmt rewraps this table between one line per entry
 *  and one line per FIELD depending on its width, and a regex that assumed
 *  either would silently return nothing the next time the file was formatted.
 *  That is not hypothetical — it happened, and only the count assertion below
 *  turned it into a failure instead of a vacuous pass. */
function engineStepTags(source: string): string[] {
  const table = source.slice(source.indexOf("pub(crate) const STEPS:"));
  return [...table.matchAll(/StepVocabulary\s*\{\s*tag:\s*"([A-Za-z]+)"/g)].map((m) => m[1]);
}

/** Every canonical option key the engine's `opt!` table declares.
 *
 *  Whitespace-tolerant on purpose: a long `opt!(…)` is wrapped across lines by
 *  rustfmt, and a regex that only matched the one-line form would silently stop
 *  seeing those entries — which is exactly the vacuous-guard failure this file
 *  exists to prevent. The count assertion below is the backstop. */
function engineOptionKeys(source: string): Set<string> {
  return new Set(
    [...source.matchAll(/opt!\(\s*(?:optional\s+|repeatable\s+)*"([A-Za-z]+)"\s*->/g)].map(
      (m) => m[1],
    ),
  );
}

/** The placement option, declared once and never rendered. */
function enginePlacementOption(source: string): string {
  const match = /PLACEMENT_OPTION: &str = "([A-Za-z]+)"/.exec(source);
  expect(match, "the engine no longer declares PLACEMENT_OPTION").not.toBeNull();
  return match![1];
}

describe("transform script vocabulary — TypeScript must match the engine", () => {
  it("offers exactly the step tags the engine's catalog declares", () => {
    const tags = engineStepTags(readVocabulary());
    // Non-vacuity first: a regex that matched nothing would make this test
    // pass against an empty list.
    expect(tags.length).toBe(18);
    expect([...TRANSFORM_STEP_TYPES]).toEqual(tags);
  });

  it("declares exactly the option keys the engine accepts, plus the placement option", () => {
    const source = readVocabulary();
    const engine = engineOptionKeys(source);
    expect(engine.size).toBeGreaterThan(15);
    const placement = enginePlacementOption(source);
    engine.add(placement);

    const declared = new Set(TRANSFORM_STEP_OPTIONS.map((s) => s.key));
    const offeredButRefused = [...declared].filter((k) => !engine.has(k));
    expect(
      offeredButRefused,
      "completion offers these, but the engine's parser does not accept them",
    ).toEqual([]);
    const acceptedButHidden = [...engine].filter((k) => !declared.has(k));
    expect(
      acceptedButHidden,
      "the engine accepts these, but completion never offers them",
    ).toEqual([]);
  });

  it("every alias really is an alternative spelling, never a canonical key", () => {
    // An alias that duplicates a canonical key is dead weight; one that
    // matches nothing the engine accepts lets validation pass a key the
    // engine then refuses at run time.
    const canonical = new Set(TRANSFORM_STEP_OPTIONS.map((s) => s.key.toLowerCase()));
    for (const spec of TRANSFORM_STEP_OPTIONS) {
      for (const alias of spec.aliases ?? []) {
        expect(canonical.has(alias.toLowerCase()), `'${alias}' is already canonical`).toBe(false);
      }
    }
  });

  it("the two steps `transform … rename` reaches into still carry the field it writes", () => {
    // `renameStepOutput` is the last place outside the engine that reads a
    // step's fields. It touches two of seventeen tags; if either loses the
    // field it writes, this names it instead of the CLI writing a step the
    // backend silently drops.
    const step = fs.readFileSync(STEP_RS, "utf8");
    expect(step).toMatch(/AddColumn \{[\s\S]*?\n {8}name: String,/);
    expect(step).toMatch(/RenameColumns \{[\s\S]*?renames: Vec<ColumnRename>,/);
    const parts = fs.readFileSync(PARTS_RS, "utf8");
    expect(parts).toMatch(/pub struct ColumnRename[\s\S]*?pub to: String,/);

    // And it behaves: the rename lands on the field the engine reads.
    expect(
      renameStepOutput({ type: "addColumn", name: "old", expression: "1" }, "new", 1, 1),
    ).toEqual({ type: "addColumn", name: "new", expression: "1" });
    expect(
      renameStepOutput(
        { type: "renameColumns", renames: [{ from: "a", to: "b" }] },
        "c",
        1,
        1,
      ),
    ).toEqual({ type: "renameColumns", renames: [{ from: "a", to: "c" }] });
  });

  it("no TypeScript file builds a transform step from its own option table", () => {
    // The census that keeps the retirement retired. The builder, the prose
    // describer and the three value sub-parsers are gone; a new one would be a
    // second grammar for the same steps, which is the defect this replaced.
    const cliDir = path.join(__dirname, "..");
    const banned = [
      "buildTransformStep",
      "describeTransformStep",
      "normalizeStepType",
      "transformStepOptionKeys",
      "parseSortKey",
      "parseAggregate",
      "parseRowRange",
    ];
    const offenders: string[] = [];
    for (const file of fs.readdirSync(cliDir).filter((f) => f.endsWith(".ts"))) {
      const text = fs.readFileSync(path.join(cliDir, file), "utf8");
      for (const name of banned) {
        // `export function <name>` / `function <name>` — a definition, not a
        // mention in a comment explaining why it is gone.
        if (new RegExp(`function ${name}\\b`).test(text)) offenders.push(`${file}:${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
