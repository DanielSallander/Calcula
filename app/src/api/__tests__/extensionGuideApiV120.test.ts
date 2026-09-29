//! FILENAME: app/src/api/__tests__/extensionGuideApiV120.test.ts
// PURPOSE: The extension guide teaches what API v1.2.0 added -- every name in
//          API_CHANGELOG (src/api/version.ts), one line each on what it is for
//          -- and what changed meaning.
// CONTEXT: Z12 (wave F; wave E core report NEEDS 3). Wave E moved API_VERSION
//          to 1.2.0 and made the additions DATA (API_CHANGELOG, checked real by
//          apiVersion.test.ts), but docs/EXTENSION_GUIDE.md -- the page a
//          third-party author reads -- stopped at "New in API v1.1.0": an
//          author could not learn that `ownUndoTransaction` exists, nor that
//          `apiVersion: "^1.2.0"` is how to say they need it. Derived from the
//          changelog, so the next addition fails here until it is documented.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { API_CHANGELOG } from "../version";

const GUIDE = fs
  .readFileSync(path.resolve(__dirname, "../../../../docs/EXTENSION_GUIDE.md"), "utf8")
  .replace(/\r\n/g, "\n");

const ENTRY = API_CHANGELOG.find((e) => e.version === "1.2.0");

/** The "## New in API v1.2.0" section: its heading to the next "## " heading. */
function section(): string {
  const at = GUIDE.indexOf("\n## New in API v1.2.0\n");
  if (at < 0) return "";
  const next = GUIDE.indexOf("\n## ", at + 1);
  return GUIDE.slice(at, next < 0 ? undefined : next);
}

describe('docs/EXTENSION_GUIDE.md "New in API v1.2.0"', () => {
  it("exists, and tells an author to declare ^1.2.0 when they use it", () => {
    expect(ENTRY, "API_CHANGELOG has no 1.2.0 entry: the test proves nothing").toBeDefined();
    const text = section();
    expect(text, 'the guide has no "## New in API v1.2.0" section').not.toBe("");
    expect(text).toContain('apiVersion: "^1.2.0"');
    expect(text, "the section does not point at the changelog it mirrors").toContain("API_CHANGELOG");
  });

  it("lists EVERY 1.2.0 addition, each on its own line with what it is for", () => {
    const lines = section().split("\n");
    const missing: string[] = [];
    for (const { name } of ENTRY!.added) {
      const line = lines.find((l) => /^\s*- /.test(l) && l.includes("`" + name + "`"));
      // One line each: the name, then words saying what it is for.
      if (!line || line.replace(/`[^`]*`/g, "").replace(/[-:()\s]/g, "").length < 20) missing.push(name);
    }
    expect(missing, "these 1.2.0 additions have no line in the guide saying what they are for").toEqual([]);
  });

  it("names the module each runtime addition is imported from", () => {
    const text = section();
    const modules = [...new Set(ENTRY!.added.map((a) => a.module).filter((m): m is string => !!m))];
    expect(modules.length).toBeGreaterThan(1);
    for (const mod of modules) expect(text, `the section never says where to import from: ${mod}`).toContain("`" + mod);
  });

  it("states each CHANGED meaning", () => {
    const text = section();
    expect(text).toMatch(/any depth/i);
    expect(text).toMatch(/registered OBJECT/i);
    expect(text).toMatch(/ticket/i);
  });
});
