//! FILENAME: app/src/api/__tests__/dryRunReportDrift.test.ts
// PURPOSE: Pin the TypeScript mirror of `DryRunReport` to the Rust struct that
//          actually serialises over IPC.
// CONTEXT: `ai/dryrun.rs` is the source of truth; the TS interface in
//          scriptAuthoring is a hand-written mirror, and a hand-written mirror
//          drifts. It drifted the day `applicable` was added: every caller
//          branches on that field, and a mirror missing it silently reads
//          `undefined` — which, for a boolean guard, means the guard is off.
//
//          Direction is fixed Rust -> TypeScript, matching
//          interpreterReachDrift.test.ts: the renderer can be compromised, the
//          backend is where the answer is produced.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const RUST = resolve(__dirname, "../../../src-tauri/src/ai/dryrun.rs");
const MIRROR = resolve(__dirname, "../scriptHost/scriptAuthoring/index.ts");
const NOTE = resolve(__dirname, "../scriptHost/scriptPreview/unexercisedHooks.ts");

/**
 * The sentence both realms say, in the pieces each file writes it in.
 *
 * Every fragment must be SOURCE-CONTIGUOUS in both files: the TypeScript `+`
 * split and the Rust `\` line continuation both fall after "the preview ", so no
 * fragment straddles either break. Compared as source text rather than by
 * calling the two functions, because one of them is Rust.
 */
const SHARED_FRAGMENTS = [
  "The script registered ",
  "but the preview ",
  "never fired it, so nothing that handler does was measured.",
  "never fired any of them, so nothing those handlers do was measured.",
];

/** snake_case -> camelCase, the way `#[serde(rename_all = "camelCase")]` does. */
function camel(name: string): string {
  return name.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
}

/** Field names of one `pub struct`, in declaration order. */
function rustFields(source: string, name: string): string[] {
  const start = source.indexOf(`pub struct ${name} {`);
  if (start < 0) throw new Error(`struct ${name} not found in ai/dryrun.rs`);
  const end = source.indexOf("\n}", start);
  const body = source.slice(start, end);
  return [...body.matchAll(/^\s*pub (\w+):/gm)].map((m) => camel(m[1]));
}

/** Property names of one exported TS interface. */
function tsFields(source: string, name: string): string[] {
  const start = source.indexOf(`export interface ${name} {`);
  if (start < 0) throw new Error(`interface ${name} not found in the mirror`);
  const end = source.indexOf("\n}", start);
  const body = source.slice(start, end);
  return [...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]);
}

describe("DryRunReport — the TS mirror matches the Rust struct", () => {
  const rust = readFileSync(RUST, "utf8");
  const mirror = readFileSync(MIRROR, "utf8");

  it("carries exactly the fields the backend serialises", () => {
    const expected = rustFields(rust, "DryRunReport");
    const actual = tsFields(mirror, "DryRunReport");

    // Sorted: declaration order is not part of the wire contract.
    expect([...actual].sort()).toEqual([...expected].sort());
  });

  it("reads the real files, so the comparison cannot pass vacuously", () => {
    expect(rustFields(rust, "DryRunReport").length).toBeGreaterThan(5);
    expect(rustFields(rust, "DryRunReport")).toContain("applicable");
    expect(rustFields(rust, "CellReadback")).toEqual(["row", "col", "value"]);
  });

  /**
   * `applicable` is the one field whose absence is silently WRONG rather than
   * loudly wrong: every consumer guards with `applicable === false`, which is
   * `false` for `undefined`, so a dropped field turns the guard off and restores
   * the exact defect it was added to fix.
   */
  it("keeps `applicable` non-optional in the mirror", () => {
    const body = mirror.slice(mirror.indexOf("export interface DryRunReport {"));
    expect(body).toMatch(/^ {2}applicable: boolean;/m);
  });

  /**
   * `unexercisedHooks` fails the same way `applicable` did, one step further on:
   * an optional field reads `undefined`, `(undefined?.length ?? 0) > 0` is
   * false, and the caveat that exists to stop a correct draft being sent back
   * for repair silently never fires.
   */
  it("keeps `unexercisedHooks` non-optional in the mirror", () => {
    const body = mirror.slice(mirror.indexOf("export interface DryRunReport {"));
    expect(body).toMatch(/^ {2}unexercisedHooks: string\[\];/m);
  });
});

/**
 * TWO REALMS, ONE SENTENCE.
 *
 * The Worker-realm preview and the Rust interpreter both answer "did anything
 * this script registered go unfired?", and a reviewer reading the answer must
 * not be able to tell which rung produced it from the wording. There is no way
 * to call the Rust function from here, so the two are pinned as source text.
 */
describe("the unexercised-hook note says the same words in both realms", () => {
  const rust = readFileSync(RUST, "utf8");
  const ts = readFileSync(NOTE, "utf8");

  it.each(SHARED_FRAGMENTS)("says %j in both files", (fragment) => {
    expect(ts, "the TypeScript leaf").toContain(fragment);
    expect(rust, "the Rust twin").toContain(fragment);
  });

  it("reads the real files, so the comparison cannot pass vacuously", () => {
    expect(ts).toContain("export function unexercisedHookNote");
    expect(rust).toContain("pub fn unexercised_hook_note");
  });
});
