//! FILENAME: app/src/core/theme/__tests__/themeTokenParity.test.ts
// PURPOSE: Every CSS custom property a shared component names must actually be
//          declared by the theme.
// CONTEXT: FOUR INVENTED NAMES SHIPPED AND NOTHING NOTICED. The design-query row
//          styled itself with `--border-color`, `--input-bg`, `--success-color`
//          and `--error-color`; none of the four is declared anywhere — not in
//          `THEME_TOKENS`, not in `defaultTheme`, not in `darkTheme`, not in a
//          skin, and `src/index.css` declares no custom properties at all. Every
//          one silently fell through to its hardcoded literal, so the row never
//          followed the user's skin in its whole life. A sibling was worse:
//          `border: "1px solid var(--border-color)"` with NO fallback is an
//          invalid shorthand, so three of five mounts painted no border at all.
//
//          Nothing could have caught it. `var()` with an undefined name is legal
//          CSS that resolves to its fallback, so there is no console warning, no
//          type error and no visual failure loud enough to notice — the surface
//          just quietly stops being themed.
//
//          THIS TEST LIVES IN `src/core/theme` AND NOT IN `@api`. Its subject is
//          the theme, which is core's, and `src/api/**` is under a
//          `no-restricted-imports` block with no `ignores` for tests — so a
//          future tidy-up that replaced the `fs` read with an import would trip
//          lint from there. It reads the extension file rather than importing it
//          for the mirror-image reason: `FACADE_IMPORT_PATTERNS` bans `@core`
//          and `src/core/**` from everything under `extensions/`, so the shared
//          table CANNOT import `THEME_TOKENS` and is necessarily a second copy.
//          A second copy that drifts is the whole failure, so the guard reads
//          both files at test time — the same shape as `interpreterReachDrift`.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { THEME_TOKENS } from "../tokens";

const SHARED_TOKENS = join(process.cwd(), "extensions/_shared/lib/themeTokens.ts");

/** Every `--name` the theme declares. */
function declaredNames(): Set<string> {
  return new Set(Object.values(THEME_TOKENS));
}

/**
 * A source file with its comments removed.
 *
 * NOT decoration. This guard's own subject files EXPLAIN the phantom names in
 * prose — including, in one case, the exact invalid declaration
 * `1px solid var(--border-color)` quoted as the thing not to do. A textual scan
 * handed the raw file reports those explanations as violations, so a file is
 * penalised for documenting the bug it fixed. This repo has the same defect on
 * record one layer over, where a `word(` inside a comment fabricated a call edge
 * in the store census.
 */
function codeOf(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => {
      const i = line.indexOf("//");
      return i >= 0 ? line.slice(0, i) : line;
    })
    .join("\n");
}

/** Every `var(--name)` written in a file's CODE. */
function namesUsedIn(rel: string): string[] {
  const src = codeOf(readFileSync(join(process.cwd(), rel), "utf8"));
  return Array.from(src.matchAll(/var\(\s*(--[a-z0-9-]+)/gi), (m) => m[1]);
}

describe("the shared token table names only real theme tokens", () => {
  it("every name in extensions/_shared/lib/themeTokens.ts is declared by the theme", () => {
    const declared = declaredNames();
    const used = namesUsedIn("extensions/_shared/lib/themeTokens.ts");
    expect(used.length).toBeGreaterThan(5);
    for (const name of used) {
      expect(
        declared.has(name),
        `"${name}" is not declared in THEME_TOKENS. \`var()\` with an unknown ` +
          `name silently resolves to its fallback, so this does not fail ` +
          `anywhere at runtime — the surface just stops following the skin.`,
      ).toBe(true);
    }
  });

  it("every name carries a fallback, because a bare var() can invalidate a shorthand", () => {
    // `border: 1px solid var(--x)` with `--x` undefined and no fallback is not
    // "a border with a default colour" — the whole declaration is invalid and
    // NO border is painted. That shipped.
    const src = codeOf(readFileSync(SHARED_TOKENS, "utf8"));
    const bare = Array.from(src.matchAll(/var\(\s*(--[a-z0-9-]+)\s*\)/gi), (m) => m[1]);
    expect(bare, `these names have no fallback: ${bare.join(", ")}`).toEqual([]);
  });
});

describe("shared surfaces do not invent token names", () => {
  // A GROWING LIST, NOT A SWEEP. Phantom token names are spread widely enough
  // across `extensions/` that scanning everything would red the build on
  // defects this change is not fixing, and a red that nobody can act on gets
  // suppressed rather than fixed. Each file lands here as it is cleaned, which
  // at least makes the cleaned ones stay clean.
  const FILES = [
    "extensions/_shared/components/ModelChooserRow.tsx",
    "extensions/_shared/dsl/pivotLayout/DesignQueryEditor.tsx",
    "extensions/_shared/dsl/pivotLayout/NextEditRow.tsx",
    // Both read `--bg-primary`, `--border-color`, `--input-bg`, `--error-color`
    // and `--bg-secondary` — five names, none declared — so neither dialog ever
    // followed the skin.
    "extensions/Reports/components/CreateReportDialog.tsx",
    "extensions/Reports/components/EditReportDialog.tsx",
  ];

  for (const rel of FILES) {
    it(`${rel} names only declared tokens`, () => {
      const declared = declaredNames();
      for (const name of namesUsedIn(rel)) {
        expect(
          declared.has(name),
          `${rel} reads "${name}", which the theme does not declare. Use the ` +
            `table in extensions/_shared/lib/themeTokens.ts.`,
        ).toBe(true);
      }
    });
  }
});
