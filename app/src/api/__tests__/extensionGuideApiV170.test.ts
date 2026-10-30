//! FILENAME: app/src/api/__tests__/extensionGuideApiV170.test.ts
// PURPOSE: The extension guide teaches what API v1.7.0 added -- every name in
//          the 1.7.0 entry of API_CHANGELOG (src/api/version.ts), one line each
//          on what it is for.
// CONTEXT: The bug-ledger fix programme (2026-10-29). The same shape as
//          extensionGuideApiV160.test.ts: derived from the changelog, so a
//          later 1.7.0 addition fails here until the guide teaches it.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { API_CHANGELOG } from "../version";

const GUIDE = fs
  .readFileSync(path.resolve(__dirname, "../../../../docs/EXTENSION_GUIDE.md"), "utf8")
  .replace(/\r\n/g, "\n");

const ENTRY = API_CHANGELOG.find((e) => e.version === "1.7.0");

/** The "## New in API v1.7.0" section: its heading to the next "## " heading. */
function section(): string {
  const at = GUIDE.indexOf("\n## New in API v1.7.0\n");
  if (at < 0) return "";
  const next = GUIDE.indexOf("\n## ", at + 1);
  return GUIDE.slice(at, next < 0 ? undefined : next);
}

describe('docs/EXTENSION_GUIDE.md "New in API v1.7.0"', () => {
  it("exists, and tells an author to declare ^1.7.0 when they use it", () => {
    expect(ENTRY, "API_CHANGELOG has no 1.7.0 entry: the test proves nothing").toBeDefined();
    const text = section();
    expect(text, 'the guide has no "## New in API v1.7.0" section').not.toBe("");
    expect(text).toContain('apiVersion: "^1.7.0"');
    expect(text, "the section does not point at the changelog it mirrors").toContain("API_CHANGELOG");
  });

  it("lists EVERY 1.7.0 addition, each on its own line with what it is for", () => {
    expect(ENTRY!.added.length, "the 1.7.0 entry adds nothing: the test proves nothing").toBeGreaterThan(0);
    const lines = section().split("\n");
    const missing: string[] = [];
    for (const { name } of ENTRY!.added) {
      const line = lines.find((l) => /^\s*- /.test(l) && l.includes("`" + name + "`"));
      // One line each: the name, then words saying what it is for.
      if (!line || line.replace(/`[^`]*`/g, "").replace(/[-:()\s]/g, "").length < 20) missing.push(name);
    }
    expect(missing, "these 1.7.0 additions have no line in the guide saying what they are for").toEqual([]);
  });

  it("names the module each runtime addition is imported from", () => {
    const text = section();
    const modules = [...new Set(ENTRY!.added.map((a) => a.module).filter((m): m is string => !!m))];
    expect(modules.length).toBeGreaterThan(0);
    for (const mod of modules) expect(text, `the section never says where to import from: ${mod}`).toContain("`" + mod);
  });

  it("teaches the key rule: a sheet is named by its stable id, never a stale index or name", () => {
    const text = section();
    expect(text).toMatch(/stable id/i);
    expect(text).toMatch(/never by the index or name/i);
  });

  // Round 6 (apidocs; reviews rev4B#3 and rev4A#3): a type's line that names
  // only some of its members teaches an extension to send only those -- the
  // SheetsRenumbering line said removedIndex alone after round 4 added
  // insertedIndex and moved, and the PastedConstant line taught `keepKind`
  // after round 5 replaced it with `pasted`. Derived from the declarations, so
  // a member added later fails here until the guide names it.
  it("the line of each 1.7.0 interface names EVERY member that interface declares", () => {
    const lines = section().split("\n");
    const checked: string[] = [];
    const missing: string[] = [];
    for (const a of ENTRY!.added) {
      if (a.module || !a.declaredIn || a.name.includes(".")) continue;
      const members = interfaceMembers(a.declaredIn, a.name);
      if (members === null) continue;
      checked.push(a.name);
      // The type's OWN line, the one that opens with its name (other lines may
      // mention it: announceSheetsChanged's names SheetsRenumbering).
      const line = lines.find((l) => l.trimStart().startsWith("- `" + a.name + "`")) ?? "";
      // `pasted` must be named as itself: `pastedConstantInput` is not it.
      for (const m of members) if (!new RegExp("`" + m + "(?![\\w$])").test(line)) missing.push(`${a.name}.${m}`);
    }
    expect(checked, "no 1.7.0 interface was found to check: the test proves nothing").toContain("SheetsRenumbering");
    expect(checked).toContain("PastedConstant");
    expect(missing, "the guide's line for these 1.7.0 types does not name these members").toEqual([]);
  });

  it("never teaches PastedConstant.keepKind, which round 5 replaced with `pasted`", () => {
    expect(section()).not.toContain("keepKind");
  });

  // Every 1.7.0 "changed" line that opens with @api names (`handleGlobalKeyDown:`,
  // `updateCellsBatch / updateCellOnSheets:`, ...) has its names in the guide's
  // "Changed meanings" -- a changed meaning the guide never mentions is one an
  // extension author cannot learn (rev4A#3: the guide kept a stale sentence).
  it("'Changed meanings' names every @api name a 1.7.0 'changed' line opens with", () => {
    const text = section();
    const at = text.indexOf("\n### Changed meanings (compatible)\n");
    expect(at, "the 1.7.0 section has no 'Changed meanings' subsection").toBeGreaterThan(0);
    const changedText = text.slice(at);
    const heads: string[] = [];
    for (const line of ENTRY!.changed) {
      const m = /^([A-Za-z_$][\w$.]*(?:\s*\/\s*[A-Za-z_$][\w$.]*)*)(?=[\s:'(])/.exec(line);
      if (!m) continue;
      for (const name of m[1].split("/").map((s) => s.trim())) {
        // An @api name is camelCase or dotted; a line opening with an English
        // word ("the @api pivot doors", "Paste, Cut + Paste") is matched by the
        // section's own prose, not here.
        if (/[a-z][A-Z]|\./.test(name)) heads.push(name);
      }
    }
    expect(heads.length, "too few 1.7.0 changed lines open with an @api name: the test proves little").toBeGreaterThanOrEqual(10);
    const absent = [...new Set(heads)].filter((name) => !changedText.includes("`" + name + "`"));
    expect(absent, "these names open a 1.7.0 'changed' line but the guide's Changed meanings never names them").toEqual([]);
  });
});

/**
 * The member names an exported interface declares itself (not those it
 * inherits), read from `declaredIn`: each `name:` / `name?:` at the body's top
 * level. Null when the file declares no such interface (a type alias).
 */
function interfaceMembers(declaredIn: string, name: string): string[] | null {
  const src = fs.readFileSync(path.resolve(__dirname, "../../..", declaredIn), "utf8").replace(/\r\n/g, "\n");
  const head = new RegExp(`export interface ${name}(?:\\s+extends[^{]*)?\\s*\\{`).exec(src);
  if (!head) return null;
  const members: string[] = [];
  let depth = 1;
  for (const line of src.slice(head.index + head[0].length).split("\n")) {
    // A doc comment's text ("`{ row, col }`") is neither a member nor a brace.
    if (/^\s*(?:\/\*|\*|\/\/)/.test(line)) continue;
    if (depth === 1) {
      const m = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*:/.exec(line);
      if (m) members.push(m[1]);
    }
    for (const ch of line.replace(/\/\/.*$/, "")) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    if (depth <= 0) break;
  }
  return members;
}
