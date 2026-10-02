//! FILENAME: app/extensions/Controls/__tests__/objectInsertDoorCensus.test.ts
// PURPOSE: WHICH doors ask as the door kind "objectInsert" (owner call 25).
//          The generic "an object is selected" claim (BUG-0270) ADMITS that
//          kind, so a door that asks as it is let through while an object is
//          selected -- and `SelectionDoorKind` is exported through
//          @api/selectionOwner, so ANY door can ask as it. Only the three
//          Insert-menu control doors (Button, Shape, Image) are meant to:
//          they place a NEW object at the active cell, as Excel does. Every
//          other door must still refuse. A review sabotage (RV1) made Insert
//          Table ask as one -- with an object selected, Ctrl+T then opened
//          Create Table prefilled from the HIDDEN cell selection -- and 190
//          test files stayed green. This census is the guard:
//            1. the token `objectInsert` appears only where the kind is
//               declared, documented, admitted and used;
//            2. no call outside the seam and the Controls helper hands the
//               seam a door kind at all (a variable or a cast spells no
//               token, so check 1 alone cannot see it);
//            3. the two Controls helpers that ask as the kind are called only
//               by Controls, and only as the three insert doors.
//          Comment lines are not calls; tests are not product code.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const APP = path.resolve(__dirname, "../../..");
const ROOTS = ["src", "extensions"];

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "__tests__") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
}

/** Every non-test .ts/.tsx under app/src and app/extensions, as app-relative "/" paths with their text. */
const SOURCES: ReadonlyArray<{ rel: string; text: string }> = (() => {
  const files: string[] = [];
  for (const root of ROOTS) walk(path.join(APP, root), files);
  return files.map((f) => ({ rel: path.relative(APP, f).split(path.sep).join("/"), text: fs.readFileSync(f, "utf8") }));
})();

/** True when the match at `index` sits on a comment line (after `//`, or a ` * ` block-comment line). */
function onCommentLine(text: string, index: number): boolean {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  const prefix = text.slice(lineStart, index);
  return prefix.includes("//") || /^\s*(\*|\/\*)/.test(prefix);
}

/**
 * The top-level arguments of the call whose `(` is at `open`, as trimmed raw
 * text (empty trailing arguments dropped). Strings, templates and nested
 * brackets are skipped whole.
 */
function callArguments(text: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < text.length && text[i] !== c) {
        if (text[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) {
        args.push(text.slice(start, i).trim());
        break;
      }
    } else if (c === "," && depth === 1) {
      args.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  return args.filter((a) => a.length > 0);
}

/** Every CALL of `name(` outside comment lines and its own `function` declaration. */
function callsOf(name: string): Array<{ rel: string; line: number; args: string[] }> {
  const found: Array<{ rel: string; line: number; args: string[] }> = [];
  const pattern = new RegExp(`\\b${name}\\s*(?:<[^>()]*>)?\\(`, "g");
  for (const { rel, text } of SOURCES) {
    for (const m of text.matchAll(pattern)) {
      const at = m.index ?? 0;
      if (onCommentLine(text, at)) continue;
      if (/function\s+$/.test(text.slice(Math.max(0, at - 20), at))) continue;
      const open = at + m[0].length - 1;
      found.push({ rel, line: text.slice(0, at).split("\n").length, args: callArguments(text, open) });
    }
  }
  return found;
}

/** The only product files that may spell the door kind, and why. */
const SPELLS_THE_KIND: Readonly<Record<string, string>> = {
  "src/core/lib/selectionOwner.ts": "declares SelectionDoorKind and documents it",
  "src/api/selectionOwner.ts": "re-exports the seam and documents the kind",
  "src/api/version.ts": "the API changelog names the kind",
  "extensions/BuiltIn/ObjectPosition/lib/selectedObjectKeys.ts": "the 'an object is selected' claim admits it",
  "extensions/Controls/lib/insertAnchor.ts": "the one helper the three insert doors ask through",
};

/** The only product files that may hand the seam a door kind. */
const PASSES_A_KIND = new Set(["src/core/lib/selectionOwner.ts", "extensions/Controls/lib/insertAnchor.ts"]);

/** The three doors -- and the only door names -- the Controls helpers may be called as. */
const INSERT_DOORS = ['"Insert Button"', '"Insert Shape"', '"Insert Image"'];

describe("the objectInsert door census (owner call 25)", () => {
  it("reads the whole product tree (positive control)", () => {
    expect(SOURCES.length, "the walk found too few files to be a census").toBeGreaterThan(1000);
    expect(SOURCES.some((s) => s.rel === "extensions/BuiltIn/StandardMenus/selectionDoors.ts")).toBe(true);
    expect(SOURCES.some((s) => s.rel.includes("__tests__") || /\.test\.tsx?$/.test(s.rel))).toBe(false);
  });

  it("only the files that declare, document, admit and use the kind spell `objectInsert`", () => {
    const spelled = SOURCES.filter((s) => /\bobjectInsert\b/.test(s.text)).map((s) => s.rel);
    const strangers = spelled.filter((rel) => !(rel in SPELLS_THE_KIND));
    expect(
      strangers,
      'a door outside the census spells "objectInsert" -- with an object selected it would be let through ' +
        "where it must refuse; only the three Insert-menu control doors may ask as it (through Controls/lib/insertAnchor.ts)",
    ).toEqual([]);
    // Every listed file still spells it, so the list never vouches for a file it no longer describes.
    expect([...spelled].sort()).toEqual(Object.keys(SPELLS_THE_KIND).sort());
  });

  it("no call outside the seam and the Controls helper hands the seam a door kind", () => {
    const withKind = [
      ...callsOf("refuseIfSelectionOwned").filter((c) => c.args.length >= 2),
      ...callsOf("selectionRefusalFor").filter((c) => c.args.length >= 2),
      ...callsOf("getSelectionOwner").filter((c) => c.args.length >= 1),
    ];
    // Positive control: the helper's own call is seen, with its kind.
    expect(
      withKind.some((c) => c.rel === "extensions/Controls/lib/insertAnchor.ts" && c.args[1] === "OBJECT_INSERT"),
      "the scanner no longer sees insertAnchor.ts asking as OBJECT_INSERT",
    ).toBe(true);
    // ...and an ordinary door is seen asking WITHOUT one.
    expect(
      callsOf("refuseIfSelectionOwned").some(
        (c) => c.rel === "extensions/BuiltIn/StandardMenus/selectionDoors.ts" && c.args.length === 1,
      ),
    ).toBe(true);
    const strangers = withKind
      .filter((c) => !PASSES_A_KIND.has(c.rel))
      .map((c) => `${c.rel}:${c.line} (${c.args.join(", ")})`);
    expect(
      strangers,
      "a door hands the seam a door kind; the only kind admits it past the 'an object is selected' claim",
    ).toEqual([]);
  });

  it("the Controls helpers are called only by Controls, and only as Insert Button / Shape / Image", () => {
    // insertAnchor.ts's own `insertAnchorOrRefuse` asks through its sibling with
    // the label it was handed; that is the helper, not a door.
    const calls = [...callsOf("insertAnchorOrRefuse"), ...callsOf("refuseObjectInsertIfSelectionOwned")].filter(
      (c) => c.rel !== "extensions/Controls/lib/insertAnchor.ts",
    );
    const strangers = calls
      .filter((c) => !c.rel.startsWith("extensions/Controls/") || !INSERT_DOORS.includes(c.args[0] ?? ""))
      .map((c) => `${c.rel}:${c.line} (${c.args[0] ?? ""})`);
    expect(strangers, "a door other than the three object inserts asks through the objectInsert helper").toEqual([]);
    // Positive control: each of the three doors is seen asking.
    for (const door of INSERT_DOORS) {
      expect(
        calls.some((c) => c.rel === "extensions/Controls/index.ts" && c.args[0] === door),
        `${door} no longer asks through the helper`,
      ).toBe(true);
    }
  });
});
