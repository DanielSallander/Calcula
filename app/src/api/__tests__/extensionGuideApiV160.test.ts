//! FILENAME: app/src/api/__tests__/extensionGuideApiV160.test.ts
// PURPOSE: The extension guide teaches what API v1.6.0 added -- every name in
//          the 1.6.0 entry of API_CHANGELOG (src/api/version.ts), one line each
//          on what it is for.
// CONTEXT: The model-visual drill-through (2026-10-23,
//          docs/design/model-drillthrough.md). The same shape as
//          extensionGuideApiV150.test.ts: derived from the changelog, so a
//          later 1.6.0 addition fails here until the guide teaches it.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { API_CHANGELOG } from "../version";

const GUIDE = fs
  .readFileSync(path.resolve(__dirname, "../../../../docs/EXTENSION_GUIDE.md"), "utf8")
  .replace(/\r\n/g, "\n");

const ENTRY = API_CHANGELOG.find((e) => e.version === "1.6.0");

/** The "## New in API v1.6.0" section: its heading to the next "## " heading. */
function section(): string {
  const at = GUIDE.indexOf("\n## New in API v1.6.0\n");
  if (at < 0) return "";
  const next = GUIDE.indexOf("\n## ", at + 1);
  return GUIDE.slice(at, next < 0 ? undefined : next);
}

describe('docs/EXTENSION_GUIDE.md "New in API v1.6.0"', () => {
  it("exists, and tells an author to declare ^1.6.0 when they use it", () => {
    expect(ENTRY, "API_CHANGELOG has no 1.6.0 entry: the test proves nothing").toBeDefined();
    const text = section();
    expect(text, 'the guide has no "## New in API v1.6.0" section').not.toBe("");
    expect(text).toContain('apiVersion: "^1.6.0"');
    expect(text, "the section does not point at the changelog it mirrors").toContain("API_CHANGELOG");
  });

  it("lists EVERY 1.6.0 addition, each on its own line with what it is for", () => {
    expect(ENTRY!.added.length, "the 1.6.0 entry adds nothing: the test proves nothing").toBeGreaterThan(0);
    const lines = section().split("\n");
    const missing: string[] = [];
    for (const { name } of ENTRY!.added) {
      const line = lines.find((l) => /^\s*- /.test(l) && l.includes("`" + name + "`"));
      // One line each: the name, then words saying what it is for.
      if (!line || line.replace(/`[^`]*`/g, "").replace(/[-:()\s]/g, "").length < 20) missing.push(name);
    }
    expect(missing, "these 1.6.0 additions have no line in the guide saying what they are for").toEqual([]);
  });

  it("names the module each runtime addition is imported from", () => {
    const text = section();
    const modules = [...new Set(ENTRY!.added.map((a) => a.module).filter((m): m is string => !!m))];
    expect(modules.length).toBeGreaterThan(0);
    for (const mod of modules) expect(text, `the section never says where to import from: ${mod}`).toContain("`" + mod);
  });

  it("teaches the key rule: a drill filters on member KEYS, never labels", () => {
    const text = section();
    expect(text).toMatch(/member keys?/i);
    expect(text).toMatch(/never (by )?(a )?label/i);
  });
});
