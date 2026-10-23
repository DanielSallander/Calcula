//! FILENAME: app/src/api/macroNaming.ts
// PURPOSE: The ONE rule for what a macro module is called and what its id is:
//          `uniqueMacroName` (a name no other module has), `macroScriptId`
//          (the `macro-<slug>` id, never in the reserved `__calcula_`
//          namespace), `nextDefaultMacroName` (Excel's `Macro1`, `Macro2`, ...
//          for a macro the user did not name) and the description marker a
//          written macro carries.
// CONTEXT: 2026-10-22. These lived in the Macro Recorder's library module while
//          the recorder was the only thing that minted a macro. Developer > New
//          Macro mints one from the main window AND from the Object Script
//          Editor's own window (ScriptableObjects), and the command line resolves
//          `run <name>` by the same slug (host.ts), so the rule has to be ONE and
//          it has to be @api's: an extension cannot import another's internals
//          (the Facade Rule), and two copies of a slug rule drift on the first
//          edit. The recorder re-exports from here.
//
//          ZERO IMPORTS: reached from the eager `api/index.ts` barrel.

/** Id prefix for macro modules. Also the guarantee that a macro id can never
 *  collide with the reserved `__calcula_` namespace the Rust CRUD hides. */
export const MACRO_ID_PREFIX = "macro-";

/** A name not already used by another module: "Macro1245", "Macro1245 (2)", … */
export function uniqueMacroName(desired: string, taken: Iterable<string>): string {
  const base = desired.trim() || "Recorded macro";
  const used = new Set<string>();
  for (const name of taken) used.add(name.toLowerCase());
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

/** A stable, readable, non-reserved module id derived from a macro name. */
export function macroScriptId(name: string, takenIds: Iterable<string>): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "recorded";
  const used = new Set<string>(takenIds);
  const base = `${MACRO_ID_PREFIX}${slug}`;
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

/**
 * The first free name in Excel's series -- "Macro1", "Macro2", ... -- for a
 * macro the user did not name.
 *
 * Free means BOTH the name is not taken (case-insensitively, as
 * `uniqueMacroName` compares) AND the id it would get, `macro-macroN`, is not
 * taken. The second half matters: a module called "Totals" that was renamed
 * from "Macro1" keeps the id `macro-macro1`, and minting "Macro1" beside it
 * would give the new macro the id `macro-macro1-2` -- a name and an id that
 * disagree about which number it is. Skipping to "Macro2" keeps them aligned.
 */
export function nextDefaultMacroName(
  takenNames: Iterable<string>,
  takenIds: Iterable<string>,
): string {
  const names = new Set<string>();
  for (const name of takenNames) names.add(name.toLowerCase());
  const ids = new Set<string>(takenIds);
  for (let n = 1; ; n++) {
    const candidate = `Macro${n}`;
    if (names.has(candidate.toLowerCase())) continue;
    if (ids.has(`${MACRO_ID_PREFIX}macro${n}`)) continue;
    return candidate;
  }
}

/**
 * The `description` written on a macro the user starts from the worked example.
 *
 * `runtime=objectScript` is the marker the ONE reader, `parseModuleScriptRuntime`
 * (workbookScripts.ts), looks for -- it is what makes the Macros dialog mount the
 * module as an object script ("Run (object script)") instead of handing it to
 * the QuickJS module runtime, where `api` does not exist. The Rust button door
 * (`control_action.rs`) reads the same marker. The middle dot is U+00B7, the
 * character the recorder's `buildMacroDescription` uses.
 */
export function buildStarterMacroDescription(writtenAt: string): string {
  return `Macro · runtime=objectScript · written ${writtenAt}`;
}
