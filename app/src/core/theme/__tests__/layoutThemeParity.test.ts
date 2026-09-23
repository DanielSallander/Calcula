//! FILENAME: app/src/core/theme/__tests__/layoutThemeParity.test.ts
// PURPOSE: Every CSS custom property the @api/layout primitives paint with must
//          be declared by the theme, and must carry a fallback.
// CONTEXT: THE MIRROR OF themeTokenParity.test.ts, for the OTHER second copy.
//          `app/src/api/layout/theme.ts` (the `LT` table) is the one file in
//          @api/layout allowed to hold colour literals, and every primitive in
//          the Calcula Clusters control grammar — Button, Popover, Menu,
//          Dropdown, Tooltip, the toggles, the ribbon cluster itself — paints
//          ONLY through it. So a misspelled name there is not one wrong
//          surface; it is that colour missing from the whole ribbon, and it
//          would be invisible in Light because the fallback IS the light value.
//          It shows up only in Dark or in a skin, which is exactly the class
//          of defect the sibling test was written after (four invented names
//          shipped in the design-query row and nothing noticed).
//
//          WHY IT READS THE FILE INSTEAD OF IMPORTING `LT`. Two reasons, both
//          deliberate:
//            1. The subject is what is WRITTEN. `var()` names are only visible
//               as text; an import gives back strings that must then be
//               re-parsed anyway, and a future refactor that assembled the
//               values from template pieces would make an import-based check
//               pass while checking nothing. Reading the source checks the
//               spelling a reviewer sees.
//            2. It keeps the dependency pointing the right way. This test lives
//               in core because its subject is the theme, which is core's;
//               core must not import from `src/api` (the Alien rule runs one
//               way), and a test that did would be the first crack in that.
//          Comments are stripped before scanning, because theme.ts EXPLAINS the
//          bare-var() shorthand failure in prose, and a textual scan would
//          report the explanation as the violation. The stripper is the shared
//          scanner in ./sourceText.ts, NOT the two-regex version this suite was
//          first written with: theme.ts's own header mentions
//          `src/api/layout/**`, the regex read that `/**` as a comment opener,
//          and the first run of this guard found exactly ONE token name in the
//          whole table — which the "found the table" case below exists to catch.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { THEME_TOKENS } from "../tokens";
import { defaultTheme } from "../defaultTheme";
import { codeOf } from "./sourceText";

const LAYOUT_THEME = join(process.cwd(), "src/api/layout/theme.ts");

function layoutThemeCode(): string {
  return codeOf(readFileSync(LAYOUT_THEME, "utf8"));
}

/** Every `var(--name` written in the LT table's code. */
function namesUsed(): string[] {
  return Array.from(layoutThemeCode().matchAll(/var\(\s*(--[a-z0-9-]+)/gi), (m) => m[1]);
}

describe("the @api/layout theme table names only real theme tokens", () => {
  it("actually found the table (the guard is checking something)", () => {
    // If theme.ts moved or stopped spelling var() strings, `namesUsed` would
    // come back empty and every other assertion here would pass vacuously.
    const used = namesUsed();
    expect(used.length).toBeGreaterThan(20);
    expect(used).toContain("--state-accent");
    expect(used).toContain("--control-border");
  });

  it("every var(--name) in src/api/layout/theme.ts is declared in THEME_TOKENS", () => {
    const declared = new Set<string>(Object.values(THEME_TOKENS));
    const unknown = namesUsed().filter((n) => !declared.has(n));
    expect(
      { undeclaredInLayoutTheme: unknown },
      "`var()` with an unknown name silently resolves to its fallback, so the " +
        "primitive looks right in Light and never follows a skin. Add the name " +
        "to core/theme/tokens.ts with a value in BOTH baselines.",
    ).toEqual({ undeclaredInLayoutTheme: [] });
  });

  it("every declared name it uses has a value in the light baseline", () => {
    // Belt and braces with tokens.test.ts: that suite checks every token has a
    // value; this one pins that the LT subset in particular does, so a token
    // removed from the baselines but left in THEME_TOKENS fails HERE too, next
    // to the table that depends on it.
    const missing = namesUsed().filter((n) => defaultTheme[n] === undefined);
    expect({ noLightValue: missing }).toEqual({ noLightValue: [] });
  });

  it("every var() carries a fallback, because a bare var() can invalidate a shorthand", () => {
    // `border: 1px solid var(--x)` with `--x` undefined is not a border in a
    // default colour — the WHOLE declaration is invalid and no border paints.
    // That shipped once; the LT table is interpolated into shorthands on
    // purpose (`1px solid ${LT.controlBorder}`), so it must never be bare.
    const bare = Array.from(
      layoutThemeCode().matchAll(/var\(\s*(--[a-z0-9-]+)\s*\)/gi),
      (m) => m[1],
    );
    expect(bare, `these names have no fallback: ${bare.join(", ")}`).toEqual([]);
  });
});
