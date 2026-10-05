//! FILENAME: app/extensions/BuiltIn/HomeTab/__tests__/homeTabOneCopy.test.ts
// PURPOSE: ONE copy of each shared rule the Home tab uses -- the command door,
//          the formatting announcement, the selection's blocks, the active
//          cell, the font-size ladder -- and no second spelling of any of them
//          inside the extension.
// CONTEXT: Review finding (2026-10-04): four byte-identical run*Command doors,
//          four copies of the "cellEvents + styles:refresh + grid:refresh"
//          announcement, three selectionBlocks copies (one of which did not
//          de-duplicate), a local active-cell rule and a local font ladder.
//          Two such copies in this programme had ALREADY drifted (the mini
//          toolbar's ladder, Series AutoFill). The rules now live in @api
//          (selectionBlocks, announceFormatting, activeCell, fontSizeLadder)
//          and in components/runCommand.ts; this census fails the moment a copy
//          comes back. It reads the source, because a copy is a SOURCE fact:
//          behaviour tests cannot tell two identical copies from one.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");

/** Every non-test source file of the extension, relative to its root. */
function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__") walk(full);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        out.push(path.relative(ROOT, full).split(path.sep).join("/"));
      }
    }
  };
  walk(ROOT);
  return out.sort();
}

/** The files whose source matches `pattern`. */
function filesMatching(pattern: RegExp): string[] {
  return sources().filter((file) => pattern.test(fs.readFileSync(path.join(ROOT, file), "utf8")));
}

describe("one copy of each shared rule", () => {
  it("finds the extension's sources (the census reads something)", () => {
    expect(sources()).toContain("components/runCommand.ts");
    expect(sources()).toContain("components/useHomeTabState.ts");
    expect(sources().length).toBeGreaterThan(30);
  });

  it("ONE command door: components/runCommand.ts, and no other try { CommandRegistry.execute } + alertAsync runner", () => {
    expect(filesMatching(/export\s+async\s+function\s+run\w*Command\s*\(/)).toEqual(["components/runCommand.ts"]);
    for (const gone of [
      "components/clipboard/runHomeCommand.ts",
      "components/cells/runCellsCommand.ts",
      "components/editing/runEditingCommand.ts",
    ]) {
      expect(fs.existsSync(path.join(ROOT, gone)), gone).toBe(false);
    }
  });

  it("ONE announcement: nothing here emits cell events itself (@api/announceFormatting does)", () => {
    expect(filesMatching(/cellEvents\.emit\s*\(/)).toEqual([]);
  });

  it("ONE selectionBlocks: @api/selectionBlocks, never a local definition or an inline [sel, ...additionalRanges]", () => {
    expect(filesMatching(/function\s+selectionBlocks\s*\(/)).toEqual([]);
    expect(filesMatching(/\.\.\.\(\s*\w+\.additionalRanges\s*\?\?\s*\[\]\s*\)/)).toEqual([]);
  });

  it("ONE active-cell rule: @api/activeCell, never a local file or definition", () => {
    expect(fs.existsSync(path.join(ROOT, "components/activeCell.ts"))).toBe(false);
    expect(filesMatching(/function\s+activeCellOf\s*\(/)).toEqual([]);
  });

  it("ONE font-size ladder: _shared/lib/fontList's (@api/fontSizeLadder), never a local list", () => {
    expect(filesMatching(/FONT_SIZE_LADDER\s*(:[^=]*)?=\s*\[/)).toEqual([]);
    expect(filesMatching(/function\s+fontSizeStep\s*\(/)).toEqual([]);
  });
});
