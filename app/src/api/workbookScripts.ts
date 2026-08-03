//! FILENAME: app/src/api/workbookScripts.ts
// PURPOSE: Public contract for the workbook script RUNTIME — listing, reading, and
//   running saved script modules.
// CONTEXT: Lets extensions (e.g. Controls, which runs scripts from button OnSelect)
//   use the script runtime WITHOUT importing the ScriptEditor extension's internals
//   (which route through a per-window channel only bound inside that extension /
//   the standalone editor window). These go straight through the gated backend door,
//   so they work in the main window regardless of which extensions are active.

import { invokeBackend, emitTauriEvent, listenTauriEvent } from "./backend";
import type { UnlistenFn } from "./backend";
import { getGridStateSnapshot } from "../core/state/GridContext";

/** Scope of a script: workbook-level or attached to a specific sheet. */
export type ScriptScope =
  | { type: "workbook" }
  | { type: "sheet"; name: string };

/** Lightweight script summary (id + name, no source). */
export interface ScriptSummary {
  id: string;
  name: string;
  scope?: ScriptScope;
}

/** A saved script module, including its source. */
export interface WorkbookScript {
  id: string;
  name: string;
  /** Free-text note shown beside the module in listings. Mirrors Rust's
   *  `Option<String>`, which has NO serde default — the field must be present
   *  (null is fine) on every save or deserialization rejects the payload. */
  description: string | null;
  source: string;
  scope?: ScriptScope;
  /** The .calp package this module arrived in; absent/null for local scripts. */
  sourcePackage?: string | null;
}

// ============================================================================
// Script side effects (deferred actions + bookmark mutations)
// ============================================================================

/**
 * A UI action a script queued while it ran, for the host to apply AFTER the run
 * completes. Mirrors `DeferredAction` in core/script-engine/src/types.rs
 * (`#[serde(tag = "action")]`, variant names camelCased).
 *
 * WIRE SHAPE: the Rust enum carries `rename_all = "camelCase"` on the container
 * AND on every struct variant — the container attribute alone renames variant
 * NAMES only, not their fields. So the whole payload arrives camelCased and
 * this union is a literal mirror; `normalizeDeferredActions()` only validates.
 */
export type DeferredAction =
  | { action: "goto"; row: number; col: number; sheetIndex: number; select: boolean }
  | { action: "calculate" }
  | { action: "activateSheet"; sheetIndex: number }
  | { action: "setStatusBar"; message: string | null }
  | { action: "setDisplayZeros"; value: boolean }
  | { action: "setViewMode"; mode: string }
  | { action: "setZoom"; percent: number }
  | { action: "setReferenceStyle"; style: string }
  | { action: "setDisplayGridlines"; value: boolean }
  | { action: "setDisplayHeadings"; value: boolean }
  | { action: "fillDown"; startRow: number; startCol: number; endRow: number; endCol: number }
  | { action: "fillRight"; startRow: number; startCol: number; endRow: number; endCol: number }
  | { action: "applyNamedStyle"; name: string; row: number; col: number }
  | { action: "setScrollArea"; area: string | null }
  | {
      action: "setIterationSettings";
      enabled: boolean;
      maxIterations: number;
      maxChange: number;
    }
  | { action: "setSheetVisibility"; sheetIndex: number; visibility: string };

/**
 * A bookmark mutation a script queued, for the host to apply after the run.
 * Mirrors `BookmarkMutation` in core/script-engine/src/types.rs, camelCase on
 * the wire for the same reason — validate with `normalizeBookmarkMutations()`.
 */
export type BookmarkMutation =
  | {
      action: "addCellBookmark";
      row: number;
      col: number;
      sheetIndex: number;
      label: string | null;
      color: string | null;
    }
  | { action: "removeCellBookmark"; row: number; col: number; sheetIndex: number }
  | {
      action: "createViewBookmark";
      label: string;
      color: string | null;
      dimensionsJson: string | null;
    }
  | { action: "deleteViewBookmark"; id: string }
  | { action: "activateViewBookmark"; id: string };

/** Window event carrying `DeferredAction[]`; applied by the ScriptNotebook host. */
export const SCRIPT_DEFERRED_ACTIONS_EVENT = "script:deferred-actions";

/** Window event carrying `BookmarkMutation[]`; applied by the CellBookmarks host. */
export const SCRIPT_BOOKMARK_MUTATIONS_EVENT = "script:bookmark-mutations";

/** The two side-effect queues a script run can return. */
export interface ScriptSideEffects {
  deferredActions?: DeferredAction[];
  bookmarkMutations?: BookmarkMutation[];
}

/**
 * Broadcast a completed run's side effects to whichever extension owns them.
 * Bookmark mutations go first: they can restore a saved view (scroll/zoom), so a
 * `goto` queued in the same run must win, and deferred actions run last.
 * Listeners re-validate the payload — see the normalize* helpers.
 */
export function dispatchScriptSideEffects(effects: ScriptSideEffects): void {
  const mutations = effects.bookmarkMutations;
  if (Array.isArray(mutations) && mutations.length > 0) {
    window.dispatchEvent(
      new CustomEvent(SCRIPT_BOOKMARK_MUTATIONS_EVENT, { detail: mutations }),
    );
  }
  const actions = effects.deferredActions;
  if (Array.isArray(actions) && actions.length > 0) {
    window.dispatchEvent(
      new CustomEvent(SCRIPT_DEFERRED_ACTIONS_EVENT, { detail: actions }),
    );
  }
}

// ---- Wire normalization ----------------------------------------------------

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** Nullable string field: absent/null/non-string all collapse to null. */
function nullableStr(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Validate one raw deferred action off the wire. Returns null (and warns) when
 * the payload is unusable, so one malformed entry cannot poison the queue.
 */
function normalizeDeferredAction(raw: unknown): DeferredAction | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  switch (r.action) {
    case "goto": {
      const row = num(r.row);
      const col = num(r.col);
      if (row === undefined || col === undefined) return null;
      // NaN = "no sheet given"; the host then stays on the current sheet.
      const sheetIndex = num(r.sheetIndex);
      return {
        action: "goto",
        row,
        col,
        sheetIndex: sheetIndex === undefined ? Number.NaN : sheetIndex,
        select: bool(r.select) ?? true,
      };
    }
    case "calculate":
      return { action: "calculate" };
    case "activateSheet": {
      const sheetIndex = num(r.sheetIndex);
      return sheetIndex === undefined ? null : { action: "activateSheet", sheetIndex };
    }
    case "setStatusBar":
      return { action: "setStatusBar", message: nullableStr(r.message) };
    case "setDisplayZeros": {
      const value = bool(r.value);
      return value === undefined ? null : { action: "setDisplayZeros", value };
    }
    case "setViewMode": {
      const mode = str(r.mode);
      return mode === undefined ? null : { action: "setViewMode", mode };
    }
    case "setZoom": {
      const percent = num(r.percent);
      return percent === undefined ? null : { action: "setZoom", percent };
    }
    case "setReferenceStyle": {
      const style = str(r.style);
      return style === undefined ? null : { action: "setReferenceStyle", style };
    }
    case "setDisplayGridlines": {
      const value = bool(r.value);
      return value === undefined ? null : { action: "setDisplayGridlines", value };
    }
    case "setDisplayHeadings": {
      const value = bool(r.value);
      return value === undefined ? null : { action: "setDisplayHeadings", value };
    }
    case "fillDown":
    case "fillRight": {
      const startRow = num(r.startRow);
      const startCol = num(r.startCol);
      const endRow = num(r.endRow);
      const endCol = num(r.endCol);
      if (
        startRow === undefined ||
        startCol === undefined ||
        endRow === undefined ||
        endCol === undefined
      ) {
        return null;
      }
      return { action: r.action, startRow, startCol, endRow, endCol };
    }
    case "applyNamedStyle": {
      const name = str(r.name);
      const row = num(r.row);
      const col = num(r.col);
      if (!name || row === undefined || col === undefined) return null;
      return { action: "applyNamedStyle", name, row, col };
    }
    case "setScrollArea":
      return { action: "setScrollArea", area: nullableStr(r.area) };
    case "setIterationSettings": {
      const enabled = bool(r.enabled);
      const maxIterations = num(r.maxIterations);
      const maxChange = num(r.maxChange);
      if (enabled === undefined || maxIterations === undefined || maxChange === undefined) {
        return null;
      }
      return { action: "setIterationSettings", enabled, maxIterations, maxChange };
    }
    case "setSheetVisibility": {
      const sheetIndex = num(r.sheetIndex);
      const visibility = str(r.visibility);
      if (sheetIndex === undefined || visibility === undefined) return null;
      return { action: "setSheetVisibility", sheetIndex, visibility };
    }
    default:
      console.warn("[scripts] Unknown deferred action:", r.action);
      return null;
  }
}

/** Validate a raw deferred-action array off the wire, dropping unusable entries. */
export function normalizeDeferredActions(raw: unknown): DeferredAction[] {
  if (!Array.isArray(raw)) return [];
  const actions: DeferredAction[] = [];
  for (const item of raw) {
    const action = normalizeDeferredAction(item);
    if (action) actions.push(action);
  }
  return actions;
}

/** Validate one raw bookmark mutation off the wire. Returns null when unusable. */
function normalizeBookmarkMutation(raw: unknown): BookmarkMutation | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  switch (r.action) {
    case "addCellBookmark":
    case "removeCellBookmark": {
      const row = num(r.row);
      const col = num(r.col);
      const sheetIndex = num(r.sheetIndex);
      if (row === undefined || col === undefined) return null;
      const resolvedSheet = sheetIndex === undefined ? Number.NaN : sheetIndex;
      if (r.action === "removeCellBookmark") {
        return { action: "removeCellBookmark", row, col, sheetIndex: resolvedSheet };
      }
      return {
        action: "addCellBookmark",
        row,
        col,
        sheetIndex: resolvedSheet,
        label: nullableStr(r.label),
        color: nullableStr(r.color),
      };
    }
    case "createViewBookmark": {
      const label = str(r.label);
      if (!label) return null;
      return {
        action: "createViewBookmark",
        label,
        color: nullableStr(r.color),
        dimensionsJson: nullableStr(r.dimensionsJson),
      };
    }
    case "deleteViewBookmark":
    case "activateViewBookmark": {
      const id = str(r.id);
      if (!id) return null;
      return { action: r.action, id };
    }
    default:
      console.warn("[scripts] Unknown bookmark mutation:", r.action);
      return null;
  }
}

/** Validate a raw bookmark-mutation array off the wire, dropping unusable entries. */
export function normalizeBookmarkMutations(raw: unknown): BookmarkMutation[] {
  if (!Array.isArray(raw)) return [];
  const mutations: BookmarkMutation[] = [];
  for (const item of raw) {
    const mutation = normalizeBookmarkMutation(item);
    if (mutation) mutations.push(mutation);
  }
  return mutations;
}

/** Successful script run. Mirrors `RunScriptResponse::Success` (Rust). */
export interface ScriptRunSuccess {
  type: "success";
  output: string[];
  cellsModified: number;
  durationMs: number;
  /** Bookmark mutations the script queued (omitted by Rust when empty). */
  bookmarkMutations?: BookmarkMutation[];
  /** Deferred UI actions the script queued (omitted by Rust when empty). */
  deferredActions?: DeferredAction[];
  /** Application.screenUpdating value at end of script. */
  screenUpdating: boolean;
}

/** Failed script run. */
export interface ScriptRunError {
  type: "error";
  message: string;
  output: string[];
}

export type ScriptRunResult = ScriptRunSuccess | ScriptRunError;

/** List all saved workbook script modules (id + name only). */
export async function listWorkbookScripts(): Promise<ScriptSummary[]> {
  return invokeBackend<ScriptSummary[]>("list_scripts");
}

/** Get a single saved script module by id, including its source. */
export async function getWorkbookScript(id: string): Promise<WorkbookScript> {
  return invokeBackend<WorkbookScript>("get_script", { id });
}

/**
 * Create or replace a saved script module (keyed by `id`), and mark the
 * workbook modified.
 *
 * Marking is not optional bookkeeping: module scripts are persisted INSIDE the
 * .cala, and the backend's save path does not flag the document dirty for a
 * script write. Without this a macro auto-saved after recording would look
 * saved, and would be gone the next time the user closed a "clean" workbook —
 * the exact silent-loss failure the auto-save exists to prevent.
 */
export async function saveWorkbookScript(script: WorkbookScript): Promise<void> {
  await invokeBackend<void>("save_script", {
    script: {
      id: script.id,
      name: script.name,
      description: script.description ?? null,
      source: script.source,
      scope: script.scope ?? { type: "workbook" },
      ...(script.sourcePackage ? { sourcePackage: script.sourcePackage } : {}),
    },
  });
  announceWorkbookScriptsChanged({ id: script.id, change: "saved" });
  const { markFileModified } = await import("./filesystem");
  await markFileModified();
}

/**
 * Delete a saved script module by id.
 *
 * The backend refuses reserved `__calcula_`-prefixed records (internal data
 * stores such as the Custom Functions library, which reuse the script map for
 * storage but are not user code).
 */
export async function deleteWorkbookScript(id: string): Promise<void> {
  await invokeBackend<void>("delete_script", { id });
  announceWorkbookScriptsChanged({ id, change: "deleted" });
  const { markFileModified } = await import("./filesystem");
  await markFileModified();
}

// ============================================================================
// Module-script inventory
// ============================================================================
//
// WHY THIS LIVES IN @api AND NOT IN THE MACRO RECORDER. "What module scripts
// does this workbook hold?" is a Bridge on the Decision Matrix, not a feature:
// the Macro Recorder's library asks it, the Object Script Editor asks it (a
// recorded macro is a MODULE script, so the object-script store cannot answer),
// the code inventory asks it. Routing the editor's copy through the recorder
// would put one extension inside another's internals, which the Facade Rule
// forbids — and a macro-specific seam would be a second, narrower door onto the
// same store. There is one store; this is the one door onto it.

/**
 * One module script as an INVENTORY sees it: the summary plus the fields that
 * need the full record (`description`, `source`), and the read failure when the
 * record could not be read at all.
 *
 * A record that fails to load is still listed. Hiding it would be the
 * invisible-code failure this project exists to avoid — the user must be able to
 * see that code is there even when the app cannot show it — so the failure
 * travels WITH the entry instead of deleting it from the list.
 */
export interface WorkbookScriptRecord {
  id: string;
  name: string;
  description: string | null;
  /** Empty string when `loadError` is set — never a lie about what it holds. */
  source: string;
  scope?: ScriptScope;
  sourcePackage?: string | null;
  /** Why the record could not be READ, when it could not. */
  loadError: string | null;
}

/**
 * Every module script in the workbook, with its full record resolved.
 *
 * `list_scripts` returns id+name only, so this fans out to `get_script`. A
 * per-record failure is reported on that record rather than failing the whole
 * listing: one unreadable module must not make the other nine invisible.
 */
export async function listWorkbookScriptRecords(): Promise<WorkbookScriptRecord[]> {
  const summaries = await listWorkbookScripts();
  const records: WorkbookScriptRecord[] = [];
  for (const summary of summaries) {
    try {
      const record = await getWorkbookScript(summary.id);
      records.push({
        id: record.id,
        name: record.name,
        description: record.description ?? null,
        source: record.source,
        scope: record.scope,
        sourcePackage: record.sourcePackage ?? null,
        loadError: null,
      });
    } catch (e) {
      records.push({
        id: summary.id,
        name: summary.name,
        description: null,
        source: "",
        scope: summary.scope,
        sourcePackage: null,
        loadError: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return records;
}

/**
 * Which interpreter a stored module's source was written for, as recorded in its
 * `description`.
 *
 * THE MARKER IS A SHARED CONVENTION, not a private one: the Macro Recorder
 * WRITES it and every editor/library that lists modules READS it, so it is
 * defined once, here, on the record format itself. Two copies of this regex
 * would be two answers to "what runtime is this?".
 *
 *   notebook     -> synchronous `Calcula.*` in the Rust QuickJS module runtime
 *                   (what `run_script` executes).
 *   objectScript -> the async object-script `api`, which exists only inside a
 *                   mounted object-script realm.
 *
 * `null` means the module carries no marker at all — a hand-authored module,
 * which is QuickJS source by definition. It is NOT "assume objectScript".
 */
export type ModuleScriptRuntime = "notebook" | "objectScript";

const MODULE_SCRIPT_RUNTIME_MARKER = /\bruntime=(objectScript|notebook)\b/;

export function parseModuleScriptRuntime(
  description: string | null | undefined,
): ModuleScriptRuntime | null {
  if (typeof description !== "string") return null;
  const match = MODULE_SCRIPT_RUNTIME_MARKER.exec(description);
  return match ? (match[1] as ModuleScriptRuntime) : null;
}

// ============================================================================
// Change notification
// ============================================================================

/**
 * Cross-window event fired whenever a module script is created, replaced or
 * deleted through this module.
 *
 * A TAURI event, not an app event, because the surfaces that must react do not
 * all live in the main window: the standalone Object Script Editor is its own
 * webview, and a macro recorded (or deleted) in the main window has to reach the
 * list it is showing. It is emitted from the two write doors above, so no caller
 * has to remember to announce anything — recording a macro, renaming it, and
 * deleting it from the Macros dialog all notify by construction.
 */
export const WORKBOOK_SCRIPTS_CHANGED_EVENT = "workbook:module-scripts-changed";

export interface WorkbookScriptsChangedDetail {
  /** The module that changed. */
  id: string;
  change: "saved" | "deleted";
}

function announceWorkbookScriptsChanged(detail: WorkbookScriptsChangedDetail): void {
  // Fire and forget: the write already succeeded, and an environment with no
  // Tauri event bus (tests, the browser-only smoke harness) must not turn a
  // successful save into a thrown error.
  void emitTauriEvent(WORKBOOK_SCRIPTS_CHANGED_EVENT, detail).catch(() => {
    /* no event bus here; listeners simply refresh on their next natural trigger */
  });
}

/** Subscribe to module-script creations/replacements/deletions. */
export function onWorkbookScriptsChanged(
  callback: (detail: WorkbookScriptsChangedDetail) => void,
): Promise<UnlistenFn> {
  return listenTauriEvent<WorkbookScriptsChangedDetail>(
    WORKBOOK_SCRIPTS_CHANGED_EVENT,
    callback,
  );
}

/**
 * Handle the Script Security gate around a script run. When the level is "prompt"
 * the backend refuses with a SCRIPT_PROMPT_REQUIRED sentinel until the user
 * approves once for the session; this confirms, grants the session approval, and
 * retries. (Mirrors the ScriptEditor helper, but on the gated @api door.)
 */
async function withScriptSecurityPrompt<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("SCRIPT_PROMPT_REQUIRED")) {
      // AWAITED, deliberately: under Tauri `window.confirm` returns a PROMISE,
      // and a bare `if (window.confirm(...))` tests an object — always truthy —
      // so pressing Cancel granted the session approval anyway. This gate is the
      // whole of Script Security's "prompt" mode; it must fail CLOSED.
      const ok = await window.confirm(
        "This workbook wants to run a script.\n\n" +
        "Allow script execution for this session?\n" +
        "(Script Security is set to 'prompt'. Set it to 'enabled' or 'disabled' to stop asking.)",
      );
      if (ok) {
        await invokeBackend<void>("grant_script_session_approval");
        return run();
      }
    }
    throw err;
  }
}

/** Extra inputs for a script run (the bookmark collections the script can read). */
export interface RunWorkbookScriptOptions {
  /** Serialized cell bookmarks, so `Calcula.bookmarks.list()` sees them. */
  cellBookmarksJson?: string;
  /** Serialized view bookmarks, so `Calcula.bookmarks.listViews()` sees them. */
  viewBookmarksJson?: string;
}

/**
 * The view state the BACKEND does not own — it lives in the Core grid state, so
 * every script surface has to SEND it with the run. Mirrors `HostViewState`
 * (app/src-tauri/src/scripting/types.rs).
 */
export interface HostViewState {
  displayZeros: boolean;
  viewMode: string;
  /** Zoom FACTOR (1.0 = 100%), the unit `Calcula.getZoom()` reports. */
  zoom: number;
  displayHeadings: boolean;
}

/**
 * Snapshot the four view fields the backend cannot read for itself.
 *
 * Without this `Calcula.getZoom()` answered 1.0 on a 150%-zoomed workbook and
 * `getViewMode()` always said "normal" — getters that lie. Returns undefined
 * when the grid is not mounted (a background window), so the request simply
 * omits them and the engine defaults stand.
 */
export function currentHostViewState(): HostViewState | undefined {
  const state = getGridStateSnapshot();
  if (!state) return undefined;
  return {
    displayZeros: state.displayZeros,
    viewMode: state.viewMode,
    zoom: state.zoom,
    displayHeadings: state.displayHeadings,
  };
}

/**
 * Run a JavaScript source string in the isolated QuickJS script runtime against
 * the current workbook. Honors the Script Security level (refuses when "disabled",
 * confirms once per session when "prompt").
 *
 * A successful run's queued side effects (deferred UI actions + bookmark
 * mutations) are broadcast to the extensions that own them — without this every
 * `Application.goto` / `Calcula.bookmarks.*` call from a button or bookmark
 * script would be computed and then dropped.
 */
export async function runWorkbookScript(
  source: string,
  filename: string = "script.js",
  options: RunWorkbookScriptOptions = {},
): Promise<ScriptRunResult> {
  const result = await withScriptSecurityPrompt(() =>
    invokeBackend<ScriptRunResult>("run_script", {
      request: {
        source,
        filename,
        cellBookmarksJson: options.cellBookmarksJson,
        viewBookmarksJson: options.viewBookmarksJson,
        viewState: currentHostViewState(),
      },
    }),
  );
  if (result.type === "success") {
    dispatchScriptSideEffects(result);
  }
  return result;
}
