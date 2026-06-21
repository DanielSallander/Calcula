//! FILENAME: app/extensions/ScriptEditor/lib/actionRecorder.ts
// PURPOSE: The capture half of the macro recorder. While recording, observe
//          cell writes (via the core bridge hook) and buffer them, stamped with
//          the active sheet, so actionCodegen can turn them into a script.
// CONTEXT: A process-wide singleton (capture happens for edits anywhere). The
//          recorder installs the bridge hook only while recording, so there is
//          zero overhead when idle. v1 records cell edits (updateCell /
//          updateCellsBatch); command-driven actions (clear/insert/fill/merge)
//          are a later slice.

import { setCellRecorderHook, getActiveSheet } from "@api/lib";
import { onAppEvent, AppEvents } from "@api";
import type { RecordedAction } from "./actionCodegen";

let recording = false;
let buffer: RecordedAction[] = [];
let currentSheet = 0;
let unsubSheet: (() => void) | null = null;

/** Whether a recording is currently in progress. */
export function isRecording(): boolean {
  return recording;
}

/**
 * Begin recording. Clears any prior buffer, snapshots the active sheet, and
 * installs the bridge cell-write hook. Idempotent.
 */
export async function startRecording(): Promise<void> {
  if (recording) return;
  buffer = [];
  try {
    currentSheet = await getActiveSheet();
  } catch {
    currentSheet = 0;
  }
  // Track the active sheet so each captured edit is stamped with the sheet it
  // happened on (a multi-sheet recording then replays on the right sheets).
  unsubSheet = onAppEvent(AppEvents.SHEET_CHANGED, (detail) => {
    const d = detail as { sheetIndex?: number } | undefined;
    if (typeof d?.sheetIndex === "number") {
      currentSheet = d.sheetIndex;
    } else {
      void getActiveSheet().then((i) => {
        currentSheet = i;
      }).catch(() => {});
    }
  });
  setCellRecorderHook((writes) => {
    if (!recording) return;
    for (const w of writes) {
      buffer.push({ row: w.row, col: w.col, value: w.value, sheetIndex: currentSheet });
    }
  });
  recording = true;
}

/**
 * Stop recording and return the captured actions (in order). Uninstalls the
 * bridge hook and the sheet tracker. Safe to call when not recording.
 */
export function stopRecording(): RecordedAction[] {
  recording = false;
  setCellRecorderHook(null);
  if (unsubSheet) {
    unsubSheet();
    unsubSheet = null;
  }
  return buffer.slice();
}
