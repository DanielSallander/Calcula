//! FILENAME: app/extensions/DataValidation/handlers/keyboardHandler.ts
// PURPOSE: Alt+Down opens the in-cell list on the active cell (Excel parity).
// CONTEXT: The mouse target for the list is deliberately just the ~18px chevron
//          button, so a keyboard path is not a nicety — it is the accessible
//          equivalent of hitting that button. Alt+Up / Escape close it.

import { getCurrentSelection, getOpenDropdownCell } from "../lib/validationStore";
import { closeDropdown, toggleDropdownFromKeyboard } from "./dropdownHandler";
import { isKeyClaimed } from "@api";

let keydownHandler: ((e: KeyboardEvent) => void) | null = null;

export function registerValidationKeyboardShortcuts(): void {
  if (keydownHandler) return;
  keydownHandler = handleKeyDown;
  window.addEventListener("keydown", keydownHandler, true);
}

export function unregisterValidationKeyboardShortcuts(): void {
  if (!keydownHandler) return;
  window.removeEventListener("keydown", keydownHandler, true);
  keydownHandler = null;
}

/** Exported for tests. */
export function handleKeyDown(e: KeyboardEvent): void {
  // A keystroke aimed at a surface stacked ON the grid -- an on-grid form's
  // field, a shape's declared hit rectangle -- is not this extension's.
  // The tag list below cannot see a <select> or a <button>; the claim can.
  // See core/lib/pointerClaims.ts, and the census in
  // core/lib/globalInputListeners.ts (a new global listener adds a row).
  if (isKeyClaimed(e)) return;
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;

  // Never steal keys from a text entry (cell editor, dialog field, ...).
  const active = document.activeElement;
  if (
    active &&
    (active.tagName === "INPUT" ||
      active.tagName === "TEXTAREA" ||
      (active as HTMLElement).isContentEditable)
  ) {
    return;
  }

  const sel = getCurrentSelection();
  if (!sel) return;
  const row = sel.activeRow ?? sel.endRow;
  const col = sel.activeCol ?? sel.endCol;

  if (e.key === "ArrowUp") {
    // Only claim Alt+Up when there is actually a list open to close.
    const open = getOpenDropdownCell();
    if (!open) return;
    e.preventDefault();
    e.stopPropagation();
    closeDropdown();
    return;
  }

  // Alt+Down: the async part only runs for cells that really have a list, but
  // the key must be claimed synchronously or the grid moves the cursor first.
  e.preventDefault();
  e.stopPropagation();
  void toggleDropdownFromKeyboard(row, col);
}
