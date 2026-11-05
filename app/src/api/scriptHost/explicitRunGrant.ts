//! FILENAME: app/src/api/scriptHost/explicitRunGrant.ts
// PURPOSE: WHAT an application's macro may reach when a PERSON runs it (owner
//          decision B, 2026-09-30, widened to formatting by the owner on
//          2026-11-04) -- the cell access and the formatting, as two closed
//          tables of broker methods, plus the sentences that refuse everything
//          else.
// CONTEXT: The owner's rules: "An APPROVED application macro that the user runs
//          EXPLICITLY -- a button click, Developer > Macros > Run, the command
//          line -- gets the same CELL access in either runtime ... Standing
//          object scripts, and any run a script starts on its own, stay
//          restricted." (2026-09-30), and "Macros should be able to change
//          formatting as well." (2026-11-04).
//
// A NARROW GRANT, NOT A TIER. Such a run keeps the RESTRICTED tier and the
// application's origin: no just-in-time capability prompt, capabilities only
// through the application's consent record, and every tier check in the host
// (the sheet.* clamps, form and pane bindings, same-origin trust, the stamp the
// pull writes) behaves exactly as for any restricted realm. What changes is two
// flags on the script's host-side identity (`ScriptHandle.explicitRun.cells`
// and `.formatting`), each set only when the page AND Rust said yes (the mount
// gate answers `cellAccess` and `formatAccess`), read in three places: the
// broker's decision (`brokerPolicy.decidePolicy`, which admits the rows below
// and nothing else from the unlocked tier, and REFUSES the few restricted rows
// listed further down), the fill (`fillRangeFromScript`, held to its module
// twin), and the worker shim (`context.api` exists, so a recorded macro runs
// unchanged). The host sets the flags only after every mount gate admitted the
// run, and turns both off the moment the macro's setup settles
// (scriptHost/host.ts).
//
// "THE SAME CELL ACCESS", MEASURED. The module runtime's reach after approval is
// its manifest (core/script-engine/src/manifest.rs, the one-off profile): cells
// on any sheet (Calcula.getCellValue / getCellFormula / getRange / setCellValue
// / setRange / fillDown / fillRight / getUsedRange / getCurrentRegion /
// getRangeEdge), sheet names and the active sheet, calculation, plus view,
// bookmark and metadata reads, and applying an existing named style.
//
// "FORMATTING AS WELL", DRAWN. Formatting is HOW CELLS LOOK, written by a call
// whose whole effect is fixed when the run ends and taken back by the run's
// undo step: font, colour, fill, alignment, number format, borders (the range
// edges too), indent / wrap / rotation, an existing named style, clearing
// formats, and the size of rows and columns (Excel's Home > Format > Cell
// Size). It is NOT, and so stays excluded: the protection attributes
// (`locked` / `formulaHidden`: what the person can edit once a sheet is
// protected -- application code never sets protection, either way); which
// lines are SHOWN (hide / unhide, and a resize of a hidden line, which shows it
// in Excel and can lift a filter or open an outline group); standing RULES that
// keep acting after the run (conditional formats, data validation); the style
// CATALOGUE (creating or deleting a named style: not undoable, and a delete
// destroys the person's own definition); merges (structure); and every
// sheet-level setting (tab colour, page setup, print area, view). See
// docs/design/wave3-scripting-security.md section 11.4.
//
// PURE: imports only the policy table and the validators, because
// `brokerPolicy.ts` imports this and is shared with the Node preview harness,
// which has no Tauri.

import { ALLOWLIST } from "./allowlist";
import { vFormatRangeRefRestricted } from "./validators";

/**
 * The unlocked-tier broker rows an explicit run of an approved application
 * macro may call with CELL access. EXACTLY these; adding one is a decision (the
 * test pins the set). None carries a capability.
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
  "api.clearRange", //       Calcula.setCellValue(r, c, null) / setRange of blanks -- VBA's Range.ClearContents.
  //                          "contents" with cell access; "formats" and "all" also strip how the
  //                          cells look, so they need the FORMATTING grant too (`explicitRunArgsRefusal`).
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
 * The unlocked-tier broker rows an explicit run may call with the FORMATTING
 * grant (owner, 2026-11-04): how cells look, on any sheet. EXACTLY these; the
 * test pins the set. None carries a capability. Every WRITE here records into
 * the run's one undo step (the backend commands join an open transaction), so a
 * run that fails part-way takes its formatting back with its cells, and the
 * host reports what each one formatted to the run's trail
 * (`EXPLICIT_RUN_FORMAT_WRITES`).
 */
export const EXPLICIT_RUN_FORMAT_METHODS: ReadonlySet<string> = new Set<string>([
  // ---- READS (how cells look -- less than the value reads disclose) ----
  "api.getRangeFormat",
  "api.getCellFormat",
  "api.listNamedStyles",
  "api.getThemePalette",
  // ---- CELL FORMATTING (any sheet; the range-edge borders on the active one,
  //      which the granted api.setActiveSheet reaches) ----
  "api.setRangeFormat", //   font, colour, fill, alignment, number format, borders -- NOT locked /
  //                          formulaHidden (`explicitRunArgsRefusal`): those are protection
  "api.clearRangeFormat", // VBA Range.ClearFormats
  "api.applyNamedStyle", //  VBA Range.Style = "Good" (Calcula.applyNamedStyle)
  // ---- ROW AND COLUMN SIZE (Home > Format > Cell Size; never a HIDDEN line,
  //      which a resize would show -- refused host-side, `grantedRunResizeRefusal`) ----
  "api.setRowHeight",
  "api.setColumnWidth",
  "api.setRowHeights",
  "api.setColumnWidths",
  "api.autoFitColumns",
  "api.autoFitRows",
]);

/**
 * The calls of a granted run that CHANGE FORMATTING -- what the host records,
 * per sheet, in the run's write report (F15 widened): the unlocked writes above,
 * the two restricted formatting rows (`EXPLICIT_RUN_RESTRICTED_FORMAT_METHODS`)
 * and `api.clearRange` beyond contents.
 */
export const EXPLICIT_RUN_FORMAT_WRITES: ReadonlySet<string> = new Set<string>([
  "api.setRangeFormat",
  "api.clearRangeFormat",
  "api.applyNamedStyle",
  "api.setRowHeight",
  "api.setColumnWidth",
  "api.setRowHeights",
  "api.setColumnWidths",
  "api.autoFitColumns",
  "api.autoFitRows",
  "api.clearRange",
  "sheet.setRangeFormat",
  "sheet.clearRangeFormat",
]);

/** The line-resize rows: a granted run may not resize a HIDDEN line (it would show it). */
export const EXPLICIT_RUN_LINE_SIZE_METHODS: ReadonlySet<string> = new Set<string>([
  "api.setRowHeight",
  "api.setColumnWidth",
  "api.setRowHeights",
  "api.setColumnWidths",
  "api.autoFitColumns",
  "api.autoFitRows",
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
 * Restricted-tier FORMATTING rows: admitted to a granted realm only while its
 * FORMATTING grant is live. Every restricted `sheet.*` row is clamped to the
 * LIVE active sheet (host.ts `clampSheetIndex`), and the grant includes
 * `api.setActiveSheet` -- so together they let a run format every sheet in
 * turn, which is exactly the formatting grant, and nothing a realm without it
 * may do (only the user moves the sheet on screen). So a realm carrying the
 * explicit-run flag WITHOUT live formatting (Rust did not grant it, or the run
 * ended) is refused them, for the rest of its life, like the run-only rows. A
 * plain restricted realm keeps them. The format READS stay admitted always:
 * they disclose less than the value reads.
 */
export const EXPLICIT_RUN_RESTRICTED_FORMAT_METHODS: ReadonlySet<string> = new Set<string>([
  "sheet.setRangeFormat",
  "sheet.clearRangeFormat",
]);

/** The protection attributes `api.setRangeFormat` also accepts at the unlocked tier. */
const PROTECTION_FORMAT_KEYS: readonly string[] = ["locked", "formulaHidden"];

/** The part of a script's identity the grant reads. */
export interface ExplicitRunIdentity {
  explicitRun?: { readonly cells: boolean; readonly formatting: boolean };
}

/**
 * Whether the explicit-run grant admits `method` for this identity: the cell
 * grant is live and the method is a cell row, or the formatting grant is live
 * and it is a formatting row -- and it carries no capability (a capability
 * comes only through consent, never through a grant).
 */
export function explicitRunAdmits(identity: ExplicitRunIdentity, method: string): boolean {
  const run = identity.explicitRun;
  if (run === undefined || ALLOWLIST[method]?.capability) return false;
  return (
    (run.cells === true && EXPLICIT_RUN_CELL_METHODS.has(method)) ||
    (run.formatting === true && EXPLICIT_RUN_FORMAT_METHODS.has(method))
  );
}

/** The restricted bound's verdict for a granted run's non-line rectangle (BUG-0659). */
function restrictedRectRefusal(method: string, rect: readonly unknown[]): string | null {
  const verdict = vFormatRangeRefRestricted([rect[0], rect[1], rect[2], rect[3]]);
  return verdict === true ? null : `${method}: ${verdict} -- the bound for a macro that came in an application`;
}

/**
 * The ARGUMENT half of the grant: a granted row whose arguments reach beyond
 * what the grant covers is refused, with the reason; null when the call is
 * within it. Asked only for a realm carrying the grant, after the row itself
 * was admitted.
 *
 *  - `api.clearRange` is Range.ClearContents when `applyTo` is "contents" -- a
 *    cell's value and formula go, its look stays -- which cell access covers.
 *    "formats" and "all" (the default) also strip the cells' formatting, so
 *    they need the formatting grant (BUG-0616 #2; owner, 2026-11-04).
 *  - `api.setRangeFormat` with `locked` or `formulaHidden` is protection, not
 *    how cells look: refused (`explicitRunProtectionRefusalMessage`).
 *  - Every formatting rectangle that is not whole lines is held to the
 *    RESTRICTED tier's bound, 100,000 cells (BUG-0659): the code is an
 *    application's, whatever row it reached.
 */
export function explicitRunArgsRefusal(
  method: string,
  args: readonly unknown[],
  identity: ExplicitRunIdentity,
): string | null {
  switch (method) {
    case "api.clearRange": {
      const options = args[4] as { applyTo?: unknown } | null | undefined;
      const applyTo = options?.applyTo ?? "all";
      if (applyTo === "contents") return null;
      if (identity.explicitRun?.formatting !== true) {
        return (
          `${method}: this run of an application's macro has cell access but not formatting, so ` +
          `it may clear cell contents ({ applyTo: "contents" }) but not "${String(applyTo)}", which ` +
          "also removes how the cells look."
        );
      }
      return restrictedRectRefusal(method, args);
    }
    case "api.setRangeFormat": {
      const format = args[4];
      if (typeof format === "object" && format !== null) {
        const protection = PROTECTION_FORMAT_KEYS.filter((key) =>
          Object.prototype.hasOwnProperty.call(format, key),
        );
        if (protection.length > 0) return explicitRunProtectionRefusalMessage(method, protection);
      }
      return restrictedRectRefusal(method, args);
    }
    case "api.clearRangeFormat":
      return restrictedRectRefusal(method, args);
    default:
      return null;
  }
}

/** The refusal for an unlocked-tier method outside the grant. */
export function explicitRunRefusalMessage(method: string): string {
  return (
    `${method} is not part of what an application's macro may do when you run it ` +
    "yourself. It may read and change cell values, formulas and how cells look on any " +
    "sheet, size rows and columns, switch sheets, recalculate and group its changes into " +
    "one undo step -- nothing else that needs the unlocked tier."
  );
}

/** The refusal for the protection attributes of a format. */
export function explicitRunProtectionRefusalMessage(method: string, keys: readonly string[]): string {
  return (
    `${method}: an application's macro that you run may change how cells look, but not ` +
    `${keys.join(" or ")} -- whether a cell can be edited or shows its formula once the sheet ` +
    "is protected is protection, which code from an application never sets."
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

/**
 * The refusal for a restricted formatting row (EXPLICIT_RUN_RESTRICTED_FORMAT_METHODS)
 * in a realm whose formatting grant is not live.
 */
export function explicitRunFormatRefusalMessage(method: string): string {
  return (
    `${method}: this run of an application's macro may not change how cells look -- it ` +
    "has no formatting access, or its run has ended."
  );
}

/**
 * The refusal a realm carrying the explicit-run flag gets for a RESTRICTED-tier
 * row -- a run-only row, or a formatting row while its formatting grant is not
 * live -- or null when the row is admitted exactly as for any restricted realm.
 * The run-only rows are refused for the realm's whole life, also after the
 * grant expired.
 */
export function explicitRunRestrictedRefusal(
  method: string,
  identity: ExplicitRunIdentity,
): string | null {
  if (RUN_ONLY_REFUSED_METHODS.has(method)) return runOnlyRefusalMessage(method);
  if (EXPLICIT_RUN_RESTRICTED_FORMAT_METHODS.has(method) && identity.explicitRun?.formatting !== true) {
    return explicitRunFormatRefusalMessage(method);
  }
  return null;
}

/**
 * THE PRE-FLIGHT: the `api.<name>(` calls in `source` that are unlocked-tier
 * broker rows OUTSIDE the grant (cells and formatting), plus `base.callMethod`
 * for a `callMethod(` call (the one run-only refusal a macro's `context` can
 * spell) and `api.setRangeFormat` for a format that names `locked` or
 * `formulaHidden` -- unique and sorted, empty when the macro stays within the
 * grant.
 *
 * Run BEFORE anything is mounted, so a recorded macro that also sorts, inserts
 * or merges is refused up front with those calls named, instead of writing
 * half its cells and then failing at the broker. It reads text, so it cannot
 * see a method reached dynamically (`api[name]()`) or through the object model
 * (`api.workbook.save()`), and a comment stripper this naive can miss a call
 * inside a string that contains `//`: every one of those is a false NEGATIVE,
 * which the broker still refuses when the call is made (and the run's earlier
 * changes are then taken back). The opposite slip -- a call NAMED inside a
 * string literal -- is read as a call and refuses a macro that would not have
 * made it, which is the safe direction. It can never ADMIT anything -- the
 * broker is the authority.
 */
export function ungrantedApiCalls(source: string): string[] {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const found = new Set<string>();
  const pattern = /\bapi\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const method = `api.${match[1]}`;
    const policy = ALLOWLIST[method];
    if (
      policy &&
      policy.tier === "unlocked" &&
      !EXPLICIT_RUN_CELL_METHODS.has(method) &&
      !EXPLICIT_RUN_FORMAT_METHODS.has(method)
    ) {
      found.add(method);
    }
  }
  if (/\bcallMethod\s*\(/.test(text)) found.add("base.callMethod");
  // The ARGUMENT half (`explicitRunArgsRefusal`): a format that names the
  // protection attributes. Read from the text, so `locked` spelled anywhere in
  // the argument list refuses -- the safe direction, as above.
  if (callArgumentsMatch(text, "setRangeFormat", /\b(?:locked|formulaHidden)\b/)) found.add("api.setRangeFormat");
  return [...found].sort();
}

/**
 * Whether `text` (comments already stripped) calls `api.<name>(...)` with an
 * argument list matching `test` -- each call's arguments read up to its
 * matching parenthesis.
 */
function callArgumentsMatch(text: string, name: string, test: RegExp): boolean {
  const call = new RegExp(`\\bapi\\s*\\.\\s*${name}\\s*\\(`, "g");
  let match: RegExpExecArray | null;
  while ((match = call.exec(text)) !== null) {
    let depth = 1;
    let i = match.index + match[0].length;
    const start = i;
    while (i < text.length && depth > 0) {
      const ch = text[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      i++;
    }
    if (test.test(text.slice(start, i - 1))) return true;
  }
  return false;
}
