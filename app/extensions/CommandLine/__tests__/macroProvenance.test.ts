// FILENAME: app/extensions/CommandLine/__tests__/macroProvenance.test.ts
// PURPOSE: The CLI's provenance derivation, at the unit level: an origin is read
//          out of the record's own `sourcePackage` and NEVER out of a name, an
//          unreadable record is not silently promoted to "local", and the
//          gateway keeps exactly one macro-listing door — one that carries
//          provenance.
// CONTEXT: The panel-level behaviour (the `from` column, the pre-run notice, the
//          outcome phrasing) is pinned in appCli.test.ts, through the real CLI
//          engine. This file pins the rules those texts rest on.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  UNKNOWN_ORIGIN_LABEL,
  macroEntriesFrom,
  macroOriginLabel,
  macroOriginPhrase,
  macroProvenanceNotice,
  macroSuggestionDetail,
} from "../cli/macroProvenance";
import type { WorkbookScriptRecord } from "@api/workbookScripts";

function record(over: Partial<WorkbookScriptRecord>): WorkbookScriptRecord {
  return {
    id: "m1",
    name: "Macro",
    description: null,
    source: "",
    sourcePackage: null,
    loadError: null,
    ...over,
  };
}

const entryOf = (over: Partial<WorkbookScriptRecord>) => macroEntriesFrom([record(over)])[0];

describe("macroEntriesFrom", () => {
  it("derives a package origin from sourcePackage", () => {
    const entry = entryOf({ sourcePackage: "Q3 Report" });
    expect(entry.origin).toEqual({ kind: "package", name: "Q3 Report" });
  });

  it("treats an ABSENT stamp as the user's own code, and a blank one as a nameless publisher's", () => {
    expect(entryOf({ sourcePackage: null }).origin.kind).toBe("local");
    // A present-but-blank stamp is what Rust's gate reads as `Some("   ")` —
    // distributed. The derivation now agrees (scriptOriginForStoredRecord).
    const blank = entryOf({ sourcePackage: "   " });
    expect(blank.origin).toEqual({ kind: "package", name: "(unknown package)" });
    expect(macroOriginLabel(blank)).toBe("(unknown package)");
  });

  it("cannot be talked into 'local' by an application NAMED local", () => {
    // The whole reason ScriptOrigin is a union: the publisher chooses the name,
    // and the name must never be able to select the kind.
    const entry = entryOf({ sourcePackage: "local" });
    expect(entry.origin.kind).toBe("package");
    expect(macroOriginPhrase(entry)).toBe('from application "local"');
    expect(macroProvenanceNotice(entry)).toContain("publisher's code");
  });

  it("carries scope and the read failure through unchanged", () => {
    const entry = entryOf({ scope: { type: "sheet", name: "Sheet2" }, loadError: "gone" });
    expect(entry.scope).toEqual({ type: "sheet", name: "Sheet2" });
    expect(entry.loadError).toBe("gone");
  });

  it("accepts a SUMMARY row — no source, no loadError — and derives the same origin", () => {
    // The gateway lists through `listWorkbookScripts()` (one round trip), whose
    // rows carry `sourcePackage` but neither `source` nor `loadError`. Nothing
    // was read that could fail, so the entry is complete with `loadError: null`.
    const [theirs, mine] = macroEntriesFrom([
      { id: "macro-remit", name: "Remit", scope: { type: "workbook" }, sourcePackage: "Q3 Report" },
      { id: "macro-hello", name: "Hello" },
    ]);
    expect(theirs.origin).toEqual({ kind: "package", name: "Q3 Report" });
    expect(theirs.loadError).toBeNull();
    expect(theirs.scope).toEqual({ type: "workbook" });
    expect(mine.origin).toEqual({ kind: "local" });
    expect(mine.loadError).toBeNull();
    expect(macroOriginLabel(theirs)).toBe("Q3 Report");
  });
});

describe("an unreadable record is not a local one", () => {
  // listWorkbookScriptRecords reports a per-record read failure by returning the
  // summary with sourcePackage null. Reading that at face value would label a
  // module the app could not even open as the user's own code.
  const broken = entryOf({ name: "Broken", loadError: "record corrupt" });

  it("labels it unknown rather than local", () => {
    expect(macroOriginLabel(broken)).toBe(UNKNOWN_ORIGIN_LABEL);
    expect(macroOriginLabel(broken)).not.toBe("local");
    expect(macroOriginPhrase(broken)).toBe("origin unknown");
  });

  it("still discloses something before a run", () => {
    const notice = macroProvenanceNotice(broken);
    expect(notice).not.toBeNull();
    expect(notice).toContain("record corrupt");
  });
});

describe("display helpers", () => {
  it("says 'local' for the user's own macro and stays silent before a run", () => {
    const mine = entryOf({ name: "Hello" });
    expect(macroOriginLabel(mine)).toBe("local");
    expect(macroOriginPhrase(mine)).toBe("local");
    expect(macroProvenanceNotice(mine)).toBeNull();
  });

  it("names the application in the short label and the completion detail", () => {
    const theirs = entryOf({ id: "macro-remit", name: "Remit", sourcePackage: "Q3 Report" });
    expect(macroOriginLabel(theirs)).toBe("Q3 Report");
    expect(macroSuggestionDetail(theirs)).toBe("macro-remit · Q3 Report");
  });

  it("leaves a local macro's completion detail as the bare id", () => {
    expect(macroSuggestionDetail(entryOf({ id: "macro-hello" }))).toBe("macro-hello");
  });
});

describe("the gateway keeps exactly one macro-listing door", () => {
  // Comments stripped: the gateway's prose names the doors it deliberately
  // does NOT use, and a guard that matched prose would forbid explaining why.
  const gatewaySource = readFileSync(join(__dirname, "..", "cli", "appGateway.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  it("lists through the one-round-trip summary listing, whose rows carry sourcePackage", () => {
    // `list_scripts` copies `source_package` onto every row (`script_summary`,
    // app/src-tauri/src/scripting/commands.rs). The gateway once listed through
    // the full record inventory instead — one `get_script` per module on every
    // `ls`, `run` and session refresh, to fetch bodies the CLI never shows.
    expect(gatewaySource).toMatch(/macroEntriesFrom\(await listWorkbookScripts\(\)\)/);
  });

  it("does not pay a per-record fetch for a listing that needs no source", () => {
    expect(gatewaySource).not.toContain("listWorkbookScriptRecords");
    expect(gatewaySource).not.toContain("getWorkbookScript");
  });

  it("derives the origin on the way through, never hands a raw row out", () => {
    // The interface's one macro door returns `MacroEntry[]` — rows with a
    // DERIVED `origin`. A method returning `ScriptSummary[]` would be a door a
    // surface could list a publisher's module through by name alone.
    expect(gatewaySource).toMatch(/listMacros\(\): Promise<MacroEntry\[\]>;/);
    expect(gatewaySource).not.toMatch(/Promise<ScriptSummary\[\]>/);
  });
});
