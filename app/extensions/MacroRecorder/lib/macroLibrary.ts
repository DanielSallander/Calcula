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
// The library must therefore know which it is holding, and saying so out loud
// ("attach it to a button") beats offering a Run button that always fails. The
// marker rides in the module's `description`, which round-trips through
// save/get and is visible to the user in the same breath.

import {
  deleteWorkbookScript,
  getWorkbookScript,
  listWorkbookScripts,
  runWorkbookScript,
  saveWorkbookScript,
} from "@api";
import type { ScriptRunResult } from "@api";
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

const RUNTIME_MARKER = /\bruntime=(objectScript|notebook)\b/;

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
 */
export function parseMacroRuntime(
  description: string | null | undefined,
): MacroRuntime | null {
  if (typeof description !== "string") return null;
  const match = RUNTIME_MARKER.exec(description);
  return match ? (match[1] as MacroRuntime) : null;
}

/** Whether a stored module can be executed by the module runtime (`run_script`). */
export function isModuleRunnable(description: string | null | undefined): boolean {
  return parseMacroRuntime(description) !== "objectScript";
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
  /** The recorder runtime marker, or null for a module the recorder did not write. */
  runtime: MacroRuntime | null;
  /** Whether `runModule` can execute it (see isModuleRunnable). */
  runnable: boolean;
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

/** Every module in the workbook, with its runtime marker resolved. */
export async function listMacroModules(): Promise<MacroModuleEntry[]> {
  const summaries = await listWorkbookScripts();
  const entries: MacroModuleEntry[] = [];
  for (const summary of summaries) {
    let description: string | null = null;
    try {
      description = (await getWorkbookScript(summary.id)).description ?? null;
    } catch {
      // A module whose source cannot be read is still listed — hiding it would
      // be the invisible-code failure again, just with a different cause.
    }
    entries.push({
      id: summary.id,
      name: summary.name,
      description,
      runtime: parseMacroRuntime(description),
      runnable: isModuleRunnable(description),
    });
  }
  return entries;
}

/** Load one module's full record. */
export async function loadMacroModule(id: string) {
  return getWorkbookScript(id);
}

/** Overwrite a module's name/source in place (rename and edit are the same
 *  write — `save_script` is keyed by id). */
export async function updateMacroModule(options: {
  id: string;
  name: string;
  source: string;
  description: string | null;
}): Promise<void> {
  await saveWorkbookScript({
    id: options.id,
    name: options.name,
    description: options.description,
    source: options.source,
    scope: { type: "workbook" },
  });
}

/** Delete a module. */
export async function deleteMacroModule(id: string): Promise<void> {
  await deleteWorkbookScript(id);
}

/** Run a module in the QuickJS module runtime. */
export async function runMacroModule(entry: {
  id: string;
  name: string;
  source: string;
}): Promise<ScriptRunResult> {
  return runWorkbookScript(entry.source, `${entry.id}.js`);
}
