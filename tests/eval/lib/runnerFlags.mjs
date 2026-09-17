//! FILENAME: tests/eval/lib/runnerFlags.mjs
// PURPOSE: Read which `--flags` an eval runner consults, TEXTUALLY, so the two
//          guards that depend on the answer (`evalKnobs.test.mjs`: every knob
//          reaches the artifact; `evalSuite.test.mjs`: every knob is pinned by
//          the suite) read the same list and cannot disagree about it.
// CONTEXT: Running a runner needs a model server; parsing its argument list
//          does not. The runners all spell a flag the same way — `arg("name",
//          default)` — which is what makes a textual read reliable, and the
//          `//` comments are stripped first so prose cannot fabricate a flag.

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** `tests/eval/`, from the app directory vitest runs in. */
export const EVAL_DIR = join(process.cwd(), "..", "tests", "eval");

/** A runner's source with `//` comments stripped. */
export function codeOf(rel) {
  return readFileSync(join(EVAL_DIR, rel), "utf8")
    .split("\n")
    .map((l) => {
      const i = l.indexOf("//");
      return i >= 0 ? l.slice(0, i) : l;
    })
    .join("\n");
}

/** Every `--foo` the source reads, as `foo`, in first-seen order, no filtering. */
export function flagsIn(src) {
  return [...new Set(Array.from(src.matchAll(/\barg\(\s*"([a-z0-9-]+)"/g), (m) => m[1]))];
}

/** The keys of the `const knobs = { … }` object literal, or null when there is none. */
export function knobKeysIn(src) {
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
