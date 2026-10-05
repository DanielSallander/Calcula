//! FILENAME: app/extensions/Sorting/lib/sortWarning.ts
// PURPOSE: Excel's "Sort Warning" question as a promise: a single selected
//          column sits inside wider data -- sort the whole block, or only the
//          column?
// CONTEXT: Sorting one column of a table on its own scrambles every row it
//          belongs to (each value leaves its neighbours behind), so Excel asks
//          before it does it, and defaults to expanding. Measured live
//          2026-10-04: Sort A to Z over B2:B6 inside A1:C6 stopped on this
//          modal; over A3:B5 (two columns inside the same block) it sorted the
//          selection without asking. The dialog component (components/
//          SortWarningDialog.tsx) answers through `answerSortWarning`.

import { showDialog } from "@api/ui";

export const SORT_WARNING_DIALOG_ID = "sort-warning";

/** "expand": sort the surrounding block; "current": only the selection. */
export type SortWarningChoice = "expand" | "current" | "cancel";

let pending: ((choice: SortWarningChoice) => void) | null = null;

/**
 * Show the question and wait for the answer. A second question while one is
 * open cancels the first (one dialog id, one answer).
 */
export function askSortWarning(): Promise<SortWarningChoice> {
  if (pending) {
    const previous = pending;
    pending = null;
    previous("cancel");
  }
  return new Promise<SortWarningChoice>((resolve) => {
    pending = resolve;
    showDialog(SORT_WARNING_DIALOG_ID);
  });
}

/**
 * The dialog's answer. Closing it any other way (its X, Escape, the backdrop)
 * answers "cancel" -- a dialog that cannot answer is a refusal, never consent
 * to sort.
 */
export function answerSortWarning(choice: SortWarningChoice): void {
  const resolve = pending;
  pending = null;
  resolve?.(choice);
}

/** Whether a question is waiting (for tests and the dialog's unmount guard). */
export function isSortWarningPending(): boolean {
  return pending !== null;
}
