// FILENAME: app/extensions/CommandLine/cli/macroProvenance.ts
// PURPOSE: The CLI's view of WHOSE CODE a macro is. One place that turns a
//          stored module record into a `MacroEntry` carrying a DERIVED
//          `MountOrigin`, plus the three spellings the panel shows: the short
//          column label for `ls macros` / `show macro`, the sentence the `run`
//          verb prints before it hands control to somebody else's code, and the
//          phrase it appends to the outcome.
//
// WHY THE CLI NEEDS ITS OWN ANSWER AT ALL. `list_scripts` (the backend call
// behind `@api/workbookScripts.listWorkbookScripts`) returns id + name + scope
// and DROPS `source_package` — the field `core/calp/src/pull.rs` stamps on every
// module it materializes out of a `.calp`. The CLI listed macros from that call,
// so a publisher's module and the user's own were rendered identically, and
// `run` executed one without ever saying where it came from. The command line is
// the power surface: the user typing `run` there is precisely the user who has
// to be told they are about to run code that arrived inside an application.
//
// SO THE LISTING MOVED DOORS. `listWorkbookScriptRecords` resolves each summary
// through `get_script`, which DOES return `sourcePackage`. It costs one extra
// IPC round trip per module — paid once per `ls`/`run`, over a workbook's
// handful of macros — and it is the only @api door that can answer the question
// truthfully. A cheaper listing that cannot see provenance is not cheaper, it is
// wrong.
//
// THE ORIGIN IS DERIVED, NEVER ASSERTED. `scriptOriginForStoredRecord` is the
// single function that reads a record's `sourcePackage` into a `MountOrigin`
// (app/src/api/scriptHost/scriptOrigin.ts). Nothing here inspects the package
// NAME to decide a kind — a publisher who names their application `local` still
// gets `kind: "package"`, because the name only ever lands in `.name`.
//
// AN UNREADABLE RECORD IS NOT A LOCAL ONE. `listWorkbookScriptRecords` reports a
// per-record read failure by returning the summary with `sourcePackage: null`,
// which `scriptOriginForStoredRecord` reads — correctly, for its own contract —
// as local. That default is a fail-OPEN provenance claim: an unreadable module
// would be labelled the user's own code. Every display path here therefore
// checks `loadError` FIRST and says the origin is unknown, which is the honest
// answer and the one that makes the user look before they type `run`.

import {
  isLocalOrigin,
  originTagLabel,
  scriptOriginForStoredRecord,
} from "@api/scriptHost/scriptOrigin";
import type { MountOrigin } from "@api/scriptHost/scriptOrigin";
import type { ScriptScope, WorkbookScriptRecord } from "@api/workbookScripts";

/**
 * One macro as the CLI lists, completes and runs it: identity, scope, the
 * origin derived from its own record, and the read failure when there was one.
 */
export interface MacroEntry {
  id: string;
  name: string;
  scope?: ScriptScope;
  /** DERIVED from the record's `sourcePackage`. Meaningless when `loadError`
   *  is set — use the helpers below, never `origin` directly, to display it. */
  origin: MountOrigin;
  /** Why the record could not be read, when it could not; null otherwise. */
  loadError: string | null;
}

/** What the `from` column shows when the record could not be read at all. */
export const UNKNOWN_ORIGIN_LABEL = "(unreadable)";

/** Turn the inventory's records into the CLI's entries, deriving each origin. */
export function macroEntriesFrom(records: WorkbookScriptRecord[]): MacroEntry[] {
  return records.map((record) => ({
    id: record.id,
    name: record.name,
    scope: record.scope,
    origin: scriptOriginForStoredRecord(record),
    loadError: record.loadError,
  }));
}

/**
 * The short `from` cell: `local`, the application's name, or `(unreadable)`.
 * Never empty — `detailBlock` drops empty values, and a macro with no visible
 * provenance row is exactly the listing this module exists to replace.
 */
export function macroOriginLabel(entry: MacroEntry): string {
  return entry.loadError === null ? originTagLabel(entry.origin) : UNKNOWN_ORIGIN_LABEL;
}

/** The phrase appended to a run outcome: reads inside `(...)` in a sentence. */
export function macroOriginPhrase(entry: MacroEntry): string {
  if (entry.loadError !== null) return "origin unknown";
  return isLocalOrigin(entry.origin)
    ? "local"
    : `from application "${entry.origin.name}"`;
}

/**
 * The line `run` prints BEFORE it hands control over, or null when the macro is
 * the user's own code and there is nothing to disclose.
 *
 * This is DISCLOSURE, not the consent gate. The gate is Rust-authoritative and
 * sits under the run itself (`require_distributed_module_consent`,
 * app/src-tauri/src/scripting/commands.rs, for the module-runtime route; the
 * artifact-derived tier cap in `runObjectScriptOnce` for the object-script
 * route). Printing here does not authorise anything — it tells the user whose
 * code is about to run, which the CLI previously never did.
 */
export function macroProvenanceNotice(entry: MacroEntry): string | null {
  if (entry.loadError !== null) {
    return (
      `'${entry.name}' could not be read (${entry.loadError}), so there is no way to ` +
      "tell whether this is your code or an application's."
    );
  }
  if (isLocalOrigin(entry.origin)) return null;
  return (
    `'${entry.name}' arrived in the application "${entry.origin.name}" — this is the ` +
    "publisher's code, not yours. It runs sandboxed at the restricted tier, and only " +
    "if you have approved that application's code."
  );
}

/** Completion detail for a macro name: its id, plus the origin when it is not
 *  the user's own (a local macro's origin is the unremarkable case). */
export function macroSuggestionDetail(entry: MacroEntry): string {
  const label = macroOriginLabel(entry);
  return label === "local" ? entry.id : `${entry.id} · ${label}`;
}
