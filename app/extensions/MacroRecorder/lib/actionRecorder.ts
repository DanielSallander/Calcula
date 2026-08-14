//! FILENAME: app/extensions/MacroRecorder/lib/actionRecorder.ts
// PURPOSE: The recording session — turns the two @api observation hooks into an
//          ordered RecordedAction list, and exposes a tiny subscribable store so
//          the status-bar indicator and the dialogs can render its state.
// CONTEXT: Installed only while recording. Stopping uninstalls both hooks, so
//          the not-recording app pays a single null check per write/command.
//
// TWO SOURCES, ONE TIMELINE
//   * The IPC bridge (setGridRecorderHook) reports operations with explicit
//     coordinates — that is what a replayable macro needs.
//   * The command registry (setCommandRecorderHook) reports command dispatches,
//     which is the only way to see an extension's action at all.
//
// Most CoreCommands end up calling the bridge, so recording BOTH would replay
// the action twice. The rule is therefore: a command whose effects reach the
// bridge is not recorded (the bridge event is strictly better); any other
// command IS recorded, and the bridge is suppressed for its duration so its
// internal writes do not double up on top of it.

import { getActiveSheet, setGridRecorderHook } from "@api/lib";
import { setCommandRecorderHook, type CommandRecordPhase } from "@api/commands";
import {
  AppEvents,
  onAppEvent,
  listenTauriEvent,
  MACRO_MODEL_EDIT_EVENT,
  MACRO_MODEL_BATCH_EVENT,
} from "@api";
import { macroRecorderBackend } from "./macroRecorderBackend";
import type {
  RecordedAction,
  RecordedEvent,
  RecordedModelEditEvent,
  RecordingStatus,
} from "./types";

// ============================================================================
// Model-edit capture (raw Tauri events from bi/macro_capture.rs)
// ============================================================================

/** `macro:model-edit` payload — a captured model mutation, or an undo/redo
 *  session-editing marker. Mirrors Rust `RecordedModelEditPayload`. */
interface ModelEditCapture {
  connectionId: string;
  kind: string;
  action: "upsert" | "delete" | "undo" | "redo";
  name?: string;
  payload?: Record<string, unknown>;
  replayable: boolean;
  reason?: string;
}

/** `macro:model-batch` payload — a trusted batch boundary (the CLI's atomic
 *  runs). Mirrors Rust `RecordedModelBatchPayload`. */
interface ModelBatchCapture {
  connectionId: string;
  action: "begin" | "end" | "cancel";
}

const isModelEvent = (e: RecordedEvent): boolean => e.kind === "modelEdit";
const isGridOrCommandEvent = (e: RecordedEvent): boolean => e.kind !== "modelEdit";

// ============================================================================
// Command classification
// ============================================================================

/**
 * Commands whose effects arrive at the IPC bridge with explicit arguments.
 *
 * Every CoreCommand qualifies: clipboard/paste and fill land in
 * updateCellsBatch / fillRange, the clear family in clearRange, the structural
 * family in insertRows/deleteColumns/..., merge in mergeCells, and the
 * format-dialog commands in applyFormatting. Recording the ambient command
 * instead would produce a macro that acts on the replay-time selection.
 */
function isBridgeCaptured(commandId: string): boolean {
  return commandId.startsWith("core.");
}

/** Commands that are never worth recording (the recorder's own UI, the dev-only
 *  test harness). Neither recorded nor suppressed. */
function isIgnored(commandId: string): boolean {
  return commandId.startsWith("macroRecorder.") || commandId.startsWith("test.");
}

/** Undo/redo are gestures that EDIT the recording, not actions to replay. */
const UNDO_COMMAND = "core.edit.undo";
const REDO_COMMAND = "core.edit.redo";

// ============================================================================
// Store
// ============================================================================

/** What the UI renders. Replaced (never mutated) so useSyncExternalStore works. */
export interface RecorderSnapshot {
  status: RecordingStatus;
  /** Number of actions captured so far. */
  actionCount: number;
  /** Name the session was started with. */
  name: string;
  /** Epoch ms the session started, or null when idle. */
  startedAt: number | null;
}

const IDLE: RecorderSnapshot = {
  status: "idle",
  actionCount: 0,
  name: "",
  startedAt: null,
};

let snapshot: RecorderSnapshot = IDLE;
const listeners = new Set<() => void>();

function setSnapshot(next: RecorderSnapshot): void {
  snapshot = next;
  for (const l of listeners) {
    try {
      l();
    } catch (e) {
      console.error("[MacroRecorder] listener failed", e);
    }
  }
}

export function subscribeToRecorder(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getRecorderSnapshot(): RecorderSnapshot {
  return snapshot;
}

// ============================================================================
// Session state
// ============================================================================

let actions: RecordedAction[] = [];
/** Actions removed by an undo, waiting for a redo to put them back. The index
 *  remembers where the action sat so a redo can reinsert it in place (grid
 *  undo skips model events and vice versa, so pops are not always the tail). */
let undone: Array<{ action: RecordedAction; index: number }> = [];
let seq = 0;
let activeSheet = 0;
/** >0 while a recorded command owns the timeline (bridge events suppressed). */
let commandDepth = 0;
let cleanups: Array<() => void> = [];
/** Where each connection's open trusted model batch began (action index), so
 *  a batch CANCEL can drop the rolled-back model edits from the recording. */
let modelBatchStart = new Map<string, number>();
/** Connection id -> display name, prefetched at install for codegen comments. */
let connectionNames = new Map<string, string>();

function publish(): void {
  setSnapshot({ ...snapshot, actionCount: actions.length });
}

function pushAction(event: RecordedEvent): void {
  seq += 1;
  actions.push({ seq, sheetIndex: activeSheet, event });
  // A new action invalidates the redo stack, exactly like an edit after an undo.
  undone = [];
  publish();
}

// ============================================================================
// Hooks
// ============================================================================

function onGridEvent(event: RecordedEvent): void {
  if (snapshot.status !== "recording") return;

  // The sheet marker must update the tracker BEFORE the action is pushed, so
  // the action carries the sheet it switches TO. Otherwise the generated
  // prologue would activate the sheet the user just left.
  if (event.kind === "activateSheet") {
    activeSheet = event.index;
    pushAction(event);
    return;
  }

  if (commandDepth > 0) return; // owned by a recorded command
  pushAction(event);
}

function onCommand(
  commandId: string,
  phase: CommandRecordPhase,
  args?: unknown,
): void {
  if (snapshot.status !== "recording") return;
  if (isIgnored(commandId)) return;

  if (commandId === UNDO_COMMAND) {
    if (phase === "after") popAction();
    return;
  }
  if (commandId === REDO_COMMAND) {
    if (phase === "after") unpopAction();
    return;
  }

  if (isBridgeCaptured(commandId)) return;

  if (phase === "before") {
    commandDepth += 1;
    return;
  }
  // Any terminal phase closes the scope exactly once.
  commandDepth = Math.max(0, commandDepth - 1);
  if (phase === "after") {
    pushAction({ kind: "command", commandId, args: serializableArgs(args) });
  }
}

/** Keep only args that survive a JSON round-trip — anything else could not be
 *  emitted into the generated source anyway. */
function serializableArgs(args: unknown): unknown {
  if (args === undefined) return undefined;
  try {
    const json = JSON.stringify(args);
    return json === undefined ? undefined : JSON.parse(json);
  } catch {
    return undefined;
  }
}

function onModelEdit(e: ModelEditCapture): void {
  if (snapshot.status !== "recording") return;

  // The Model Editor's Undo/Redo edit the recording, mirroring grid Ctrl+Z —
  // but each one touches only its own kind of action (see popLastMatching).
  if (e.action === "undo") {
    popLastMatching(isModelEvent);
    return;
  }
  if (e.action === "redo") {
    unpopLastMatching(isModelEvent);
    return;
  }

  // A recorded command owns the timeline: its handler's model edits would
  // otherwise double up on top of the replayed command.
  if (commandDepth > 0) return;

  const event: RecordedModelEditEvent = {
    kind: "modelEdit",
    connectionId: e.connectionId,
    connectionName: connectionNames.get(e.connectionId),
    modelKind: e.kind,
    action: e.action,
    name: e.name,
    payload: e.payload,
    replayable: e.replayable,
    reason: e.reason,
  };
  pushAction(event);
}

function onModelBatch(e: ModelBatchCapture): void {
  if (snapshot.status !== "recording") return;
  switch (e.action) {
    case "begin":
      modelBatchStart.set(e.connectionId, actions.length);
      return;
    case "end":
      modelBatchStart.delete(e.connectionId);
      return;
    case "cancel": {
      // The batch rolled back: its model edits never happened, so they must
      // not replay. Grid actions interleaved into the window (other-window
      // edits) are kept — only this connection's model edits go.
      const start = modelBatchStart.get(e.connectionId);
      modelBatchStart.delete(e.connectionId);
      if (start === undefined) return;
      actions = actions.filter(
        (a, i) =>
          i < start ||
          a.event.kind !== "modelEdit" ||
          a.event.connectionId !== e.connectionId,
      );
      publish();
      return;
    }
  }
}

// ============================================================================
// Undo / redo of the RECORDING
// ============================================================================

/**
 * A user who mistypes mid-recording presses Ctrl+Z. Recording the undo and
 * replaying it would be absurd, and leaving the mistake in is worse — so the
 * undo removes the last recorded action instead, and a redo puts it back.
 *
 * TWO UNDO SYSTEMS, TWO FILTERS. Grid Ctrl+Z never touches the model undo
 * stack and the Model Editor's Undo never touches the grid's, so each pop
 * removes the last action OF ITS OWN KIND — otherwise a grid undo performed
 * after a model edit would silently delete the model action from the
 * recording while leaving the actually-undone grid action in. (Which recorded
 * action a model undo restores is still a heuristic when the user undoes a
 * multi-edit batch — documented limitation, same class as the grid one.)
 */
function popLastMatching(matches: (e: RecordedEvent) => boolean): void {
  for (let i = actions.length - 1; i >= 0; i--) {
    if (!matches(actions[i].event)) continue;
    const [removed] = actions.splice(i, 1);
    undone.push({ action: removed, index: i });
    // Sheet markers move the tracker, so undoing one must move it back.
    if (removed.event.kind === "activateSheet") {
      activeSheet = lastKnownSheet();
    }
    publish();
    return;
  }
}

function unpopLastMatching(matches: (e: RecordedEvent) => boolean): void {
  for (let i = undone.length - 1; i >= 0; i--) {
    if (!matches(undone[i].action.event)) continue;
    const [{ action, index }] = undone.splice(i, 1);
    actions.splice(Math.min(index, actions.length), 0, action);
    if (action.event.kind === "activateSheet") {
      activeSheet = action.event.index;
    }
    publish();
    return;
  }
}

function popAction(): void {
  popLastMatching(isGridOrCommandEvent);
}

function unpopAction(): void {
  unpopLastMatching(isGridOrCommandEvent);
}

/** The sheet the timeline is on after the most recent surviving action. */
function lastKnownSheet(): number {
  for (let i = actions.length - 1; i >= 0; i--) {
    const e = actions[i].event;
    if (e.kind === "activateSheet") return e.index;
  }
  return actions.length > 0 ? actions[0].sheetIndex : activeSheet;
}

// ============================================================================
// Lifecycle
// ============================================================================

function installHooks(): void {
  setGridRecorderHook(onGridEvent);
  setCommandRecorderHook(onCommand);

  // The active sheet can also change without going through setActiveSheet
  // (next/previous sheet, an undo that restores a sheet, a script). The app
  // event is the authoritative "which sheet are we on now" signal, and keeping
  // the tracker on it is what lets a recording survive sheet switches.
  const off = onAppEvent<{ sheetIndex?: number }>(
    AppEvents.SHEET_CHANGED,
    (detail) => {
      if (typeof detail?.sheetIndex === "number") activeSheet = detail.sheetIndex;
    },
  );
  cleanups.push(off);

  // Model-edit capture: arm the Rust hook (best-effort — a failed arm means
  // model edits silently don't record, so surface it in the console) and
  // subscribe to the main-window-targeted capture events.
  void macroRecorderBackend
    .invoke("macro_model_recording_set_armed", { armed: true })
    .catch((e) => console.error("[MacroRecorder] failed to arm model capture", e));
  const unlistenEdit = listenTauriEvent<ModelEditCapture>(
    MACRO_MODEL_EDIT_EVENT,
    onModelEdit,
  );
  const unlistenBatch = listenTauriEvent<ModelBatchCapture>(
    MACRO_MODEL_BATCH_EVENT,
    onModelBatch,
  );
  cleanups.push(() => void unlistenEdit.then((un) => un()));
  cleanups.push(() => void unlistenBatch.then((un) => un()));

  // Connection display names, for codegen comments only (replay uses ids).
  // Best-effort: a name that cannot be resolved simply stays out of comments.
  void macroRecorderBackend
    .invoke<Array<{ id: string; name: string }>>("bi_get_connections", {})
    .then((list) => {
      connectionNames = new Map(list.map((c) => [c.id, c.name]));
    })
    .catch(() => {});
}

function uninstallHooks(): void {
  setGridRecorderHook(null);
  setCommandRecorderHook(null);
  void macroRecorderBackend
    .invoke("macro_model_recording_set_armed", { armed: false })
    .catch(() => {});
  for (const fn of cleanups) {
    try {
      fn();
    } catch (e) {
      console.error("[MacroRecorder] cleanup failed", e);
    }
  }
  cleanups = [];
  commandDepth = 0;
  modelBatchStart = new Map();
}

/** Begin a recording. Resolves once the starting sheet is known. */
export async function startRecording(name: string): Promise<void> {
  if (snapshot.status !== "idle") {
    throw new Error("A recording is already in progress.");
  }
  actions = [];
  undone = [];
  seq = 0;
  commandDepth = 0;
  try {
    activeSheet = await getActiveSheet();
  } catch {
    // A failed read must not block recording; sheet 0 is the safe assumption
    // and the first sheet switch corrects it.
    activeSheet = 0;
  }
  setSnapshot({
    status: "recording",
    actionCount: 0,
    name,
    startedAt: Date.now(),
  });
  installHooks();
}

/** Stop recording and hand back what was captured. */
export function stopRecording(): RecordedAction[] {
  if (snapshot.status === "idle") return [];
  uninstallHooks();
  const captured = actions;
  actions = [];
  undone = [];
  setSnapshot(IDLE);
  return captured;
}

/** Abandon the recording; nothing is returned and nothing is kept. */
export function cancelRecording(): void {
  if (snapshot.status === "idle") return;
  uninstallHooks();
  actions = [];
  undone = [];
  setSnapshot(IDLE);
}

/** Stop capturing without ending the session (the user needs to do something
 *  that should not be part of the macro). */
export function pauseRecording(): void {
  if (snapshot.status !== "recording") return;
  setSnapshot({ ...snapshot, status: "paused" });
}

/** Resume capturing after a pause. */
export function resumeRecording(): void {
  if (snapshot.status !== "paused") return;
  commandDepth = 0; // a command that spanned the pause no longer owns anything
  setSnapshot({ ...snapshot, status: "recording" });
}

/** The actions captured so far (a copy; safe to hand to the generator). */
export function getRecordedActions(): RecordedAction[] {
  return actions.slice();
}

/** Test seam: drop all session state and uninstall any hooks. */
export function resetRecorderForTests(): void {
  uninstallHooks();
  actions = [];
  undone = [];
  seq = 0;
  activeSheet = 0;
  modelBatchStart = new Map();
  connectionNames = new Map();
  setSnapshot(IDLE);
}

/** Test seams for the model-capture handlers (the Tauri event plumbing cannot
 *  run under vitest; tests drive the handlers directly). */
export const modelCaptureForTests = {
  onModelEdit,
  onModelBatch,
  setConnectionNames(names: Map<string, string>): void {
    connectionNames = names;
  },
};
