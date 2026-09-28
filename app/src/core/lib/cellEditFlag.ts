//! FILENAME: app/src/core/lib/cellEditFlag.ts
// PURPOSE: The ONE store of "Core's own cell edit is open" -- the synchronous
//          flag behind useEditing's getGlobalIsEditing / setGlobalIsEditing.
// CONTEXT: Core's edit is open while its in-cell editor (a <textarea> INSIDE
//          the grid's focus container) or the formula bar hosts it, AND while
//          it is PARKED: a formula begun on one sheet, the user on another
//          sheet picking a reference, the in-cell editor not rendered there and
//          the keyboard on the grid container (useSpreadsheetEditing's
//          handleFocusRestoreForEditing). In that parked state no text field is
//          focused, so a tag test cannot see the edit at all -- only this flag
//          can.
//
// WHY A SEPARATE MODULE: the keybinding dispatcher (api/keybindings.ts) must
// ask this question on every keystroke, and core/hooks/useEditing.ts -- where
// the flag used to live as a module-level `let` -- is a hook module with the
// grid state and the backend calls behind it, the weight that dispatcher
// deliberately does not load (the same reason it reads the external-edit
// liveness from formulaEditTarget.ts rather than from the externalEdit door).
// Without the flag, the dispatcher ran Ctrl+T, Ctrl+Shift+L, Delete and the
// other selection-acting keys over the viewed sheet's selection during a
// parked Core edit, while every extension listener for the same keys (asking
// @api/editing isEditKeystroke, which DID read the flag) stood down.
//
// ONE STORE, NOT A MIRROR: useEditing reads and writes the flag only through
// these two functions, so the dispatcher, Core's own gates and the extension
// predicates all see the same boolean. A second copy kept "in sync" would
// drift on the first write that forgot it.
//
// NOTE: A Core primitive with NO imports. It reads neither the DOM nor the grid
// state.

let coreCellEditOpen = false;

/** Write the flag. Only useEditing calls this (setGlobalIsEditing and its isEditingRef). */
export function setCoreCellEditFlag(open: boolean): void {
  coreCellEditOpen = open;
}

/** Whether Core's own cell edit is open, wherever its keyboard currently is. */
export function isCoreCellEditOpen(): boolean {
  return coreCellEditOpen;
}
