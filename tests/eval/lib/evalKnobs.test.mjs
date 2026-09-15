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
import { readFileSync } from "node:fs";
import { join } from "node:path";

const EVAL = join(process.cwd(), "..", "tests", "eval");

/** A runner's source with `//` comments stripped, so prose cannot fabricate a flag. */
function codeOf(rel) {
  return readFileSync(join(EVAL, rel), "utf8")
    .split("\n")
    .map((l) => {
      const i = l.indexOf("//");
      return i >= 0 ? l.slice(0, i) : l;
    })
    .join("\n");
}

/**
 * Flags that select WHICH tasks run or HOW they run — the independent
 * variables. Deliberately excludes plumbing that cannot change an outcome.
 */
const NOT_A_KNOB = new Set([
  "json", // where the artifact goes
  "show-replies",
  "timeout-ms",
  "max-tokens",
  "help",
  "quiet",
  "concurrency",
  "gate-median-ms",
]);

/** `--foo` -> `foo`, as the runners spell them in `arg("foo", …)`. */
function flagsIn(src) {
  return [...new Set(Array.from(src.matchAll(/\barg\(\s*"([a-z0-9-]+)"/g), (m) => m[1]))].filter(
    (f) => !NOT_A_KNOB.has(f),
  );
}

/** The keys of the `knobs = { … }` object literal. */
function knobKeysIn(src) {
  const at = src.indexOf("const knobs = {");
  if (at < 0) return null;
  let depth = 0;
  let end = at;
  for (let i = src.indexOf("{", at); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  return Array.from(src.slice(at, end).matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*)\s*:/gm), (m) => m[1]);
}

/** `--clause-gate` is `clauseGate` in the block; compare shape-insensitively. */
const norm = (s) => s.replace(/-/g, "").toLowerCase();

const RUNNERS = ["run-design-query-eval.mjs", "run-formula-eval.mjs"];

describe("every eval knob reaches the artifact", () => {
  for (const rel of RUNNERS) {
    it(`${rel} records every flag it reads`, () => {
      const src = codeOf(rel);
      const keys = knobKeysIn(src);
      expect(keys, `${rel} has no \`const knobs = { … }\` block`).not.toBeNull();
      expect(keys.length).toBeGreaterThan(4);

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
