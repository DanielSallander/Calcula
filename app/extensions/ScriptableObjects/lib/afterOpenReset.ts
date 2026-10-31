//! FILENAME: app/extensions/ScriptableObjects/lib/afterOpenReset.ts
// PURPOSE: Which workbook reset an AFTER_OPEN announcement asks for.
// CONTEXT: AFTER_OPEN has two emitters. File > Open (core/lib/file-api.ts,
//          `{ path }`) REPLACES the document, and open_file has already set
//          the calculation mode the opened file was saved under -- so a
//          script's manual-calculation debt is forgotten, never paid over that
//          mode (rev12B, round 13). Collaboration > Open Application for
//          Editing (api/collaboration.ts, `{ path: "", source: "checkout" }`)
//          APPENDS the application's sheets to the SAME live workbook and sets
//          no calculation mode ("an install never changes the subscriber's
//          mode"): the scripts are still remounted, so the debt of the script
//          that is going must be PAID -- automatic restored -- or the workbook
//          stays in manual calculation with stale values after the script that
//          asked for it is gone (rev14C, round 16).

/** The options `resetObjectScriptManager` takes for this AFTER_OPEN. */
export function resetOptionsForAfterOpen(payload: unknown): { openedDocument?: boolean } {
  const p = (payload ?? {}) as { path?: unknown; source?: unknown };
  const replacedTheDocument = p.source !== "checkout" && typeof p.path === "string" && p.path !== "";
  return replacedTheDocument ? { openedDocument: true } : {};
}
