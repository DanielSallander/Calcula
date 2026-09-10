// FILENAME: app/extensions/ModelEditor/__tests__/themeTokenContract.test.ts
// PURPOSE: Every `var(--x, …)` the Model Editor's theme layer references must
//          be a token the skin system actually stamps.
// CONTEXT: ASSERT IT, DON'T PROOFREAD IT. A misspelled custom property is the
//          quietest possible bug: `var(--surface, #fff)` simply takes its
//          fallback, so the window looks perfect in Light and stays white in
//          Dark. A prior design doc for this very work shipped
//          `var(--surface, #FFFFFF)` — a token that does not exist — and it
//          read fine to three reviewers.
//
//          Reads theme.ts as TEXT rather than importing it, because the values
//          are template strings assembled at module scope; the point is to
//          check what is WRITTEN, not what happens to evaluate.

import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const THEME_FILE = join(__dirname, "..", "components", "theme.ts");
// READ, don't import. `THEME_TOKENS` lives in src/core, and an extension —
// tests included — may only import through the @api facade; importing it here
// was a real boundary violation that `npm run lint:boundaries` caught. Reading
// the file as text also matches what this suite is for: checking what is
// WRITTEN on both sides, not what happens to evaluate.
const TOKENS_FILE = join(__dirname, "..", "..", "..", "src", "core", "theme", "tokens.ts");

function declaredTokens(source: string): Set<string> {
  const out = new Set<string>();
  for (const m of source.matchAll(/'(--[a-z0-9-]+)'|"(--[a-z0-9-]+)"/gi)) {
    out.add(m[1] ?? m[2]);
  }
  return out;
}

/** Custom properties this file may reference that the SKIN does not own. */
const NOT_SKIN_OWNED = new Set<string>([
  // Nothing yet. Every entry added here must say why the skin cannot own it.
]);

function referencedTokens(source: string): string[] {
  // `var(--name` — the fallback half is deliberately not parsed; a fallback may
  // itself be a var() and the regex would need to recurse for no benefit.
  const out = new Set<string>();
  for (const m of source.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) out.add(m[1]);
  return [...out].sort();
}

describe("Model Editor theme token contract", () => {
  const source = readFileSync(THEME_FILE, "utf8");
  const known = declaredTokens(readFileSync(TOKENS_FILE, "utf8"));

  it("references at least one token (the regex still matches something)", () => {
    // Guards the guard: if theme.ts is refactored to stop using var() strings,
    // this file would silently pass while checking nothing.
    expect(referencedTokens(source).length).toBeGreaterThan(10);
  });

  it("actually parsed the token declarations (the other half of the guard)", () => {
    // If tokens.ts moves or changes shape, `known` would come back empty and
    // every reference would look valid.
    expect(known.size).toBeGreaterThan(100);
    expect(known.has("--bg-surface")).toBe(true);
    expect(known.has("--tone-danger-fg")).toBe(true);
  });

  it("every referenced custom property exists in THEME_TOKENS", () => {
    const unknown = referencedTokens(source).filter(
      (t) => !known.has(t) && !NOT_SKIN_OWNED.has(t),
    );
    expect({ unknownTokens: unknown }).toEqual({ unknownTokens: [] });
  });

  it("every var() reference carries a literal fallback", () => {
    // The window renders before a skin is registered, and a bare var() with no
    // fallback resolves to the empty string — which is not "the default
    // colour", it is NO colour: transparent text on a transparent ground.
    const bare = [...source.matchAll(/var\(\s*(--[a-z0-9-]+)\s*\)/gi)].map((m) => m[1]);
    expect({ varsWithNoFallback: bare }).toEqual({ varsWithNoFallback: [] });
  });
});
