//! FILENAME: app/extensions/MacroRecorder/lib/types.ts
// PURPOSE: The recorded-action vocabulary shared by the recording session and
//          the (pure) code generator.
// CONTEXT: The session turns the two @api observation hooks — the IPC-bridge
//          hook (setGridRecorderHook) and the command hook
//          (setCommandRecorderHook) — into an ordered list of RecordedActions.
//          The generator turns that list into runnable script source. Keeping
//          the list in the middle is what makes the codegen a pure function and
//          therefore testable without a running app.

import type { RecordedGridEvent } from "@api/lib";

/**
 * A command dispatch that has no argument-bearing equivalent at the IPC bridge
 * (a third-party extension's command, typically). Replayed via
 * `api.executeCommand`, which — like the click that produced it — acts on
 * whatever the workbook state is at replay time.
 */
export interface RecordedCommandEvent {
  kind: "command";
  commandId: string;
  /** Handler arguments, if any. Only recorded when JSON-serializable. */
  args?: unknown;
}

/**
 * One captured BI-model mutation (measure/relationship/context/... edit),
 * observed via the armed-only Rust hook below every model install and
 * delivered on the `macro:model-edit` Tauri event. Replayed through the
 * consent-gated `caps.biModel` gateway; `payload` arrives GATEWAY-READY from
 * Rust (built beside the gateway's own field reads), so codegen embeds it
 * verbatim instead of maintaining a per-kind field mapping.
 */
export interface RecordedModelEditEvent {
  kind: "modelEdit";
  /** The BI connection the edit ran on (replay addresses it by this id). */
  connectionId: string;
  /** Display name resolved at capture time — comments only, never replay. */
  connectionName?: string;
  /** Gateway kind ("measure", "relationship", ...) for replayable edits; the
   *  raw diff domain ("table", "role", "bulk", ...) otherwise. */
  modelKind: string;
  action: "upsert" | "delete";
  /** The changed object's name (absent for privileged kinds — role names are
   *  themselves privileged). */
  name?: string;
  /** The `caps.biModel.upsert/delete` payload, embedded verbatim. Present
   *  only when `replayable`. */
  payload?: Record<string, unknown>;
  replayable: boolean;
  /** Why the edit cannot replay (privileged kind, bulk change, oversized). */
  reason?: string;
}

/** Everything the recorder can observe. */
export type RecordedEvent =
  | RecordedGridEvent
  | RecordedCommandEvent
  | RecordedModelEditEvent;

/** Narrow the bridge event union to one `kind` (keeps the codegen switch typed). */
export type RecordedGridEventOf<K extends RecordedGridEvent["kind"]> = Extract<
  RecordedGridEvent,
  { kind: K }
>;

/**
 * One observed action, in the order it happened.
 *
 * `sheetIndex` is the sheet that was ACTIVE when the action ran, tracked by the
 * session across sheet switches. Every bridge operation targets the active
 * sheet implicitly, so without this a macro recorded across two sheets would
 * replay entirely onto one.
 */
export interface RecordedAction {
  /** 1-based, monotonic within a session. */
  seq: number;
  sheetIndex: number;
  event: RecordedEvent;
}

/** Which script runtime the generated source is written for. */
export type MacroTarget =
  /** Object scripts (button/sheet/workbook `setup()`), unlocked tier. Async,
   *  and by far the wider surface: formatting, structure, sheets, find/replace. */
  | "objectScript"
  /** Notebook cells (the Rust QuickJS interpreter). Synchronous, and limited to
   *  the `Calcula.*` op set: values, sheets and fills only. */
  | "notebook";

/**
 * How the generated body is packaged.
 *
 * ONE object-script shape, not two. There used to be a "bare" variant (the
 * macro function and a COMMENT telling you how to call it) and a "buttonScript"
 * variant (the same function plus a click handler). The bare one was what got
 * stored, so the saved macro was a definition nothing ever invoked — pressing
 * Run defined a function and stopped. Two shapes for one recording is also two
 * things to keep in step; the surviving shape's `setup(context)` covers both
 * uses by asking the context what it is:
 *
 *   mounted on a BUTTON  -> `context.onClick` exists -> run on each click
 *   run on its own       -> no `onClick`             -> run immediately
 */
export type MacroWrapper =
  /** `async function name(api) { … }` plus the `setup(context)` that runs it. */
  | "objectScript"
  /** Top-level statements for one notebook cell. */
  | "notebookCell";

/** A session's status, as the UI shows it. */
export type RecordingStatus = "idle" | "recording" | "paused";
