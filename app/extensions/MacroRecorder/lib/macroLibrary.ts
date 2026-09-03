//! FILENAME: app/extensions/MacroRecorder/lib/macroLibrary.ts
// PURPOSE: Where a recorded macro LIVES — the module-script store — plus the
//          naming, the runtime marker, and the CRUD the macro library UI drives.
// CONTEXT: Excel never asks a user where to put a recorded macro: it lands in a
//          module, every time, and that is why nobody loses one. Calcula's
//          review dialog used to be a save prompt, so "Close" threw the whole
//          recording away. Now the recording is written here the moment
//          recording STOPS — before the dialog opens — and the dialog is only
//          "what else would you like to do with it".
//
// A NORMAL USER SCRIPT, DELIBERATELY. Ids are `macro-<slug>`, never the reserved
// `__calcula_` prefix: Rust hides reserved records from `list_scripts` and
// refuses to delete them, so a macro saved under one would be invisible and
// undeletable — recreating the exact failure this whole fix is about (code that
// exists with nothing reaching it).
//
// THE RUNTIME MARKER. The two macro targets produce source for two different
// interpreters, and only ONE of them is the module store's own runtime:
//
//   notebook     -> synchronous `Calcula.*` in the Rust QuickJS interpreter.
//                   This IS what `run_script` executes, so it runs from the
//                   library directly.
//   objectScript -> the async object-script `api`, which exists only inside a
//                   mounted object script's worker realm. `run_script` has no
//                   `api` binding, so running it there would throw.
//
// The library must therefore know which it is holding. The marker rides in the
// module's `description`, which round-trips through save/get and is visible to
// the user in the same breath.
//
// BOTH FLAVOURS RUN. Knowing the runtime is not the same as refusing to run —
// that was the previous round's mistake: Run was disabled for objectScript
// modules, which turned an honest error into a control that looked enabled and
// did nothing at all. `runMacroModule` now ROUTES on the marker:
//
//   notebook / unmarked -> runWorkbookScript  (the QuickJS module runtime)
//   objectScript        -> runObjectScriptOnce (a transient unlocked object
//                          script — the runtime the source was written for)
//
// The second path is not a workaround; it is the same mount a button uses, so
// "Run" and "click the button" execute through ONE code path with one set of
// guarantees (Script Security gate, unlocked tier, broker allowlist, audit).
// If one works the other works, which is exactly the property this feature
// failed to have twice.
//
// THE ROUTE IS PUBLISHER CONTENT, SO THE ROUTE MAY NOT PICK THE GATE. The
// marker lives in the `description`, and a `.calp` ships the description with
// the module — so `macroRunRoute` is reading the PUBLISHER'S text to decide how
// their own code runs. That is fine for choosing an interpreter and was a hole
// for choosing a protection: `run_script` refuses an unconsented distributed
// module (`require_distributed_module_consent`), and the object-script route
// asked for consent nowhere, so writing `runtime=objectScript` in your own
// description bought you a real worker realm with no consent in the path. Both
// routes now pass the SAME Rust gate — the object-script one through
// `runObjectScriptOnce`, which calls it before it mounts — so the marker
// chooses an interpreter and nothing else. Restricted is not consented: the
// tier bounds what the code can reach, consent is agreeing to run it at all.

import {
  deleteWorkbookScript,
  getWorkbookScript,
  listWorkbookScriptRecords,
  listWorkbookScripts,
  originTagTitle,
  parseModuleScriptRuntime,
  runObjectScriptOnce,
  runWorkbookScript,
  saveWorkbookScript,
  scriptOriginForStoredRecord,
} from "@api";
import type { MacroRunOutcome, ScriptRunResult, ScriptScope } from "@api";
import type { MacroTarget } from "./types";

/** Which interpreter a stored module's source was written for. */
export type MacroRuntime = MacroTarget;

/** Id prefix for recorder-authored modules. Also the guarantee that a macro id
 *  can never collide with the reserved `__calcula_` namespace. */
const MACRO_ID_PREFIX = "macro-";

/** Reserved-id prefix the Rust CRUD hides and protects (mirror of
 *  RESERVED_SCRIPT_PREFIX in app/src-tauri/src/scripting/commands.rs). */
const RESERVED_ID_PREFIX = "__calcula_";

/** Human label for a runtime, used in the library and the review dialog. */
export function describeMacroRuntime(runtime: MacroRuntime): string {
  return runtime === "notebook" ? "Notebook / QuickJS" : "Object script";
}

// ============================================================================
// The description marker
// ============================================================================

/** The `description` written on a recorder-authored module. */
export function buildMacroDescription(options: {
  runtime: MacroRuntime;
  actionCount: number;
  recordedAt: string;
}): string {
  const { runtime, actionCount, recordedAt } = options;
  const plural = actionCount === 1 ? "action" : "actions";
  return `Recorded macro · runtime=${runtime} · ${actionCount} ${plural} · recorded ${recordedAt}`;
}

/**
 * The runtime a stored module targets, or null when the module was not written
 * by the recorder.
 *
 * Null is NOT "assume objectScript". A hand-authored module script is QuickJS
 * source by definition — it is what `run_script` runs — so the library treats an
 * unmarked module as runnable, and only a module explicitly marked
 * `runtime=objectScript` is held back from the Run button.
 *
 * The marker itself is parsed by @api (`parseModuleScriptRuntime`), because the
 * recorder WRITES it and other surfaces — the Object Script Editor's module list
 * — READ it. One regex, one answer; two copies would eventually disagree.
 */
export function parseMacroRuntime(
  description: string | null | undefined,
): MacroRuntime | null {
  return parseModuleScriptRuntime(description);
}

/** Whether the QuickJS MODULE runtime (`run_script`) can execute this module. */
export function isModuleRuntimeRunnable(
  description: string | null | undefined,
): boolean {
  return parseMacroRuntime(description) !== "objectScript";
}

/** Which executor `runMacroModule` will use for a stored module. */
export type MacroRunRoute = "moduleRuntime" | "objectScript";

export function macroRunRoute(
  description: string | null | undefined,
): MacroRunRoute {
  return isModuleRuntimeRunnable(description) ? "moduleRuntime" : "objectScript";
}

/**
 * The sentence the library puts ON SCREEN next to Run, naming the runtime the
 * macro will execute in — and, when the module runtime is not it, exactly why.
 *
 * Never null: a user pressing a button is owed a statement of what it is about
 * to do, not only of what it refuses to do.
 */
export function describeRunRoute(
  description: string | null | undefined,
  sourcePackage?: string | null,
): string {
  if (macroRunRoute(description) === "moduleRuntime") {
    return (
      "Run executes this module in the workbook script runtime (the isolated " +
      "QuickJS interpreter that speaks `Calcula.*`)."
    );
  }
  const tier = isDistributedMacro(sourcePackage)
    ? "restricted object script (it came from an application, so it cannot be " +
      "granted the unlocked tier, and it does not run at all unless you have " +
      "approved that application's code)"
    : "unlocked object script";
  return (
    "This macro is written for the OBJECT-SCRIPT runtime (`api.*`), which the " +
    "workbook script runtime does not have — it speaks `Calcula.*` and has no " +
    "`api` binding at all. Run therefore mounts the macro as a temporary " +
    `${tier}, the runtime it was written for, and unmounts it ` +
    "when it finishes. Script Security applies, exactly as it does for a button."
  );
}

// ============================================================================
// Provenance — where the code in this list CAME FROM
// ============================================================================
//
// A `.calp` application may ship MODULE SCRIPTS. `core/calp/src/pull.rs`
// materializes them into the subscriber's workbook with `source_package`
// stamped, and `list_scripts`/`get_script` return them like any other module —
// so this library lists a publisher's macros beside the user's own. Until the
// entry carried its package the two were indistinguishable on screen, and the
// consent model rests entirely on the user being able to tell them apart before
// pressing Run.

/** Whether a stored module arrived inside a distributed application. */
export function isDistributedMacro(sourcePackage: string | null | undefined): boolean {
  return typeof sourcePackage === "string" && sourcePackage.trim() !== "";
}

/**
 * The short chip text for a module's origin — the application's name, or null
 * for the user's own code (which needs no badge; local is the baseline).
 */
export function macroProvenanceTag(
  sourcePackage: string | null | undefined,
): string | null {
  return isDistributedMacro(sourcePackage) ? (sourcePackage as string).trim() : null;
}

/**
 * The sentence shown beside Run for a module that came from an application.
 * Null for a local module. Spelled through `originTagTitle` so the library, the
 * transparency panel and the permissions panel name a publisher the same way.
 *
 * IT NAMES THE ROUTE'S OWN GUARANTEE, NOT A GENERIC ONE. This used to promise
 * "it runs at the restricted tier" for every distributed macro, and for a
 * MODULE-RUNTIME macro that is simply false: `run_script` is the Rust QuickJS
 * interpreter, which has no tiers, no `context.api` and no capability broker at
 * all — there is nothing there to be restricted. Naming a tier that does not
 * exist on that route tells the user their protection is one thing when it is
 * another, which is the same class of lie as dropping the stamp. What IS true
 * on that route is the consent gate: `require_distributed_module_consent`
 * (app/src-tauri/src/scripting/commands.rs) refuses the run outright unless the
 * user approved this application's code, hash for hash.
 *
 * CONSENT IS NOW TRUE ON BOTH ROUTES, and the object-script sentence says so.
 * It used to name only the tier — which was accurate about the sandbox and
 * silent about the thing that was missing: nothing asked the user whether this
 * application's code could run at all. Describing a restriction while the
 * permission behind it does not exist is the more dangerous half of the same
 * lie, because a user reading it concludes they are protected by a decision
 * they were never offered.
 */
export function describeMacroProvenance(
  sourcePackage: string | null | undefined,
  description: string | null | undefined,
): string | null {
  if (!isDistributedMacro(sourcePackage)) return null;
  const origin = scriptOriginForStoredRecord({ sourcePackage });
  const lead = `${originTagTitle(origin)} — you did not write this macro.`;
  if (macroRunRoute(description) === "objectScript") {
    return (
      `${lead} It does not run unless you have approved this application's code, ` +
      "exactly as it is stored; if you have, it is mounted as a RESTRICTED object " +
      "script (never unlocked) and can use a capability only through that approval."
    );
  }
  return (
    `${lead} It runs in the workbook script runtime, which has no tiers at all — ` +
    "no `api` object and no capability broker — so what protects you here is " +
    "consent, not a tier: the run is refused unless you have approved this " +
    "application's code, exactly as it is stored."
  );
}

/**
 * The tier this macro's one-shot run may ASK for.
 *
 * Derived from the record, never assumed: `runObjectScriptOnce` re-derives it
 * authoritatively from the module store and REFUSES a caller that asks for
 * "unlocked" on a distributed artifact, so a hard-coded "unlocked" here would
 * turn every distributed macro's Run button into an error.
 */
export function macroRunAccessLevel(
  sourcePackage: string | null | undefined,
): "restricted" | "unlocked" {
  return isDistributedMacro(sourcePackage) ? "restricted" : "unlocked";
}

// ============================================================================
// Editing someone else's macro — FORK, never overwrite
// ============================================================================
//
// THE HOLE THIS CLOSES. The module-runtime route is CONTENT-KEYED: the Rust
// gate `distributed_module_refusal` looks for a stored module whose source is
// EXACTLY the source being run, and refuses when that module carries a package
// the user has not consented to. Source that matches nothing stored is treated
// as an ad-hoc editor run and allowed. So typing one character into this
// library's textarea and pressing Run took a publisher's macro straight past
// package consent — the edited text matched no stored record, so no owner was
// found, so nothing refused it.
//
// THE THREE HONEST ANSWERS, AND WHY THIS ONE.
//
//   REFUSE.       Correct but useless: a subscriber who wants to adapt a
//                 report's macro is told "no" with nowhere to go.
//   RE-CONSENT.   Wrong shape. Consent is the user approving the PUBLISHER'S
//                 code. Asking them to consent to text they typed themselves,
//                 under the publisher's name, records a lie in the consent
//                 file — and the next `.calp` refresh would overwrite it.
//   FORK.         What the Rust gate already documents: "A local script with
//                 this exact source authorises the run outright ... copying a
//                 distributed module to your own script — the documented way to
//                 adapt distributed content — keeps working." A fork makes that
//                 copy REAL: a new module id, no `source_package`, listed as the
//                 user's own, running under their own identity. The publisher's
//                 record is left byte-for-byte as it arrived, so a refresh from
//                 the application still matches its consent hash.
//
// WRITING THE EDIT BACK IN PLACE IS *NOT* A FOURTH OPTION. `save_script` makes
// the stamp sticky, so an in-place write keeps the package — and then the stored
// record no longer matches the publisher's consent hash, which leaves the user
// holding a publisher's macro that can never run again and that they cannot
// repair. Losing someone's macro quietly is exactly what this feature keeps
// being punished for.

/** What saving the buffer in front of the user must do. */
export type MacroEditDisposition =
  /** Write it back to this record: it is the user's own, or nothing changed. */
  | { kind: "inPlace" }
  /** The source of a publisher's macro was edited: make the user a local copy. */
  | { kind: "fork"; packageName: string };

/**
 * Decide between writing back and forking.
 *
 * NAME CHANGES DO NOT FORK. A rename is metadata: it does not change a byte of
 * what executes, the consent hash is over the SOURCE, and forking on it would
 * flood the workbook with copies. It writes back in place, carrying the stamp
 * (see `updateMacroModule`).
 */
export function macroEditDisposition(options: {
  sourcePackage: string | null | undefined;
  /** The bytes the store holds for this record. */
  storedSource: string;
  /** The bytes in the editor. */
  draftSource: string;
}): MacroEditDisposition {
  const name = macroProvenanceTag(options.sourcePackage);
  if (name === null) return { kind: "inPlace" };
  if (options.draftSource === options.storedSource) return { kind: "inPlace" };
  return { kind: "fork", packageName: name };
}

/** What the user is told, on screen, when their edit needs a fork. */
export function describeForkRequirement(
  packageName: string,
  macroName: string,
): string {
  return (
    `You have changed the code of "${macroName}", which arrived in the application ` +
    `"${packageName}". Your edits are not that application's code, so they are not ` +
    "written back into it and they cannot run under its name — the run would be " +
    "carrying your text past the consent you gave to theirs. Press \"Save as my copy\" " +
    "to make a local macro of your own from this text. It is listed as yours, runs as " +
    "yours, and the application's macro is left exactly as it arrived."
  );
}

/** The description a forked copy carries: the runtime marker, plus lineage. */
export function forkedMacroDescription(
  description: string | null | undefined,
  packageName: string,
): string {
  const lineage = `Local copy of a macro from the application "${packageName}"`;
  // The RUNTIME MARKER must survive, or the copy routes to the wrong
  // interpreter — so the stored description is kept verbatim and the lineage
  // appended, never the other way round.
  return typeof description === "string" && description.trim() !== ""
    ? `${description} · ${lineage}`
    : lineage;
}

/**
 * Make a genuinely LOCAL macro out of the text the user edited.
 *
 * A new record with a new id and NO `source_package`, so it is the user's from
 * the first byte: `sticky_source_package` has nothing to carry forward for an id
 * that does not exist yet, and no later writer can make it a package's.
 */
export async function forkMacroModule(options: {
  /** The publisher's record being adapted (untouched by this call). */
  packageName: string;
  /** The name the user had typed; the copy takes a free variation of it. */
  name: string;
  /** The edited text — what the copy will hold and run. */
  source: string;
  /** The publisher record's description, for the marker and the lineage note. */
  description: string | null;
  /**
   * The scope the publisher's record was READ with.
   *
   * Carried onto the copy, because a fork is meant to differ from its original
   * in exactly two ways — a new id and no package stamp. A copy that silently
   * became workbook-wide would resolve from sheets the original never did, so
   * the escape hatch would hand the user a macro that behaves differently from
   * the one they were adapting.
   */
  scope: ScriptScope | undefined;
}): Promise<{ id: string; name: string }> {
  const existing = await listWorkbookScripts();
  const name = uniqueMacroName(
    `${options.name.trim() || "Recorded macro"} (my copy)`,
    existing.map((s) => s.name),
  );
  const id = macroScriptId(
    name,
    existing.map((s) => s.id),
  );
  await saveWorkbookScript({
    id,
    name,
    description: forkedMacroDescription(options.description, options.packageName),
    source: options.source,
    scope: options.scope,
    // Deliberately ABSENT, not null-with-a-comment: this record is local.
  });
  return { id, name };
}

// ============================================================================
// Naming
// ============================================================================

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

// ============================================================================
// Store operations
// ============================================================================

/** One module as the library lists it. */
export interface MacroModuleEntry {
  id: string;
  name: string;
  description: string | null;
  /**
   * The recorder runtime marker, or null for a module the recorder did not write.
   *
   * This is the ONLY runtime-ish field on an entry, deliberately. The route, its
   * on-screen note and "can the module runtime run it" are all 1:1 derivations of
   * this marker (`macroRunRoute` / `describeRunRoute` / `isModuleRuntimeRunnable`),
   * and the dialog calls those on the module the user is LOOKING at — which is the
   * edited description, not the stale list row. Precomputing them here too gave
   * every entry three fields no screen ever read: a second source of truth that
   * could only ever be the wrong one.
   */
  runtime: MacroRuntime | null;
  /**
   * The application this module arrived in, or null for the user's own code.
   *
   * Carried onto the entry — not derived, not dropped — because the LIST is
   * where the user decides what to run, and a publisher's macro that looks
   * exactly like their own is a decision they cannot make. It is also what the
   * run path uses to ask for the right tier.
   */
  sourcePackage: string | null;
  /**
   * Why the module could not be READ, when it could not.
   *
   * A module whose record fails to load is still listed — hiding it would be
   * the invisible-code failure again — but it is listed WITH the failure, not
   * as an ordinary entry whose runtime happens to be unknown.
   */
  loadError: string | null;
}

/** Where a recording was auto-saved. */
export interface SavedMacroModule {
  id: string;
  name: string;
  runtime: MacroRuntime;
}

/**
 * Claim a free name + id for a new macro BEFORE its source is generated.
 *
 * Two steps rather than one because the generated source embeds the macro name
 * (header comment and function identifier). Generating with the requested name
 * and then storing under a deduplicated one would ship a module called
 * "Macro1245 (2)" whose source says "Macro1245" — a small lie that costs the
 * user a confused minute every time two recordings land in the same minute.
 */
export async function reserveMacroModule(
  desiredName: string,
): Promise<{ id: string; name: string }> {
  const existing = await listWorkbookScripts();
  const name = uniqueMacroName(desiredName, existing.map((s) => s.name));
  const id = macroScriptId(
    name,
    existing.map((s) => s.id),
  );
  return { id, name };
}

/** Write (create or replace) a macro module. */
export async function saveMacroModule(options: {
  id: string;
  name: string;
  source: string;
  runtime: MacroRuntime;
  actionCount: number;
  recordedAt: string;
}): Promise<SavedMacroModule> {
  const { id, name, source, runtime, actionCount, recordedAt } = options;
  if (id.startsWith(RESERVED_ID_PREFIX)) {
    throw new Error(
      `"${id}" is a reserved internal script id; a macro saved there would be invisible and undeletable.`,
    );
  }
  await saveWorkbookScript({
    id,
    name,
    description: buildMacroDescription({ runtime, actionCount, recordedAt }),
    source,
    scope: { type: "workbook" },
  });
  return { id, name, runtime };
}

/**
 * Auto-save a just-stopped recording. Reserves a name, saves, and reports where
 * it went. Throws on failure — the caller MUST surface that rather than let the
 * recording evaporate.
 */
export async function autoSaveRecordedMacro(options: {
  desiredName: string;
  runtime: MacroRuntime;
  actionCount: number;
  recordedAt: string;
  /** Generate the source once the final (deduplicated) name is known. */
  generateSource: (finalName: string) => string;
}): Promise<SavedMacroModule> {
  const { desiredName, runtime, actionCount, recordedAt, generateSource } = options;
  const { id, name } = await reserveMacroModule(desiredName);
  return saveMacroModule({
    id,
    name,
    source: generateSource(name),
    runtime,
    actionCount,
    recordedAt,
  });
}

/**
 * Every module in the workbook, with its runtime marker resolved.
 *
 * The listing itself is @api's (`listWorkbookScriptRecords`) — "what module
 * scripts does this workbook hold" is not a macro-specific question, and the
 * Object Script Editor asks it too. What is macro-specific, and stays here, is
 * the runtime marker and what the library does with it.
 */
export async function listMacroModules(): Promise<MacroModuleEntry[]> {
  const records = await listWorkbookScriptRecords();
  return records.map((record) => ({
    id: record.id,
    name: record.name,
    description: record.description,
    runtime: parseMacroRuntime(record.description),
    sourcePackage: record.sourcePackage ?? null,
    // A module whose record cannot be read is still listed — hiding it would be
    // the invisible-code failure again, just with a different cause — but the
    // failure travels with it.
    loadError: record.loadError,
  }));
}

/** Load one module's full record. */
export async function loadMacroModule(id: string) {
  return getWorkbookScript(id);
}

/**
 * Overwrite a module's name/source in place (rename and edit are the same write
 * — `save_script` is keyed by id).
 *
 * `sourcePackage` IS REQUIRED, AND IT IS THE RECORD'S OWN. This write used to
 * omit it, which is how a rename in this dialog laundered a publisher's macro
 * into local code: the stamp is what every later run derives its tier and its
 * trust origin from, so a module that loses it runs UNLOCKED under the user's
 * own identity. `save_script` now carries an omitted stamp forward
 * (`sticky_source_package`), so the backend would repair this — but a caller
 * that relies on a repair is a caller that will be wrong the first time it
 * writes through anything else. It passes what it read; `null` is a positive
 * statement that the record is local, not a shrug.
 *
 * `scope` IS REQUIRED FOR THE SAME REASON, and it is the same defect one field
 * over. This write hard-coded `{ type: "workbook" }`, so RENAMING a sheet-scoped
 * module — a write that is supposed to change no byte that executes — moved it
 * to the whole workbook, where it resolves from every sheet. Nothing announced
 * it and nothing could undo it, because the old scope was gone from the store.
 * A publisher's sheet-scoped module was widened by a rename too, which is a
 * change to a distributed record the user is not entitled to make silently.
 * `undefined` means the record stated none and the store's own default stands.
 */
export async function updateMacroModule(options: {
  id: string;
  name: string;
  source: string;
  description: string | null;
  /** The application this record arrived in, as READ from the store. */
  sourcePackage: string | null;
  /** The scope this record was READ with. Never a constant — see above. */
  scope: ScriptScope | undefined;
}): Promise<void> {
  await saveWorkbookScript({
    id: options.id,
    name: options.name,
    description: options.description,
    source: options.source,
    scope: options.scope,
    sourcePackage: options.sourcePackage,
  });
}

/** Delete a module. */
export async function deleteMacroModule(id: string): Promise<void> {
  await deleteWorkbookScript(id);
}

/**
 * Refuse to execute EDITED text under a publisher's name — the run-path half of
 * the fork rule above, and the reason it is not only a dialog decision.
 *
 * The dialog greys Run out and offers "Save as my copy", but a gate that lives
 * only in a component is a gate the next caller walks around. Both routes are
 * covered, deliberately:
 *
 *   * MODULE RUNTIME — the actual hole. The Rust gate matches by exact source,
 *     so edited text finds no owner and sails through.
 *   * OBJECT SCRIPT — `runObjectScriptOnce` does resolve the record by id, keeps
 *     the restricted tier and now passes the same Rust consent gate, so this is
 *     not an escalation. It is still the publisher's identity executing text the
 *     publisher never wrote, and the audit entry would name their application
 *     for it. It is also the case the consent gate cannot catch on its own: the
 *     gate is keyed by SOURCE, and edited text matches no stored module, so the
 *     backend reads it as an ad-hoc run and allows it. Identity is what knows
 *     better, and identity is only known here.
 *
 * FAILS CLOSED on a caller that cannot say what the store holds: for a
 * distributed record "I don't know whether this is the published text" is not a
 * reason to run it.
 */
export function editedDistributedRunRefusal(entry: {
  name: string;
  source: string;
  sourcePackage?: string | null;
  storedSource: string | null;
}): string | null {
  const packageName = macroProvenanceTag(entry.sourcePackage);
  if (packageName === null) return null;
  if (entry.storedSource === null) {
    return (
      `"${entry.name}" arrived in the application "${packageName}", and the version ` +
      "this workbook stores could not be established — so there is no way to tell " +
      "whether this is that application's code or something else. It was not run."
    );
  }
  if (entry.storedSource === entry.source) return null;
  return describeForkRequirement(packageName, entry.name);
}

/**
 * Run a stored macro module, in whichever runtime its source is written for.
 *
 * Both branches return the SAME shape, so the caller has one success path and
 * one failure path. The object-script branch has no cell counter (the broker
 * does not tally writes), so it reports what it does know rather than inventing
 * a number: `cellsModified: -1` means "not measured", and the dialog prints the
 * elapsed time instead of a count. An invented "0 cell(s) changed" on a macro
 * that changed three cells is precisely the lie this feature kept telling.
 */
export async function runMacroModule(entry: {
  id: string;
  name: string;
  source: string;
  /** The stored description, i.e. where the runtime marker lives. */
  description: string | null;
  /** The application this module arrived in; null/absent for the user's own. */
  sourcePackage?: string | null;
  /**
   * The bytes the STORE holds for this record, so an edited buffer can be told
   * from the published artifact. Required — see `editedDistributedRunRefusal`.
   */
  storedSource: string | null;
}): Promise<ScriptRunResult> {
  const refusal = editedDistributedRunRefusal(entry);
  if (refusal) {
    return { type: "error", message: refusal, output: [] };
  }

  // NEITHER BRANCH DECIDES CONSENT, AND BOTH ARE SUBJECT TO IT. The route comes
  // from the module's description — publisher content — so it must not be able
  // to select a weaker protection. `run_script` calls
  // `require_distributed_module_consent`; `runObjectScriptOnce` reaches the SAME
  // decision through the mount boundary, which asks
  // `check_distributed_mount_consent` — that command runs
  // `require_distributed_module_consent` verbatim AND adds the application-level
  // question a composed realm source can be judged on. Nothing is asserted here
  // on either side.
  if (macroRunRoute(entry.description) === "moduleRuntime") {
    return runWorkbookScript(entry.source, `${entry.id}.js`);
  }

  const started = Date.now();
  try {
    await runObjectScriptOnce({
      name: entry.name,
      source: entry.source,
      // The stored record this run IS. Without it a run of the EDITED text of a
      // distributed macro would match nothing in the store by content, and the
      // runner would have no way to know whose code it is.
      scriptId: entry.id,
      objectType: "workbook",
      instanceId: null,
      accessLevel: macroRunAccessLevel(entry.sourcePackage),
      idPrefix: `macro_${entry.id}`,
    });
  } catch (e) {
    return {
      type: "error",
      message: e instanceof Error ? e.message : String(e),
      output: [],
    };
  }
  return {
    type: "success",
    output: [],
    cellsModified: -1,
    durationMs: Date.now() - started,
    screenUpdating: true,
  };
}

/**
 * Run a macro by its module id — the implementation behind the
 * @api/macroRunService seam that a macro-LINKED button resolves on each click.
 *
 * This is the whole point of "link, not copy": the macro is loaded HERE, at
 * click time, so a button always runs the macro's CURRENT source with no re-save
 * of the button. It reuses the identical `runMacroModule` path Developer ▸
 * Macros… ▸ Run uses — one execution path, one set of guarantees.
 *
 * Three outcomes, all explicit, none silent:
 *   - `notFound`  the id is not in the workbook script store. The button links a
 *                 macro that was deleted, or a .calp arrived without it. This is
 *                 the orphan case the whole feature has fought to make loud.
 *   - `failed`    the macro exists but could not be read or its code threw.
 *   - `ran`       it completed.
 */
export async function runMacroByRef(macroId: string): Promise<MacroRunOutcome> {
  // Existence check first, so a MISSING macro (orphan link) is distinguished
  // from a macro that exists but fails to load — get_script cannot tell those
  // apart (both surface as an error), and the caller voices them differently.
  const summaries = await listWorkbookScripts();
  const summary = summaries.find((s) => s.id === macroId);
  if (!summary) return { status: "notFound", macroId };

  let record: Awaited<ReturnType<typeof getWorkbookScript>>;
  try {
    record = await getWorkbookScript(macroId);
  } catch (e) {
    // Listed but unreadable: not "gone", so a failure rather than notFound.
    return {
      status: "failed",
      name: summary.name,
      message: e instanceof Error ? e.message : String(e),
    };
  }

  let result: ScriptRunResult;
  try {
    result = await runMacroModule({
      id: record.id,
      name: record.name,
      source: record.source,
      description: record.description ?? null,
      // A button on a distributed report's sheet resolves its macro HERE, at
      // click time. The record's own provenance travels with it, so clicking a
      // publisher's button cannot ask for a tier the publisher never earned.
      sourcePackage: record.sourcePackage ?? null,
      // A link runs the STORED module, so the stored text and the text being
      // run are the same read of the same record — never an edited buffer.
      storedSource: record.source,
    });
  } catch (e) {
    return {
      status: "failed",
      name: record.name,
      message: e instanceof Error ? e.message : String(e),
    };
  }

  if (result.type === "error") {
    return { status: "failed", name: record.name, message: result.message };
  }
  return { status: "ran", name: record.name };
}
