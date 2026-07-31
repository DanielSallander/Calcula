//! FILENAME: app/extensions/MacroRecorder/lib/flow.ts
// PURPOSE: The record -> stop -> review flow, and the small pieces of state the
//          dialogs need but cannot get from an ExtensionContext.
// CONTEXT: Dialog components receive only DialogProps, so the hand-off between
//          "the session just stopped" and "show me the generated code" lives
//          here rather than in a component. Also tracks the grid selection so
//          "save as button script" has a sensible default anchor.

import { showDialog } from "@api/ui";
import type { Selection } from "@api";
import type { MacroTarget, RecordedAction } from "./types";
import { RESULT_DIALOG_ID } from "./ids";
import { cancelRecording, getRecorderSnapshot, stopRecording } from "./actionRecorder";

/** What the review dialog opens on. */
export interface FinishedRecording {
  name: string;
  actions: RecordedAction[];
  /** The runtime chosen when the recording was started (the dialog's default). */
  target: MacroTarget;
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
 * Stop the session and open the review dialog.
 *
 * Stopping FIRST is deliberate: the hooks come off before any dialog opens, so
 * nothing the review UI does can end up inside the macro it is reviewing.
 */
export function finishRecording(): void {
  const { name, status } = getRecorderSnapshot();
  if (status === "idle") return;
  const actions = stopRecording();
  finished = { name, actions, target: pendingTarget };
  showDialog(RESULT_DIALOG_ID);
}

/** Throw the session away without generating anything. */
export function abandonRecording(): void {
  cancelRecording();
  finished = null;
}

/** The recording the review dialog should render (null before the first stop). */
export function getFinishedRecording(): FinishedRecording | null {
  return finished;
}

/** Test/teardown seam. */
export function resetFlow(): void {
  finished = null;
  pendingTarget = "objectScript";
  selection = null;
}
