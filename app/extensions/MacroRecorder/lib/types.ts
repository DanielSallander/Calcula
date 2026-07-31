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

/** Everything the recorder can observe. */
export type RecordedEvent = RecordedGridEvent | RecordedCommandEvent;

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

/** How the generated body is packaged. */
export type MacroWrapper =
  /** A standalone `async function name(api) { … }` to paste anywhere. */
  | "bare"
  /** The bare function plus a `setup(button)` that runs it on click. */
  | "buttonScript"
  /** Top-level statements for one notebook cell. */
  | "notebookCell";

/** A session's status, as the UI shows it. */
export type RecordingStatus = "idle" | "recording" | "paused";
