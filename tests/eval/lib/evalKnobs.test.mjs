//! FILENAME: tests/eval/lib/evalKnobs.test.mjs
// PURPOSE: Every CLI knob an eval runner accepts is written into the artifact
//          it produces.
// CONTEXT: A measurement whose conditions were not recorded cannot be compared
//          to anything later, and this programme decides everything by paired
//          comparison. The failure already happened twice:
//
//            - `--schema lean` recorded the same summary value as the default,
//              so two runs that really did differ were byte-identical in every
//              independent variable and a diff could not tell them apart.
//            - `--grammar` was recorded but the comparison tool's label did not
//              read it, so the two most important design-query arms printed the
//              same header.
//
//          And a third, worse: two latency figures for the same corpus sit in
//          `open-items.md` (1.0 s and ~4 s) and nobody can say which conditions
//          produced either, because the artifacts were written to a git-ignored
//          directory and are gone.
//
//          THIS TEST IS TEXTUAL AND THAT IS DELIBERATE. Running a runner needs a
//          model server; parsing its argument list does not. It reads which
//          `--flags` each runner consults and asserts each one appears in the
//          `knobs` block, so a knob added in a hurry fails the build rather than
//          silently producing artifacts that cannot be compared.

import { describe, it, expect } from "vitest";

import { SURFACES } from "../suite.mjs";
import { codeOf, flagsIn as allFlagsIn, knobKeysIn } from "./runnerFlags.mjs";

/**
 * Flags that select WHICH tasks run or HOW they run — the independent
 * variables. Deliberately excludes plumbing that cannot change an outcome.
 *
 * `max-tokens` is NOT here: it decides whether a reply is cut off, and a
 * cut-off reply is graded as wrong, so two runs that differ only in it can
 * differ in their score. It was excluded until 2026-09-17; the 2026-09-15
 * formula baseline carries nine truncated replies its knob block cannot
 * explain.
 */
const NOT_A_KNOB = new Set([
  "json", // where the artifact goes
  "show-replies",
  "show-misses",
  "timeout-ms",
  "help",
  "quiet",
  "concurrency",
  "gate-median-ms",
]);

/** `--foo` -> `foo`, as the runners spell them in `arg("foo", …)`, knobs only. */
function flagsIn(src) {
  return allFlagsIn(src).filter((f) => !NOT_A_KNOB.has(f));
}

/** `--clause-gate` is `clauseGate` in the block; compare shape-insensitively. */
const norm = (s) => s.replace(/-/g, "").toLowerCase();

// EVERY runner, from the suite's own list — a runner the suite runs and this
// guard does not cover would be an artifact `eval:all` produces that cannot
// be compared. Two runners were covered until 2026-09-17; seven are now.
const RUNNERS = SURFACES.map((s) => s.runner);

describe("every eval knob reaches the artifact", () => {
  for (const rel of RUNNERS) {
    it(`${rel} records every flag it reads`, () => {
      const src = codeOf(rel);
      const keys = knobKeysIn(src);
      expect(keys, `${rel} has no \`const knobs = { … }\` block`).not.toBeNull();
      expect(keys.length).toBeGreaterThan(0);

      const recorded = new Set(keys.map(norm));
      const missing = flagsIn(src).filter((f) => !recorded.has(norm(f)));
      expect(
        missing,
        `${rel} accepts these flags but does not record them, so a run using ` +
          `them produces an artifact that cannot be told apart from one that ` +
          `did not: ${missing.join(", ")}`,
      ).toEqual([]);
    });

    it(`${rel} puts the knob block into the summary`, () => {
      // Recording the block and not shipping it is the same failure one step
      // later, and it looks identical from the outside.
      expect(codeOf(rel)).toMatch(/summary\s*=\s*\{[\s\S]*?\bknobs\b/);
    });
  }

  it("compare-runs reads the knob block rather than hardcoded keys", () => {
    // The old label named four keys and `grammar` was not one of them.
    const src = codeOf("compare-runs.mjs");
    expect(src).toMatch(/summary\.knobs/);
    expect(
      /retrieval=\$\{run\.summary\.retrieval\}/.test(src),
      "compare-runs is labelling from hardcoded summary keys again",
    ).toBe(false);
  });
});

describe("a cut-off reply is recorded PER TASK, not only counted", () => {
  // A reply the runner's token limit cut short is graded as wrong. Every runner
  // counted those in its summary; only some named them, and the formula
  // baseline of 2026-09-15 carries nine it cannot point to. The per-task field
  // is what lets `compare-runs.mjs` set a truncated failure aside instead of
  // counting it as evidence about the model.
  const PER_TASK = {
    // runner: [the per-task field, the summary count]
    "run-formula-eval.mjs": [/results:\s*state\.map\([\s\S]*?\bfinishReason:\s*s\.finishReason/, /truncatedReplies:/],
    "run-eval.mjs": [/scores\.push\(\{[\s\S]*?finishReason:\s*lastFinishReason/, /truncatedReplies/],
    "run-design-query-eval.mjs": [/row\.finishReason\s*=/, /truncated:/],
    "run-next-edit-eval.mjs": [/row\.finishReason\s*=/, /truncated:/],
    "run-narration-eval.mjs": [/row\.finishReason\s*=/, /truncated:/],
    "run-macro-fim-eval.mjs": [/row\.truncated\s*=/, /truncated:/],
  };

  for (const [rel, [perTask, counted]] of Object.entries(PER_TASK)) {
    it(`${rel} names each truncated task in its artifact and counts them in its summary`, () => {
      const src = codeOf(rel);
      expect(src, `${rel}: no per-task truncation field`).toMatch(perTask);
      expect(src, `${rel}: no truncation count in the summary`).toMatch(counted);
    });
  }

  it("covers every runner that calls a model", () => {
    const modelRunners = SURFACES.filter((s) => s.needsModel).map((s) => s.runner);
    expect([...Object.keys(PER_TASK)].sort()).toEqual([...modelRunners].sort());
  });

  it("compare-runs sets a truncated failure aside instead of counting it", () => {
    const src = codeOf("compare-runs.mjs");
    expect(src).toMatch(/finishReason === "length"/);
    expect(src).toMatch(/flipsOnTruncation/);
  });
});
