//! FILENAME: app/src/api/__tests__/scriptPaneEditorDoc.test.ts
// PURPOSE: Keep the in-editor "Task pane (pane.*)" API list honest.
// CONTEXT: `getContextDocumentation("form")` is what a script author READS in
//          the Code tab before writing a line — for most of them it is the only
//          documentation they will ever open. It was hand-written when M2's
//          pane facet shipped and then went stale within the same day: three
//          fixers landed the reveal gesture window, the throttle ladder's
//          forced close and the dock `key` option, and none of them touched
//          this list, so it still promised a `placement` the dock never
//          resolves, a reveal with no conditions, and four close reasons out of
//          six. A wrong sentence there is a wrong promise, so it is pinned to
//          the code the same way the ALLOWLIST sentences are.
//
// THE DIRECTION IS CODE -> PROSE. Every expectation below is DERIVED — the
// facet's member list and the dock/reveal result shapes are parsed out of the
// worker shim, the numbers are imported from scriptPaneSpec, and the reason
// codes are read off that module's own union types. Nothing here restates a
// sentence, so the test cannot be "fixed" by editing it to match new prose.

import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

import { getContextDocumentation } from "../scriptableObjectScaffolds";
import {
  MAX_PANES_PER_SCRIPT,
  MAX_PANE_BADGE_CHARS,
  MAX_PANE_KEY_CHARS,
  PANE_DOCKS_PER_MINUTE,
  PANE_REVEALS_PER_MINUTE,
  PANE_REVEAL_GESTURE_WINDOW_MS,
  PANE_UPDATE_PER_SECOND,
} from "../scriptHost/scriptPaneSpec";

const API_DIR = join(__dirname, "..");
const SHIM_SRC = readFileSync(join(API_DIR, "scriptHost", "worker", "contextShims.ts"), "utf8");
const SPEC_SRC = readFileSync(join(API_DIR, "scriptHost", "scriptPaneSpec.ts"), "utf8");

// ---------------------------------------------------------------------------
// The list under test
// ---------------------------------------------------------------------------

const PANE_CATEGORY = "Task pane (pane.*)";

function paneRows(): Array<{ name: string; signature: string; description: string }> {
  const category = getContextDocumentation("form").find((c) => c.category === PANE_CATEGORY);
  if (!category) throw new Error(`the form context documentation has no "${PANE_CATEGORY}" category`);
  return category.methods;
}

function rowFor(member: string): { name: string; signature: string; description: string } {
  const row = paneRows().find((m) => m.name === `pane.${member}`);
  if (!row) throw new Error(`no editor row documents pane.${member}`);
  return row;
}

function describedAs(member: string): string {
  return rowFor(member).description;
}

/**
 * The comma-separated names inside the FIRST `{ ... }` of a string. Used on the
 * signature and on the description's result literals: every list this test
 * compares is parsed and matched as a SET, never searched for with `toContain`.
 * A bare substring search has no teeth on a short word — the first cut of this
 * file asked whether "key" appeared anywhere in the dock sentence, and deleting
 * the option from it still passed, because the same three letters stand in
 * "that key docked" further along.
 */
function bracedNames(text: string): string[] {
  const m = text.match(/\{([^}]*)\}/);
  if (!m) throw new Error(`no "{ ... }" list in: ${text}`);
  return m[1]
    .split(",")
    .map((f) => f.trim().split(":")[0].trim().replace(/\?$/, ""))
    .filter((f) => f.length > 0);
}

/**
 * The alternatives a prose `reason: a | b | c` (or `'a' | 'b'`) enumerates.
 * Parsed as a list and compared whole, for the reason `bracedNames` gives.
 */
function enumeratedReasons(text: string): string[] {
  const m = text.match(/reason:\s*([^},]*(?:\|[^},]*)*)/);
  if (!m) throw new Error(`no "reason: a | b" enumeration in: ${text}`);
  return m[1]
    .split("|")
    .map((f) => f.trim().replace(/^['"]|['"]$/g, ""))
    .filter((f) => f.length > 0);
}

// ---------------------------------------------------------------------------
// Reading the shim: what the facet ACTUALLY offers
// ---------------------------------------------------------------------------

/** Slice from `open` (inclusive) to the brace that closes the object it opens. */
function braceBlock(src: string, open: string): string {
  const start = src.indexOf(open);
  if (start < 0) throw new Error(`contextShims.ts no longer contains "${open}"`);
  let depth = 0;
  for (let i = start + open.length - 1; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces after "${open}" in contextShims.ts`);
}

const PANE_FACET_SRC = braceBlock(SHIM_SRC, "const paneFacet = {");

/** Members declared at one indentation level of an object literal. */
function membersAtIndent(src: string, indent: number): string[] {
  const re = new RegExp(`^ {${indent}}(?:async |get )?([A-Za-z_$][\\w$]*)\\s*[:(]`, "gm");
  const out = new Set<string>();
  for (const m of src.matchAll(re)) out.add(m[1]);
  return [...out];
}

/** The field names of a `Promise<{ ... }>` return annotation on a facet method. */
function resolvedFields(method: string): string[] {
  const re = new RegExp(`async ${method}\\([^)]*\\):\\s*Promise<\\{([^}]*)\\}>`);
  const m = PANE_FACET_SRC.match(re);
  if (!m) throw new Error(`the shim's pane facet no longer declares an async ${method} returning an object`);
  return m[1]
    .split(";")
    .map((f) => f.trim().replace(/\?$/, "").split(":")[0].trim())
    .filter((f) => f.length > 0);
}

/** The option names `dock` accepts, off its own parameter annotation. */
function dockOptionNames(): string[] {
  const m = PANE_FACET_SRC.match(/async dock\(options\?:\s*\{([^}]*)\}\)/);
  if (!m) throw new Error("the shim's pane facet no longer declares dock(options?: { ... })");
  return m[1]
    .split(";")
    .map((f) => f.trim().replace(/\?.*$/, "").trim())
    .filter((f) => f.length > 0);
}

/** A union type's string members, read off scriptPaneSpec.ts. */
function unionMembers(alias: string): string[] {
  const m = SPEC_SRC.match(new RegExp(`export type ${alias} =([^;]*);`));
  if (!m) throw new Error(`scriptPaneSpec.ts no longer declares "export type ${alias}"`);
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

// ---------------------------------------------------------------------------

describe("the in-editor task-pane API list matches the pane facet", () => {
  it("documents exactly the members the shim exposes — no more, no fewer", () => {
    const documented = paneRows()
      .map((m) => m.name)
      .map((n) => n.replace(/^pane\./, ""))
      .sort();
    expect(documented).toEqual(membersAtIndent(PANE_FACET_SRC, 8).sort());
  });

  it("lists exactly the methods of the control handle, focus included", () => {
    const controlSrc = braceBlock(PANE_FACET_SRC, "control(name: string) {");
    const handleSrc = braceBlock(controlSrc, "return {");
    const listed = describedAs("control")
      .split(":")[1]
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    expect(listed.sort()).toEqual(membersAtIndent(handleSrc, 12).sort());
  });
});

describe("pane.dock promises what dock() resolves", () => {
  it("names the resolved fields and claims no others", () => {
    const resolved = resolvedFields("dock");
    expect(resolved).toContain("paneId");
    const promised = bracedNames(describedAs("dock").slice(describedAs("dock").indexOf("resolves ")));
    expect(promised).toEqual(resolved);
  });

  it("spells out exactly the options dock accepts, the `key` one included", () => {
    expect(bracedNames(rowFor("dock").signature).sort()).toEqual(dockOptionNames().sort());
  });

  it("states the per-script cap, the dock bucket and the key's length bound", () => {
    const desc = describedAs("dock");
    expect(desc).toMatch(new RegExp(`\\b${MAX_PANES_PER_SCRIPT} open panes\\b`));
    expect(desc).toMatch(new RegExp(`\\b${PANE_DOCKS_PER_MINUTE} docks a minute\\b`));
    expect(desc).toMatch(new RegExp(`\\b1-${MAX_PANE_KEY_CHARS} characters\\b`));
  });

  it("says that docking is not the same as taking the screen, and states the window it depends on", () => {
    // A dock outside the gesture window registers the pane without opening it.
    // An author who read only "opens the pane" would write the next line —
    // progress, a focus call — believing the user is looking at it.
    const desc = describedAs("dock");
    expect(desc).toMatch(new RegExp(`\\b${PANE_REVEAL_GESTURE_WINDOW_MS / 1000} s of a user gesture\\b`));
  });
});

describe("pane.reveal states the conditions the host actually applies", () => {
  it("enumerates exactly the refusal codes a script can branch on", () => {
    const enumerated = enumeratedReasons(describedAs("reveal")).sort();
    expect(enumerated).toEqual(unionMembers("PaneRevealRefusalReason").sort());
  });

  it("states the gesture window and the reveal bucket", () => {
    const desc = describedAs("reveal");
    expect(desc).toMatch(new RegExp(`\\b${PANE_REVEAL_GESTURE_WINDOW_MS / 1000} s of a user gesture\\b`));
    expect(desc).toMatch(new RegExp(`\\b${PANE_REVEALS_PER_MINUTE} times a minute\\b`));
  });
});

describe("pane.onClose lists every reason a pane can come down", () => {
  it("enumerates all six, the throttle ladder's forced close included", () => {
    const enumerated = enumeratedReasons(describedAs("onClose")).sort();
    expect(enumerated).toEqual(unionMembers("PaneCloseReason").sort());
  });
});

describe("the pane's rate and size bounds are stated where they bind", () => {
  it("pane.update states its per-second budget", () => {
    expect(describedAs("update")).toMatch(new RegExp(`\\b${PANE_UPDATE_PER_SECOND} per second\\b`));
  });

  it("pane.setBadge states its character bound", () => {
    expect(describedAs("setBadge")).toMatch(new RegExp(`\\bup to ${MAX_PANE_BADGE_CHARS} characters\\b`));
  });
});
