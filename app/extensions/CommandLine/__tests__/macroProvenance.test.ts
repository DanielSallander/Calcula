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

  it("treats an absent or whitespace-only stamp as the user's own code", () => {
    expect(entryOf({ sourcePackage: null }).origin.kind).toBe("local");
    expect(entryOf({ sourcePackage: "   " }).origin.kind).toBe("local");
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
  const gatewaySource = readFileSync(
    join(__dirname, "..", "cli", "appGateway.ts"),
    "utf8",
  );

  it("lists through the RECORD inventory, which is the only call that returns sourcePackage", () => {
    expect(gatewaySource).toContain("listWorkbookScriptRecords");
  });

  it("exposes no origin-less summary listing to re-open the hole", () => {
    // `list_scripts` drops source_package. A gateway method returning its
    // summaries is a door a surface can list a publisher's module through as if
    // it were the user's own — which is what `ls macros` and `run` did.
    expect(gatewaySource).not.toMatch(/\blistWorkbookScripts\b(?!Records)/);
  });
});
