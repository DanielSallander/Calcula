//! FILENAME: app/src/api/__tests__/gridMenuContextDrift.test.ts
// PURPOSE: The context a grid context-menu item receives (@api/extensions'
//          `GridMenuContext`) is Core's, by derivation -- never a copied
//          interface that drifts.
// CONTEXT: Round-3 finding (K5, 2026-09-28). api/extensions.ts declared its own
//          `GridMenuContext` under a "MUST match core/lib/gridCommands.ts
//          exactly" banner, and it had drifted: Core builds the context WITH
//          `dimensions` (the hidden rows/columns an item needs to decide what it
//          acts on -- Spreadsheet.tsx fills it on every right-click), and the
//          @api copy did not declare it, so an extension obeying the Facade Rule
//          could not read what it was handed. The same banner had already let
//          `GridCommand` fall to 8 of 18 commands (gridCommandDrift.test.ts).
//          Types are erased at run time and the type-check gate does not compile
//          tests, so the derivation is pinned from the source text.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const API_EXTENSIONS = path.resolve(__dirname, "../extensions.ts");
const CORE_GRID = path.resolve(__dirname, "../../core/lib/gridCommands.ts");

describe("@api GridMenuContext is DERIVED from Core", () => {
  it("api/extensions.ts declares no GridMenuContext of its own and re-exports Core's", () => {
    const source = readFileSync(API_EXTENSIONS, "utf8");
    expect(source, "a hand-written GridMenuContext is back in @api").not.toMatch(
      /export\s+interface\s+GridMenuContext\b/,
    );
    expect(source).toMatch(
      /export\s+type\s*\{[^}]*\bGridMenuContext\b[^}]*\}\s*from\s*"\.\.\/core\/lib\/gridCommands"/,
    );
  });

  it("Core's context carries the hidden-row/column state an item is handed", () => {
    const source = readFileSync(CORE_GRID, "utf8");
    // The interface body runs to the first `}` at the start of a line (a nested
    // `{ row; col }` field closes mid-line).
    const match = source.match(/export\s+interface\s+GridMenuContext\s*\{([\s\S]*?)\r?\n\}/);
    expect(match, "Core's GridMenuContext was not found -- this guard reads nothing").not.toBeNull();
    expect(match![1]).toMatch(/\bdimensions\s*:\s*DimensionOverrides\s*;/);
  });
});
