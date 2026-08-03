//! FILENAME: app/extensions/MacroRecorder/lib/flow.ts
// PURPOSE: The record -> stop -> AUTO-SAVE -> review flow, and the small pieces
//          of state the dialogs need but cannot get from an ExtensionContext.
// CONTEXT: Dialog components receive only DialogProps, so the hand-off between
//          "the session just stopped" and "show me the generated code" lives
//          here rather than in a component. Also tracks the grid selection so
//          "save as button script" has a sensible default anchor.
//
// THE RECORDING IS SAVED BEFORE THE DIALOG OPENS. It used to be saved only if
// the user picked an output in the review dialog, so choosing "Close" destroyed
// the recording — losing work was reachable by a button. Excel never asks: a
// recorded macro always lands in a module. So does this one now. The dialog is
// no longer a save prompt; it is "what else would you like to do with it", and
// Close is safe without any warning wording for the user to read correctly.
//
// If the auto-save FAILS, the failure travels to the dialog in `saveError` and
// is shown there. Silence is not an option: the whole point is that the user
// never has to wonder whether the recording still exists.

import { showDialog } from "@api/ui";
import type { Selection } from "@api";
import { getCachedLocale } from "@api/locale";
import type { MacroTarget, RecordedAction } from "./types";
import { RESULT_DIALOG_ID } from "./ids";
import { generateMacroSource } from "./actionCodegen";
import {
  autoSaveRecordedMacro,
  type SavedMacroModule,
} from "./macroLibrary";
import { cancelRecording, getRecorderSnapshot, stopRecording } from "./actionRecorder";

/** What the review dialog opens on. */
export interface FinishedRecording {
  /** The macro's FINAL name — the module it was saved as, so the source the
   *  dialog regenerates matches the source in the store byte for byte. Falls
   *  back to the requested name when the auto-save failed. */
  name: string;
  actions: RecordedAction[];
  /** The runtime chosen when the recording was started (the dialog's default). */
  target: MacroTarget;
  /** Pinned so the dialog's regenerated source is identical to what was stored
   *  (the codegen embeds this timestamp in its header). */
  recordedAt: string;
  /** Where the recording was auto-saved, or null when that failed. */
  saved: SavedMacroModule | null;
  /** Why the auto-save failed. Non-null exactly when `saved` is null. */
  saveError: string | null;
}

let finished: FinishedRecording | null = null;
let pendingTarget: MacroTarget = "objectScript";
let selection: Selection | null = null;

/** Remember the runtime chosen in the start dialog. */
export function setPendingTarget(target: MacroTarget): void {
  pendingTarget = target;
}

export function getPendingTarget(): MacroTarget {
  return pendingTarget;
}

/** Called by the Shell's selection notifications (wired in activate()). */
export function setCurrentSelection(next: Selection | null): void {
  selection = next;
}

/** The cell a generated button should be anchored at: the active cell, or A1. */
export function getAnchorCell(): { sheetIndex: number; row: number; col: number } {
  if (!selection) return { sheetIndex: 0, row: 0, col: 0 };
  return {
    sheetIndex: selection.sheetIndex ?? 0,
    row: selection.activeRow ?? selection.endRow,
    col: selection.activeCol ?? selection.endCol,
  };
}

/**
 * The source that gets STORED for a recording, in the flavour of the runtime the
 * user chose at the start. Object-script recordings store the standalone
 * function ("bare"); the button entry point is generated on demand when the
 * user actually attaches one, so the stored module stays the readable, editable
 * artifact rather than a click handler.
 */
export function generateStoredSource(options: {
  actions: RecordedAction[];
  target: MacroTarget;
  name: string;
  recordedAt: string;
}): string {
  const { actions, target, name, recordedAt } = options;
  return generateMacroSource(actions, {
    target,
    wrapper: target === "notebook" ? "notebookCell" : "bare",
    name,
    decimalSeparator: getCachedLocale()?.decimalSeparator ?? ".",
    recordedAt,
  }).source;
}

/**
 * Stop the session, save what was captured, and open the review dialog.
 *
 * Stopping FIRST is deliberate: the hooks come off before anything else runs, so
 * neither the auto-save nor the review UI can end up inside the macro it is
 * reviewing.
 */
export async function finishRecording(): Promise<void> {
  const { name, status } = getRecorderSnapshot();
  if (status === "idle") return;
  const actions = stopRecording();
  const target = pendingTarget;
  const recordedAt = new Date().toISOString();

  let saved: SavedMacroModule | null = null;
  let saveError: string | null = null;
  try {
    saved = await autoSaveRecordedMacro({
      desiredName: name,
      runtime: target,
      actionCount: actions.length,
      recordedAt,
      generateSource: (finalName) =>
        generateStoredSource({ actions, target, name: finalName, recordedAt }),
    });
  } catch (e) {
    saveError = e instanceof Error ? e.message : String(e);
    console.error("[MacroRecorder] auto-save of the recording failed:", e);
  }

  finished = {
    name: saved?.name ?? name,
    actions,
    target,
    recordedAt,
    saved,
    saveError,
  };
  showDialog(RESULT_DIALOG_ID);
}

/** Throw the session away without generating or saving anything. */
export function abandonRecording(): void {
  cancelRecording();
  finished = null;
}

/** The recording the review dialog should render (null before the first stop). */
export function getFinishedRecording(): FinishedRecording | null {
  return finished;
}

/** Replace the stored-module record after the dialog re-saves an edited source. */
export function setFinishedSavedModule(saved: SavedMacroModule): void {
  if (!finished) return;
  finished = { ...finished, saved, saveError: null };
}

/** Test/teardown seam. */
export function resetFlow(): void {
  finished = null;
  pendingTarget = "objectScript";
  selection = null;
}
