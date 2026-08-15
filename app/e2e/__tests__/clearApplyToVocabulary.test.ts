//! FILENAME: app/e2e/__tests__/clearApplyToVocabulary.test.ts
// PURPOSE: Fail the build when an E2E call site spells `clear_range_with_options`'s
//          `applyTo` in a casing the Rust command REJECTS.
// CONTEXT: `ClearApplyTo` (app/src-tauri/src/api_types.rs) carries
//          `#[serde(rename_all = "camelCase")]`, so the only values that reach the
//          command are `all | contents | formats | hyperlinks | removeHyperlinks |
//          resetContents`. Anything else -- `"All"`, `"Formats"`, `"Contents"` --
//          fails deserialization with `unknown variant`, the invoke rejects, and
//          EVERY call site in the tree wraps that invoke in `.catch(() => {})`
//          because the command "might not exist". The result is a clear that
//          silently does nothing.
//
//          MEASURED LIVE 2026-08-15 against the running backend on CDP 9223:
//
//            "All"      -> REJECTED: unknown variant `All`
//            "all"      -> ACCEPTED
//            "Formats"  -> REJECTED: unknown variant `Formats`
//            "formats"  -> ACCEPTED
//            "Contents" -> REJECTED: unknown variant `Contents`
//            "contents" -> ACCEPTED
//
//          Five call sites were on the rejected side, and they were not
//          incidental ones. `resetGrid` (e2e/helpers/screenshots.ts) is the
//          suite's own reset, and four `test.afterAll` blocks -- animation,
//          charts, dimensions, edge-cases -- were written specifically to close
//          the cross-spec residue class recorded as sec 3a/3b in
//          docs/design/open-decisions-2026-08.md. All five had never executed.
//          The register's remediation for that class was, in effect, unenforced.
//
//          A grep would have found it in a second and nobody ran one, because
//          nothing SAID the vocabulary was case-sensitive. This test says it, and
//          it reads the vocabulary out of the Rust source rather than restating
//          it, so a variant added or renamed on the Rust side cannot leave a
//          stale allowlist behind here.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** `app/` — vitest's root. */
const APP_ROOT = process.cwd();
const E2E_ROOT = join(APP_ROOT, "e2e");
const API_TYPES_RS = join(APP_ROOT, "src-tauri", "src", "api_types.rs");

/**
 * The accepted wire vocabulary, READ OUT OF THE RUST ENUM.
 *
 * Deliberately not a literal list: the whole defect this file exists for is a
 * second, drifting copy of a Rust serializer's vocabulary living in TypeScript.
 */
function acceptedApplyToValues(): string[] {
  const src = readFileSync(API_TYPES_RS, "utf8");
  const decl = /pub enum ClearApplyTo \{([\s\S]*?)\n\}/.exec(src);
  if (!decl) {
    throw new Error(
      `Could not find \`pub enum ClearApplyTo\` in ${API_TYPES_RS}. If it was ` +
        `renamed or moved, point this test at it — do not replace the read with ` +
        `a hard-coded list, which is the defect this test exists to prevent.`,
    );
  }
  const variants = [...decl[1].matchAll(/^\s{4}([A-Z][A-Za-z0-9]*)\s*,/gm)].map((m) => m[1]);
  expect(
    variants.length,
    "no variants parsed out of ClearApplyTo — the regex has drifted from the Rust source",
  ).toBeGreaterThan(0);
  // `#[serde(rename_all = "camelCase")]` on the enum: `All` -> `all`,
  // `RemoveHyperlinks` -> `removeHyperlinks`.
  return variants.map((v) => v.charAt(0).toLowerCase() + v.slice(1));
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "test-results") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (/\.(ts|mts|mjs)$/.test(entry.name) && statSync(full).isFile()) acc.push(full);
  }
  return acc;
}

describe("clear_range_with_options applyTo vocabulary", () => {
  it("derives the accepted values from the Rust enum, camelCased", () => {
    expect(acceptedApplyToValues()).toEqual([
      "all",
      "contents",
      "formats",
      "hyperlinks",
      "removeHyperlinks",
      "resetContents",
    ]);
  });

  it("no E2E call site passes an applyTo value the backend rejects", () => {
    const accepted = new Set(acceptedApplyToValues());
    const offenders: string[] = [];

    // This file quotes the pattern in its own failure message; scanning it
    // would report the scanner. (It also proves the scanner works: it flagged
    // itself on the first run.)
    const SELF = join(E2E_ROOT, "__tests__", "clearApplyToVocabulary.test.ts");

    for (const file of walk(E2E_ROOT)) {
      if (file === SELF) continue;
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/applyTo:\s*"([^"]*)"/g)) {
        if (!accepted.has(m[1])) {
          const line = src.slice(0, m.index ?? 0).split("\n").length;
          offenders.push(
            `${file.slice(APP_ROOT.length + 1).replace(/\\/g, "/")}:${line} — applyTo: "${m[1]}"`,
          );
        }
      }
    }

    expect(
      offenders,
      `An E2E call site passes an \`applyTo\` value \`ClearApplyTo\` does not accept.\n` +
        `serde will answer \`unknown variant\`, the invoke will reject, and the \`.catch()\`\n` +
        `every one of these call sites carries will swallow it — so the clear silently\n` +
        `does not happen and the residue survives into the next spec's golden.\n` +
        `Accepted: ${[...accepted].join(" | ")}\n` +
        offenders.map((o) => `  ${o}`).join("\n"),
    ).toEqual([]);
  });
});
