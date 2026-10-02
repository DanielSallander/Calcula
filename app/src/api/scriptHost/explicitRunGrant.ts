//! FILENAME: app/src/api/scriptHost/explicitRunGrant.ts
// PURPOSE: WHAT an application's macro may reach when a PERSON runs it (owner
//          decision B, 2026-09-30) -- the cell access, as a closed table of
//          broker methods, plus the sentences that refuse everything else.
// CONTEXT: The owner's rule: "An APPROVED application macro that the user runs
//          EXPLICITLY -- a button click, Developer > Macros > Run, the command
//          line -- gets the same CELL access in either runtime (the module
//          runtime, Calcula.setCellValue, already has it after approval).
//          Standing object scripts, and any run a script starts on its own, stay
//          restricted."
//
// A NARROW GRANT, NOT A TIER. Such a run keeps the RESTRICTED tier and the
// application's origin: no just-in-time capability prompt, capabilities only
// through the application's consent record, and every tier check in the host
// (the sheet.* clamps, form and pane bindings, same-origin trust, the stamp the
// pull writes) behaves exactly as for any restricted realm. What changes is one
// flag on the script's host-side identity (`ScriptHandle.explicitRun.cells`),
// read in three places: the broker's decision (`brokerPolicy.decidePolicy`,
// which admits the rows below and nothing else from the unlocked tier, and
// REFUSES the few restricted rows listed further down), the fill
// (`fillRangeFromScript`, held to its module twin), and the worker shim
// (`context.api` exists, so a recorded macro runs unchanged). The host sets the
// flag only after every mount gate admitted the run, and turns it off the
// moment the macro's setup settles (scriptHost/host.ts).
//
// "THE SAME CELL ACCESS", MEASURED. The module runtime's reach after approval is
// its manifest (core/script-engine/src/manifest.rs, the one-off profile): cells
// on any sheet (Calcula.getCellValue / getCellFormula / getRange / setCellValue
// / setRange / fillDown / fillRight / getUsedRange / getCurrentRegion /
// getRangeEdge), sheet names and the active sheet, calculation, plus view,
// bookmark and metadata reads -- and no formatting API beyond applying an
// existing named style (which this grant does NOT take: the owner's words are a
// ceiling), no structure, no files, no network, no events, no commands and no
// other macros. The worker's unlocked
// `context.api` is far wider (files, protection, formatting including the
// `locked` flag, structure, objects, commands, events, runMacro, application
// publishing). Every row below has a module-runtime twin; everything else is
// excluded, and the exclusions are listed with their reasons in
// docs/design/wave3-scripting-security.md section 11.
//
// PURE: imports only the policy table, because `brokerPolicy.ts` imports this
// and is shared with the Node preview harness, which has no Tauri.

import { ALLOWLIST } from "./allowlist";

/**
 * The unlocked-tier broker rows an explicit run of an approved application
 * macro may call. EXACTLY these; adding one is a decision (the test pins the
 * set). None carries a capability.
 */
export const EXPLICIT_RUN_CELL_METHODS: ReadonlySet<string> = new Set<string>([
  // ---- READS (cells on any sheet) ----
  "api.getCellValue", //     Calcula.getCellValue
  "api.getCellData", //      Calcula.getCellValue + Calcula.getCellFormula
  "api.getRangeValues", //   Calcula.getRange
  "api.getCellFormula", //   Calcula.getCellFormula
  "api.getUsedRange", //     Calcula.getUsedRange
  "api.getCurrentRegion", // Calcula.getCurrentRegion
  "api.getRangeEdge", //     Calcula.getRangeEdge
  "api.getSheetNames", //    Calcula.getSheetNames
  "api.getSheets", //        Calcula.getSheetNames / getSheetVisibility / workbook.sheets
  "api.getActiveSheet", //   Calcula.getActiveSheet
  // ---- WRITES (cell content; the backend's protection, writeback-draft and
  //      canvas refusals apply exactly as they do to every write) ----
  "api.setCellValue", //     Calcula.setCellValue (any sheet)
  "api.updateCellsBatch", // Calcula.setRange
  "api.setCellFormula", //   Calcula.setCellValue("=...")
  "api.fillRange", //        Calcula.fillDown / fillRight (writes only cells inside the named rectangle)
  // ---- ADDRESSING ----
  "api.setActiveSheet", //   Calcula.setActiveSheet (the recorder's first statement)
  // ---- CALCULATION ----
  "api.recalculate", //      Calcula.application.calculate
  "api.getCalculationMode", // Calcula.application.calculationMode
  // ---- THE UNDO BRACKET (a module run is one transaction; the one-off runner
  //      closes a batch the run left open, so it cannot leak past the run) ----
  "api.beginBatch",
  "api.commitBatch",
  "api.cancelBatch",
]);

/**
 * Restricted-tier rows a run-only realm may not use, because they connect it to
 * OTHER code while it holds cell access. Two lead in -- an exposed method or an
 * event subscription would let other code call into the realm and borrow the
 * access -- and one leads out: `base.callMethod` would hand what the run read
 * from any sheet straight to another script's exposed method, and a standing
 * script of the same application needs no `public` flag to be called (R7
 * same-origin trust) and may hold a consented capability such as `net.fetch`.
 * The module runtime has no channel to other scripts at all.
 */
export const RUN_ONLY_REFUSED_METHODS: ReadonlySet<string> = new Set<string>([
  "base.expose",
  "events.subscribe",
  "base.callMethod",
]);

/**
 * Restricted-tier FORMATTING rows a granted realm may not use. Every restricted
 * `sheet.*` row is clamped to the LIVE active sheet (host.ts `clampSheetIndex`),
 * and the grant includes `api.setActiveSheet` -- so together they would let a
 * granted run format, or strip the formatting of, every sheet in turn. That is
 * not cell access, and it is not something any restricted realm can do on its
 * own (only the user moves the sheet on screen). Refused for the realm's whole
 * life, like the run-only rows. Nothing a macro written through the shim loses:
 * a workbook-context realm has no `context.sheet` object, and the recorder
 * formats through `api.setRangeFormat`, which the grant already excludes. The
 * format READS stay admitted: they disclose less than the value reads the grant
 * already gives on every sheet.
 */
export const EXPLICIT_RUN_REFUSED_FORMAT_METHODS: ReadonlySet<string> = new Set<string>([
  "sheet.setRangeFormat",
  "sheet.clearRangeFormat",
]);

/** The part of a script's identity the grant reads. */
export interface ExplicitRunIdentity {
  explicitRun?: { readonly cells: boolean };
}

/**
 * Whether the explicit-run grant admits `method` for this identity: the grant
 * is live (`cells === true`), the method is one of the rows above, and it
 * carries no capability (a capability comes only through consent, never
 * through a grant).
 */
export function explicitRunAdmits(identity: ExplicitRunIdentity, method: string): boolean {
  return (
    identity.explicitRun?.cells === true &&
    EXPLICIT_RUN_CELL_METHODS.has(method) &&
    !ALLOWLIST[method]?.capability
  );
}

/** The refusal for an unlocked-tier method outside the grant. */
export function explicitRunRefusalMessage(method: string): string {
  return (
    `${method} is not part of the cell access an application's macro gets when you run ` +
    "it yourself. It may read and change cell values and formulas on any sheet, switch " +
    "sheets, recalculate and group its changes into one undo step -- nothing else that " +
    "needs the unlocked tier."
  );
}

/**
 * The refusal for a hook, an exposed method or an event subscription -- and,
 * in the other direction, for calling another script's exposed method.
 */
export function runOnlyRefusalMessage(method: string): string {
  if (method === "base.callMethod") {
    return (
      `${method}: an application's macro that you run gets cell access only for itself, ` +
      "so it cannot call into another script's exposed methods and hand on what it read."
    );
  }
  return (
    `${method}: an application's macro that you run gets cell access only while it runs, ` +
    "so it cannot leave handlers or exposed methods behind for other code to call."
  );
}

/** The refusal for a formatting row (EXPLICIT_RUN_REFUSED_FORMAT_METHODS). */
export function explicitRunFormatRefusalMessage(method: string): string {
  return (
    `${method}: an application's macro that you run gets cell access, not formatting. ` +
    "It may read and change cell values and formulas on any sheet, but not how cells look."
  );
}

/**
 * The refusal a realm carrying the explicit-run grant gets for a RESTRICTED-tier
 * row -- a run-only row or a formatting row -- or null when the row is admitted
 * exactly as for any restricted realm. Applies for the realm's whole life, also
 * after `cells` expired.
 */
export function explicitRunRestrictedRefusal(method: string): string | null {
  if (RUN_ONLY_REFUSED_METHODS.has(method)) return runOnlyRefusalMessage(method);
  if (EXPLICIT_RUN_REFUSED_FORMAT_METHODS.has(method)) return explicitRunFormatRefusalMessage(method);
  return null;
}

/**
 * THE PRE-FLIGHT: the `api.<name>(` calls in `source` that are unlocked-tier
 * broker rows OUTSIDE the grant, plus `base.callMethod` for a `callMethod(`
 * call (the one run-only refusal a macro's `context` can spell; the formatting
 * rows have no spelling in a workbook-context realm) -- unique and sorted,
 * empty when the macro stays within cell access.
 *
 * Run BEFORE anything is mounted, so a recorded macro that also formats, sorts
 * or inserts is refused up front with those calls named, instead of writing
 * half its cells and then failing at the broker. It reads text, so it cannot
 * see a method reached dynamically (`api[name]()`) or through the object model
 * (`api.workbook.save()`), and a comment stripper this naive can miss a call
 * inside a string that contains `//`: every one of those is a false NEGATIVE,
 * which the broker still refuses when the call is made. The opposite slip -- a
 * call NAMED inside a string literal -- is read as a call and refuses a macro
 * that would not have made it, which is the safe direction. It can never ADMIT
 * anything -- the broker is the authority.
 */
export function ungrantedApiCalls(source: string): string[] {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const found = new Set<string>();
  const pattern = /\bapi\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const method = `api.${match[1]}`;
    const policy = ALLOWLIST[method];
    if (policy && policy.tier === "unlocked" && !EXPLICIT_RUN_CELL_METHODS.has(method)) {
      found.add(method);
    }
  }
  if (/\bcallMethod\s*\(/.test(text)) found.add("base.callMethod");
  return [...found].sort();
}
