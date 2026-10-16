//! FILENAME: app/src/api/__tests__/extensionGuideApiV140.test.ts
// PURPOSE: The extension guide teaches what API v1.4.0 added -- every name in
//          the 1.4.0 entry of API_CHANGELOG (src/api/version.ts), one line each
//          on what it is for -- and what changed meaning.
// CONTEXT: WP-A S13 (canvas owner findings 2026-10-15). WP-A added extension
//          surface an author must be able to find: OverlayRegistration
//          .referenceAt (reference picks on a floating object -- a family that
//          does not register it is INERT during a pick, which changes what its
//          press code sees), ObjectSelectionProvider.innerClipboardCommand and
//          copyCellRange (an object's own inner cell selection answering the
//          Copy / Paste doors), @api/statusBarRange, hasDomTextSelection and
//          GridContextMenuItem.disabledReason. The same shape as
//          extensionGuideApiV120.test.ts: derived from the changelog, so a
//          later 1.4.0 addition (another work package of the programme) fails
//          here until the guide teaches it.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { API_CHANGELOG } from "../version";

const GUIDE = fs
  .readFileSync(path.resolve(__dirname, "../../../../docs/EXTENSION_GUIDE.md"), "utf8")
  .replace(/\r\n/g, "\n");

const ENTRY = API_CHANGELOG.find((e) => e.version === "1.4.0");

/** The "## New in API v1.4.0" section: its heading to the next "## " heading. */
function section(): string {
  const at = GUIDE.indexOf("\n## New in API v1.4.0\n");
  if (at < 0) return "";
  const next = GUIDE.indexOf("\n## ", at + 1);
  return GUIDE.slice(at, next < 0 ? undefined : next);
}

describe('docs/EXTENSION_GUIDE.md "New in API v1.4.0"', () => {
  it("exists, and tells an author to declare ^1.4.0 when they use it", () => {
    expect(ENTRY, "API_CHANGELOG has no 1.4.0 entry: the test proves nothing").toBeDefined();
    const text = section();
    expect(text, 'the guide has no "## New in API v1.4.0" section').not.toBe("");
    expect(text).toContain('apiVersion: "^1.4.0"');
    expect(text, "the section does not point at the changelog it mirrors").toContain("API_CHANGELOG");
  });

  it("lists EVERY 1.4.0 addition, each on its own line with what it is for", () => {
    expect(ENTRY!.added.length, "the 1.4.0 entry adds nothing: the test proves nothing").toBeGreaterThan(10);
    const lines = section().split("\n");
    const missing: string[] = [];
    for (const { name } of ENTRY!.added) {
      const line = lines.find((l) => /^\s*- /.test(l) && l.includes("`" + name + "`"));
      // One line each: the name, then words saying what it is for.
      if (!line || line.replace(/`[^`]*`/g, "").replace(/[-:()\s]/g, "").length < 20) missing.push(name);
    }
    expect(missing, "these 1.4.0 additions have no line in the guide saying what they are for").toEqual([]);
  });

  it("names the module each runtime addition is imported from", () => {
    const text = section();
    const modules = [...new Set(ENTRY!.added.map((a) => a.module).filter((m): m is string => !!m))];
    expect(modules.length).toBeGreaterThan(1);
    for (const mod of modules) expect(text, `the section never says where to import from: ${mod}`).toContain("`" + mod);
  });

  it("teaches the referenceAt contract: pure, inert without it, invisible to the family's press code", () => {
    const text = section();
    expect(text).toMatch(/referenceAt\(ctx: OverlayHitTestContext\): OverlayReferencePick \| null/);
    expect(text).toMatch(/PURE/);
    expect(text).toMatch(/INERT/);
    expect(text).toContain("floatingObject:selected");
    expect(text).toContain("isFormulaReferencePickActive()");
  });

  it("states each CHANGED meaning", () => {
    const text = section();
    expect(text).toMatch(/### Changed meanings/);
    expect(text).toMatch(/no longer reaches its family/);
    expect(text).toMatch(/`clipboardDoorCommand` answers an inner selection's own command first/);
    expect(text).toMatch(/`disabledReason` is resolved only while the item is disabled/);
  });
});
