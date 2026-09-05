//! FILENAME: app/src/api/scriptHost/extensionFormBindings.ts
// PURPOSE: What a DISTRIBUTED ADD-IN's form (M4) is allowed to take from the
//          workbook, and how it takes it: the bound-cell READ that seeds a
//          widget, and nothing else.
//
// WHY THIS IS ITS OWN MODULE AND NOT host.ts's `resolveFormBindings`.
// Not because the rules are different — the RULES are shared and live in
// `scriptFormBindings.ts` (`collectFormBindings`, `parseFormBinding`,
// `seedFromCell`), which both pipelines import, so a change to what a cell
// MEANS for a widget lands on both surfaces at once. What differs is the reach,
// and it differs by SUBTRACTION:
//
//   object script form            add-in form
//   ------------------            -----------
//   cell / defined name /         a bare cell on the sheet in front of the
//     Controls value / any        user, and nothing else (the validator
//     sheet its tier allows       refuses the rest — validators.ts
//                                 `FormValidationSurface`)
//   options + table rows read     no `{ range }` sources at all
//     from a range
//   an image from the             no workbook media
//     workbook's media
//   writes its cells back on      NEVER WRITES ITS BOUND CELL. There is no
//     submit or on change         write path from a binding in the code: no
//                                 `writeBindings` dep is supplied, every seed
//                                 is `readOnly`, and `writeOn` is refused at
//                                 the wire.
//
// That last row is a promise made on a consent screen
// (`CONTRIBUTION_REACH_NOTE.form`), so it is kept STRUCTURALLY. An add-in lives
// in %APPDATA% and runs against every document the user opens, including
// workbooks its author has never seen; "the field shows the cell and never
// writes it" is what this module guarantees, and it is stated that narrowly on
// purpose. It is NOT a promise that the add-in cannot change cells at all: a
// form's button relays into the add-in's own handler, which can call
// `ext.executeCommand` and run Calcula's script-safe editing commands. That
// second door is disclosed by EXTENSION_BUILTIN_ACTION_REACH_NOTE at consent
// time, because it is not this module's to close.
//
// THE READ IS A REAL BROKER CALL, on the same row the extension's own handle
// would use — `sheet.getCellData` at the restricted tier — so the policy
// decides it and the audit ring records it under `extension:<id>`. Reaching
// `getRangeCellsTyped` directly (as the first draft did) would have been the
// one read an add-in performs that the transparency trail never sees, which is
// the defect `form.readControl` exists to have already fixed once.
//
// THE WORKER NEVER NAMES A CELL. `sheet.getCellData` is NOT in
// EXTENSION_BROKER_METHODS, so an add-in cannot call it; the host calls it
// while seeding a form the add-in DECLARED and the user opened. This is the
// host-push shape `grid.read` was named for ("nothing here is a call the code
// makes").

import { brokerCall, type ScriptHandle } from "./broker";
import { collectFormBindings, parseFormBinding, seedFromCell } from "./scriptFormBindings";
import type { FormSeed, FormSpec } from "./scriptFormSpec";
import type { ScriptCell } from "./worker/canonicalModel";

/**
 * What a bound field says when the add-in may not be shown cells. Written for
 * the person reading the greyed-out box, and it names the permission so the
 * sentence matches the one they were asked at install.
 */
export const EXTENSION_FORM_NO_GRID_READ =
  "this add-in has not been allowed to be shown your cells";

/**
 * What a bound field says when it WAS read. Every bound field of an add-in's
 * form carries it, because every one of them is display-only — the user must
 * not be able to type into a box that will silently throw their answer away.
 *
 * IT SAYS "THIS FIELD", NOT "THIS ADD-IN". The claim the code keeps is about
 * the BINDING: nothing typed or shown here travels back to the cell. It is not
 * a claim that the add-in can never change that cell by other means — its form
 * buttons run its own code, which reaches `ext.executeCommand` and so the
 * script-safe editing commands (EXTENSION_BUILTIN_ACTION_REACH_NOTE says so at
 * consent time). The earlier wording, "it can never change it", read as the
 * broader promise and could not be kept.
 */
export const EXTENSION_FORM_DISPLAY_ONLY =
  "an add-in's form can show you this cell; this field never writes back to it";

/** What one add-in form's `bind` declarations resolved to. */
export interface ExtensionFormBindings {
  /** Seeds per widget name — every one of them read-only, with a reason. */
  seeds: Record<string, FormSeed>;
  /** The sheet the bindings were read from, for the form's identity band. */
  pinnedSheetName?: string;
  /**
   * At least one cell was actually READ. The caller writes the `grid.read`
   * grant down on this, so the transparency panel shows the capability in USE
   * rather than merely declared (the rule `setupCellStyleRegistration` and the
   * event forwarder already follow).
   */
  read: boolean;
}

/** A disabled widget carrying its reason — never an absent seed, which would
 *  paint an ordinary empty box and say nothing. */
function refusedSeed(reason: string): FormSeed {
  return { value: null, readOnly: true, reason };
}

/**
 * One cell as a typed `ScriptCell`. The field-for-field twin of host.ts's
 * `typedToScriptCell`, and deliberately a copy of THREE ASSIGNMENTS rather
 * than an import: host.ts is the 15k-line object-script host and this module is
 * loaded by the extension host, which imports none of it. What must not be
 * copied is the RULES — `seedFromCell` below is the shared one — and they are
 * not.
 */
async function readOneCell(
  lib: typeof import("../lib"),
  sheetIndex: number,
  row: number,
  col: number,
): Promise<ScriptCell> {
  const sparse = await lib.getRangeCellsTyped(row, col, row, col, sheetIndex);
  const hit = sparse.find((c) => c.row === row && c.col === col);
  if (!hit) return { value: null, display: "", type: "empty" };
  const cell: ScriptCell = { value: hit.value, display: hit.display, type: hit.type };
  if (hit.formula) cell.formula = hit.formula;
  return cell;
}

/**
 * Resolve and read every `bind` an add-in's form declares.
 *
 * Nothing is refused wholesale: a binding this add-in may not be shown becomes
 * a DISABLED widget carrying the reason, so the form still opens and the user
 * sees WHY the box is grey rather than a blank they might fill in for nothing.
 *
 * THE CAPABILITY QUESTION IS ASKED HERE, AT DELIVERY — both halves of it. The
 * ceiling (`declaredCapabilities`) can never grow, but the GRANT set shrinks
 * when the user revokes in the transparency panel, and a form registered an
 * hour ago must not still be shown cells because it was allowed then. Asking
 * only the ceiling is the exact defect the cell-style resolver already had.
 *
 * ...and asking honestly is not enough if something upstream refills the set.
 * The host writes `grid.read` down when a form carrying a `bind` is REGISTERED,
 * and `register` is a message the sandboxed worker posts whenever it likes — so
 * an add-in undid the user's revoke by registering a second declared form (or
 * by unregistering and re-registering its only one) and this check was handed
 * back a set the user had emptied. That write now goes through
 * `recordGridReadInUse` (extensionWorkerHost.ts), which refuses a capability
 * revoked this session. Both halves are needed; neither is sufficient alone.
 */
export async function resolveExtensionFormBindings(
  handle: ScriptHandle,
  spec: FormSpec,
): Promise<ExtensionFormBindings> {
  const decls = collectFormBindings(spec);
  const seeds: Record<string, FormSeed> = {};
  if (decls.length === 0) return { seeds, read: false };

  const mayBeShownCells =
    handle.declaredCapabilities.has("grid.read") && handle.grants.has("grid.read");
  if (!mayBeShownCells) {
    for (const decl of decls) seeds[decl.name] = refusedSeed(EXTENSION_FORM_NO_GRID_READ);
    return { seeds, read: false };
  }

  const lib = await import("../lib");
  const { sheets, activeIndex } = await lib.getSheets();
  const pinnedSheetName = sheets.find((s) => s.index === activeIndex)?.name;
  let read = false;

  for (const decl of decls) {
    let parsed;
    try {
      parsed = parseFormBinding(decl.bind);
    } catch (e) {
      seeds[decl.name] = refusedSeed(e instanceof Error ? e.message : String(e));
      continue;
    }
    // BELT AND BRACES, on purpose. The wire validator already refused a defined
    // name, a Controls value and a sheet-qualified reference for this surface
    // (validators.ts), so reaching this arm means the two disagree — and the
    // safe answer to that is a refusal the user can see, never a read.
    if (parsed.kind !== "cell" || parsed.sheetRef !== null) {
      seeds[decl.name] = refusedSeed(
        "an add-in's form reads only a plain cell on the sheet you are looking at",
      );
      continue;
    }
    const args: unknown[] = [parsed.row, parsed.col, activeIndex];
    try {
      const cell = (await brokerCall(handle, "sheet.getCellData", args, () =>
        readOneCell(lib, activeIndex, parsed.row, parsed.col),
      )) as ScriptCell;
      const seed = seedFromCell(decl.widgetType, cell, decl.multi);
      // Display-only, always, and the reason says so. `seedFromCell` is the
      // SHARED rule for what a cell means to a widget; the read-only marking is
      // this surface's own and is applied after it, so a change to the shared
      // rule can never make an add-in's field writable by omission.
      seed.readOnly = true;
      seed.reason = EXTENSION_FORM_DISPLAY_ONLY;
      seeds[decl.name] = seed;
      read = true;
    } catch (e) {
      seeds[decl.name] = refusedSeed(e instanceof Error ? e.message : String(e));
    }
  }
  return { seeds, pinnedSheetName, read };
}
