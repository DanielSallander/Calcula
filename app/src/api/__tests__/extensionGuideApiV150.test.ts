//! FILENAME: app/src/api/__tests__/extensionGuideApiV150.test.ts
// PURPOSE: The extension guide teaches what API v1.5.0 added -- every name in
//          the 1.5.0 entry of API_CHANGELOG (src/api/version.ts), one line each
//          on what it is for.
// CONTEXT: Canvas round 2 (2026-10-16). P1 added the solid background commit
//          to @api/visualContainer (solidBackgroundPatch, solidBackgroundIsNoop,
//          SolidBackgroundBase): picking one colour for a visual's background
//          clears a gradient and switches a hidden background on. The same
//          shape as extensionGuideApiV140.test.ts: derived from the changelog,
//          so a later 1.5.0 addition (another package of the round) fails here
//          until the guide teaches it.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { API_CHANGELOG } from "../version";

const GUIDE = fs
  .readFileSync(path.resolve(__dirname, "../../../../docs/EXTENSION_GUIDE.md"), "utf8")
  .replace(/\r\n/g, "\n");

const ENTRY = API_CHANGELOG.find((e) => e.version === "1.5.0");

/** The "## New in API v1.5.0" section: its heading to the next "## " heading. */
function section(): string {
  const at = GUIDE.indexOf("\n## New in API v1.5.0\n");
  if (at < 0) return "";
  const next = GUIDE.indexOf("\n## ", at + 1);
  return GUIDE.slice(at, next < 0 ? undefined : next);
}

describe('docs/EXTENSION_GUIDE.md "New in API v1.5.0"', () => {
  it("exists, and tells an author to declare ^1.5.0 when they use it", () => {
    expect(ENTRY, "API_CHANGELOG has no 1.5.0 entry: the test proves nothing").toBeDefined();
    const text = section();
    expect(text, 'the guide has no "## New in API v1.5.0" section').not.toBe("");
    expect(text).toContain('apiVersion: "^1.5.0"');
    expect(text, "the section does not point at the changelog it mirrors").toContain("API_CHANGELOG");
  });

  it("lists EVERY 1.5.0 addition, each on its own line with what it is for", () => {
    expect(ENTRY!.added.length, "the 1.5.0 entry adds nothing: the test proves nothing").toBeGreaterThan(0);
    const lines = section().split("\n");
    const missing: string[] = [];
    for (const { name } of ENTRY!.added) {
      const line = lines.find((l) => /^\s*- /.test(l) && l.includes("`" + name + "`"));
      // One line each: the name, then words saying what it is for.
      if (!line || line.replace(/`[^`]*`/g, "").replace(/[-:()\s]/g, "").length < 20) missing.push(name);
    }
    expect(missing, "these 1.5.0 additions have no line in the guide saying what they are for").toEqual([]);
  });

  it("names the module each runtime addition is imported from", () => {
    const text = section();
    const modules = [...new Set(ENTRY!.added.map((a) => a.module).filter((m): m is string => !!m))];
    expect(modules.length).toBeGreaterThan(0);
    for (const mod of modules) expect(text, `the section never says where to import from: ${mod}`).toContain("`" + mod);
  });

  it("teaches the solid-commit rule: the gradient is cleared and a hidden background switched on", () => {
    const text = section();
    expect(text).toMatch(/gradient/);
    expect(text).toMatch(/show: false/);
    expect(text).toContain("solidBackgroundIsNoop(hex, base)");
    expect(text).toContain("solidBackgroundPatch(null)");
  });
});
