//! FILENAME: app/src/core/components/Spreadsheet/useSpreadsheetEditing.ts
// PURPOSE: Manages the editing lifecycle, formula bar, and inline inputs.
// CONTEXT: Contains complex logic for handling key events in both the container and inputs.

import { useCallback, useEffect, useState } from "react";
import {
  useEditing,
  getGlobalEditingValue,
  setGlobalIsEditing,
  getGlobalIsEditing,
  isGlobalFormulaMode,
  setGlobalCursorPosition,
} from "../../hooks";
import { useGridState, useGridDispatch, stopEditing } from "../../state";
import { setGlobalEditingValue, resetArrowRefState } from "../../hooks/useEditing";
import { toggleReferenceAtCursor } from "../../lib/formulaRefToggle";
import { updateCellsBatch, beginUndoTransaction, commitUndoTransaction, cancelUndoTransaction, type CellUpdateInput } from "../../lib/tauri-api";
import {
  ownUndoTransaction,
  type OwnedUndoTransaction,
  type UndoTransactionCloses,
} from "../../lib/undoTransactionOwnership";
import { cellEvents } from "../../lib/cellEvents";
import { checkRangeGuards } from "../../lib/editGuards";
import { refuseIfSelectionOwned } from "../../lib/selectionOwner";
import {
  beginEditorOpen,
  isEditorOpening,
  handleKeyWhileOpening,
  abortEditorOpen,
  isTypedCharacterKey,
  DISCARD_EDIT_EVENT,
} from "../../lib/editOpenBuffer";
import { getMoveAfterReturn, getMoveDirection, getMoveDelta } from "../../../api/editingPreferences";
import { alertAsync } from "../../lib/dialogs";
import { isKeyClaimed } from "../../lib/pointerClaims";
import { getExternalEditSession, isExternalEditLive } from "../../lib/formulaEditTarget";
import { endExternalFormulaSession, enterCommitMove, focusExternalSessionView } from "../../lib/pointModeSheetSwitch";

/** The Ctrl+Enter fill's closes, read when the close runs (see ownUndoTransaction). */
const UNDO_CLOSES: UndoTransactionCloses = {
  commitUndoTransaction: (...ticket) => commitUndoTransaction(...ticket),
  cancelUndoTransaction: (...ticket) => cancelUndoTransaction(...ticket),
};

type GridState = ReturnType<typeof useGridState>;

interface UseSpreadsheetEditingProps {
  containerRef: React.RefObject<HTMLDivElement | null>;
  focusContainerRef: React.RefObject<HTMLDivElement | null>; // FIX: Add focusContainerRef
  formulaInputRef: React.RefObject<HTMLInputElement | null>;
  state: GridState;
  selectedCellContent: string;
  moveActiveCell: (deltaRow: number, deltaCol: number) => void;
  scrollToSelection: () => void;
  selectCell: (row: number, col: number) => void;
  // startEditing is derived internally via useEditing()
}

export function getFormulaBarValue(
  isEditing: boolean,
  editing: { value: string } | null,
  selectedCellContent: string
): string {
  if (isEditing && editing) {
    return editing.value;
  }
  return selectedCellContent;
}

export function useSpreadsheetEditing({
  focusContainerRef, // FIX: Destructure focusContainerRef
  state,
  selectedCellContent,
  moveActiveCell,
  scrollToSelection,
}: UseSpreadsheetEditingProps) {
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const { selection } = state;

  /**
   * Enter's move after a COMMIT, from the Move-after-Return preference
   * (api/editingPreferences.ts): nothing when it is off, the chosen direction
   * otherwise, Shift reversing it. Every door that commits Core's edit on
   * Enter asks this -- the in-cell editor, the formula bar, the grid container
   * while the edit is parked on another sheet -- or a user who turned the
   * option off saw the cell move from two of the three (E4).
   */
  const moveAfterReturn = useCallback(
    (shiftKey: boolean) => {
      if (!getMoveAfterReturn()) return;
      const [dr, dc] = getMoveDelta(getMoveDirection());
      moveActiveCell(shiftKey ? -dr : dr, shiftKey ? -dc : dc);
      scrollToSelection();
    },
    [moveActiveCell, scrollToSelection],
  );
  
  const {
    isEditing,
    isEditingRef,
    isFormulaMode,
    isCommitting,
    lastError,
    editing,
    updateValue,
    commitEdit,
    cancelEdit,
    clearError,
    startEditing, // Derived here
    isOnDifferentSheet, // FIX: For handling Enter/Escape when on different sheet during formula mode
    navigateReferenceWithArrow, // For arrow key cell reference navigation in formula mode
  } = useEditing();

  const showStatus = useCallback((message: string, duration: number = 3000) => {
    setStatusMessage(message);
    setTimeout(() => setStatusMessage(null), duration);
  }, []);

  useEffect(() => {
    if (lastError) {
      showStatus(`Error: ${lastError}`, 5000); // eslint-disable-line react-hooks/set-state-in-effect -- Reacting to error state change requires side effect (timer)
    }
  }, [lastError, showStatus]);

  // FIX: Ensure the grid container has focus during cross-sheet formula editing.
  // When editing a formula and navigating to a different sheet (to pick cell references),
  // InlineEditor is not rendered (isOnDifferentSheet check returns null).
  // After inserting a reference by clicking a cell or after a sheet switch in formula mode,
  // focus can be lost (e.g., on the sheet tab or body). Without focus on the container,
  // pressing Enter/Escape won't reach handleContainerKeyDown and the commit won't happen.
  // This listener ensures the container gets focus. If InlineEditor IS rendered (same sheet),
  // it will reclaim focus via its own setTimeout(0) handler, so this is safe in all cases.
  useEffect(() => {
    const handleFocusRestoreForEditing = () => {
      if (isEditing && isOnDifferentSheet()) {
        // Only grab container focus during cross-sheet formula editing.
        // When InlineEditor is rendered (same sheet), stealing focus causes
        // a blur that can prematurely commit the edit.
        focusContainerRef.current?.focus();
      }
    };

    window.addEventListener("formula:referenceInserted", handleFocusRestoreForEditing);
    window.addEventListener("sheet:formulaModeSwitch", handleFocusRestoreForEditing);
    return () => {
      window.removeEventListener("formula:referenceInserted", handleFocusRestoreForEditing);
      window.removeEventListener("sheet:formulaModeSwitch", handleFocusRestoreForEditing);
    };
  }, [isEditing, isOnDifferentSheet, focusContainerRef]);

  // FIX: Listen for formula bar commit events from FormulaInput (shell layer)
  // FormulaInput can't directly call moveActiveCell since it's in the shell layer,
  // so it dispatches an event that we handle here to move the cell and restore focus
  useEffect(() => {
    const handleFormulaBarCommit = (event: Event) => {
      const { key, shiftKey } = (event as CustomEvent<{ key: string; shiftKey: boolean }>).detail;
      console.log("[useSpreadsheetEditing] formulaBar:commitComplete received:", { key, shiftKey });

      if (key === "Enter") {
        // The user's Move-after-Return preference, as the in-cell editor's
        // Enter (handleInlineEnter) -- a commit from the formula bar is the
        // same Enter (E4).
        moveAfterReturn(shiftKey);
      } else if (key === "Tab") {
        moveActiveCell(0, shiftKey ? -1 : 1);
        scrollToSelection();
      }
      // For all keys (including Escape), restore focus to grid
      focusContainerRef.current?.focus();
    };

    window.addEventListener("formulaBar:commitComplete", handleFormulaBarCommit);
    return () => {
      window.removeEventListener("formulaBar:commitComplete", handleFormulaBarCommit);
    };
  }, [moveActiveCell, scrollToSelection, focusContainerRef, moveAfterReturn]);

  // A REPLACED DOCUMENT discards the open edit (E9; core/lib/file-api.ts sends
  // DISCARD_EDIT_EVENT). The edit belongs to the document that is gone, so it
  // is neither committed -- that would write the old document's text into the
  // new one -- nor cancelled through cancelEdit, whose return to the edit's
  // source sheet would switch the NEW document to whatever sheet now has that
  // index. The open latch goes too: keys typed into the old document's opening
  // editor must not seed an entry in the new one.
  const gridDispatch = useGridDispatch();
  useEffect(() => {
    const handleDiscard = () => {
      abortEditorOpen();
      setGlobalIsEditing(false);
      if (!editing) return;
      setGlobalEditingValue("");
      resetArrowRefState();
      gridDispatch(stopEditing());
    };
    window.addEventListener(DISCARD_EDIT_EVENT, handleDiscard);
    return () => {
      window.removeEventListener(DISCARD_EDIT_EVENT, handleDiscard);
    };
  }, [editing, gridDispatch]);

  // FIX: Also check isGlobalFormulaMode() synchronously to prevent committing
  // when React state is stale. This handles the race where the user types an operator
  // (e.g., comma) and immediately clicks a cell before React re-renders.
  //
  // A live EXTERNAL session (a floating grid's cell edit) is ended the same way:
  // this path runs only when the click is NOT a reference pick
  // (useMouseSelection routes an expecting target's click to the pick), so it
  // is the grid's own rule -- a complete formula plus a cell click commits --
  // and, when the session is parked on another sheet, it also returns to the
  // host first. It is also the click-away commit on a worksheet host.
  const handleCommitBeforeSelect = useCallback(async () => {
    if (isExternalEditLive()) {
      await endExternalFormulaSession("commit", null);
      return;
    }
    if (isEditing && !isFormulaMode && !isGlobalFormulaMode()) {
      await commitEdit();
    }
  }, [isEditing, isFormulaMode, commitEdit]);

  const handleCommitEdit = useCallback(async (): Promise<boolean> => {
    console.log("[handleCommitEdit] START, calling commitEdit");
    const result = await commitEdit();
    console.log("[handleCommitEdit] commitEdit returned:", result);
    if (result) {
      if (result.success) {
        console.log("[handleCommitEdit] returning true");
        return true;
      } else {
        console.log("[handleCommitEdit] result.success is false, returning false");
        return false;
      }
    }
    console.log("[handleCommitEdit] result is falsy, returning false");
    return false;
  }, [commitEdit]);

  const handleFormulaInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      updateValue(event.target.value);
    },
    [updateValue]
  );

  const handleFormulaBarFocus = useCallback(async () => {
    if (!isEditing && selection) {
      // Synchronous guard: block editing in protected ranges (e.g., pivot tables)
      const guard = checkRangeGuards(selection.endRow, selection.endCol, selection.endRow, selection.endCol);
      if (guard?.blocked) {
        // Blur the formula bar to prevent typing
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
        return;
      }
      await startEditing();
    }
  }, [isEditing, selection, startEditing]);

  const handleFormulaInputKeyDown = useCallback(
    async (event: React.KeyboardEvent<HTMLInputElement>) => {
      // FIX: Stop propagation immediately to prevent the container from 
      // catching this event and triggering "Start Edit (Replace Mode)"
      event.stopPropagation();

      if (event.key === "Enter") {
        event.preventDefault();
        const success = await handleCommitEdit();
        if (success) {
          moveActiveCell(event.shiftKey ? -1 : 1, 0);
          scrollToSelection();
        }
        // FIX: Use focusContainerRef instead of containerRef
        focusContainerRef.current?.focus();
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancelEdit();
        // FIX: Use focusContainerRef instead of containerRef
        focusContainerRef.current?.focus();
      } else if (event.key === "Tab") {
        event.preventDefault();
        const success = await handleCommitEdit();
        if (success) {
          moveActiveCell(0, event.shiftKey ? -1 : 1);
          scrollToSelection();
        }
        // FIX: Use focusContainerRef instead of containerRef
        focusContainerRef.current?.focus();
      } else if (event.key === "F4") {
        // Toggle absolute/relative reference mode ($) on the cell reference at cursor
        // FIX: Use getGlobalEditingValue() instead of editing.value or DOM value.
        // This is because:
        // 1. The formula bar input is a controlled React component
        // 2. React state updates are asynchronous
        // 3. When F4 is pressed rapidly, React may not have re-rendered yet
        // 4. getGlobalEditingValue() is updated synchronously in updateValue()
        const inputEl = event.currentTarget;
        const currentValue = getGlobalEditingValue() || inputEl.value;
        if (currentValue.startsWith("=")) {
          event.preventDefault();
          const cursorPos = inputEl.selectionStart ?? 0;
          const result = toggleReferenceAtCursor(currentValue, cursorPos);
          if (result.formula !== currentValue) {
            updateValue(result.formula);
            // Restore cursor position after React re-renders the input value
            requestAnimationFrame(() => {
              inputEl.setSelectionRange(result.cursorPos, result.cursorPos);
            });
          }
        }
      }
    },
    [handleCommitEdit, cancelEdit, moveActiveCell, scrollToSelection, focusContainerRef, updateValue]
  );

  // --- Inline Editor Handlers ---

  const handleInlineValueChange = useCallback((value: string) => updateValue(value), [updateValue]);
  
  const handleInlineCommit = useCallback(async () => {
    console.log("[handleInlineCommit] START");
    const success = await handleCommitEdit();
    console.log("[handleInlineCommit] handleCommitEdit returned:", success);
    if (success) {
      // FIX: Use focusContainerRef instead of containerRef
      focusContainerRef.current?.focus();
    }
    return success;
  }, [handleCommitEdit, focusContainerRef]);
  
  const handleInlineCancel = useCallback(() => {
    cancelEdit();
    // FIX: Use focusContainerRef instead of containerRef
    focusContainerRef.current?.focus();
  }, [cancelEdit, focusContainerRef]);

  const handleInlineTab = useCallback((shiftKey: boolean) => {
    moveActiveCell(0, shiftKey ? -1 : 1);
    scrollToSelection();
    // FIX: Use focusContainerRef instead of containerRef
    focusContainerRef.current?.focus();
  }, [moveActiveCell, scrollToSelection, focusContainerRef]);

  const handleInlineEnter = useCallback((shiftKey: boolean) => {
    if (!getMoveAfterReturn()) {
      // Stay on current cell
      focusContainerRef.current?.focus();
      return;
    }
    const direction = getMoveDirection();
    const [dr, dc] = getMoveDelta(direction);
    // Shift reverses the direction
    moveActiveCell(shiftKey ? -dr : dr, shiftKey ? -dc : dc);
    scrollToSelection();
    focusContainerRef.current?.focus();
  }, [moveActiveCell, scrollToSelection, focusContainerRef]);

  // Handle Ctrl+Enter - fill selected range with current entry
  const handleInlineCtrlEnter = useCallback(async () => {
    if (!editing || !selection) {
      return;
    }

    // Capture the value before canceling the edit
    const fillValue = editing.value;

    // Cancel the edit (closes editor without committing to a single cell)
    cancelEdit();

    // Determine the selection bounds
    const minRow = Math.min(selection.startRow, selection.endRow);
    const maxRow = Math.max(selection.startRow, selection.endRow);
    const minCol = Math.min(selection.startCol, selection.endCol);
    const maxCol = Math.max(selection.startCol, selection.endCol);

    // Build batch updates for every cell in the selection. The fill closes
    // ONLY the undo transaction its own begin opened: inside a script's open
    // batch it joins, and the script closes that step (wave E, Y7).
    let tx: OwnedUndoTransaction | null = null;
    try {
      const updates: CellUpdateInput[] = [];
      for (let row = minRow; row <= maxRow; row++) {
        for (let col = minCol; col <= maxCol; col++) {
          updates.push({ row, col, value: fillValue });
        }
      }

      tx = ownUndoTransaction(await beginUndoTransaction(`Fill ${updates.length} cells`), UNDO_CLOSES);
      const updatedCells = await updateCellsBatch(updates);
      await tx.commit();

      console.log(`[useSpreadsheetEditing] Ctrl+Enter filled ${updates.length} cells, ${updatedCells.length} updated`);

      // Emit a single event to trigger canvas refresh
      if (updatedCells.length > 0) {
        cellEvents.emit({
          row: updatedCells[0].row,
          col: updatedCells[0].col,
          oldValue: undefined,
          newValue: updatedCells[0].display,
          formula: updatedCells[0].formula ?? null,
        }, "fill");
      }
    } catch (error) {
      // The commit above is skipped when updateCellsBatch rejects, leaving the
      // transaction open so later edits join it. Cancel, and tell the user —
      // a console.error alone reads as "Ctrl+Enter silently did nothing".
      await tx?.cancel().catch(() => {});
      console.error("[useSpreadsheetEditing] Ctrl+Enter fill failed:", error);
      const msg = typeof error === "string" ? error : (error as Error)?.message;
      if (msg) void alertAsync(msg);
    }

    focusContainerRef.current?.focus();
  }, [editing, selection, cancelEdit, focusContainerRef]);

  // Handler for arrow key cell reference navigation in formula mode
  const handleArrowKeyReference = useCallback(
    (direction: "up" | "down" | "left" | "right", extend?: boolean) => {
      navigateReferenceWithArrow(direction, extend);
    },
    [navigateReferenceWithArrow]
  );

  const handleContainerKeyDown = useCallback(
    async (event: React.KeyboardEvent<HTMLDivElement>) => {
      // A keystroke aimed inside something that CLAIMED the gesture is not the
      // grid's — the same ancestor walk the pointer door uses
      // (core/lib/pointerClaims.ts). This door does not delete cells, but it
      // opens the CELL EDITOR on a printable key and MOVES the active cell on
      // Enter, both measured with a form's `<button>` focused: the button could
      // not be pressed with the keyboard at all, and typing into a form put the
      // characters into the sheet cell hidden underneath it.
      //
      // Ahead of the tag check for the same reason as in useGridKeyboard: the
      // tag list is a census of the widget types that existed when it was
      // written, and `<select>`/`<button>` were never on it.
      if (isKeyClaimed(event)) {
        return;
      }

      // Skip if focus is inside an input, textarea, or contenteditable element
      const target = event.target as HTMLElement;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) {
          return;
        }
      }

      // === A LIVE EXTERNAL EDIT SESSION (the fallback door) ===
      // A floating grid's cell edit hosted by the formula bar, or parked on
      // another sheet while it picks a reference. The keyboard belongs on the
      // bar (the pointer door no longer moves it here during a pick), but when
      // a key does reach the container it must still go to the FORMULA, never
      // to the grid: before this, Enter moved the grid cursor and a printable
      // key opened a second, CORE edit on a cell nobody was editing. Parked
      // with the formula bar HIDDEN, this container is the session's only
      // keyboard (focusExternalSessionView focuses it).
      //
      // DELETE AND THE OTHER REGISTRY KEYS (Ctrl+V/X/C/D/R/1/M, Ctrl+Z/Y) do
      // not depend on this branch alone. The capture-phase keybinding
      // dispatcher (api/keybindings.ts) runs first; it used to run
      // core.edit.clearContents / paste / undo here and stop the key before
      // this handler (or useGridKeyboard's gate) ever saw it. It now stands
      // down for a live session WITHOUT preventDefault, so those keys arrive
      // here and are handed back to the session like any other key.
      const externalSession = getExternalEditSession();
      if (externalSession) {
        event.preventDefault();
        if (event.key === "Enter" || event.key === "Tab") {
          const move =
            event.key === "Enter"
              ? enterCommitMove(event.shiftKey) // Move-after-Return (E4)
              : (event.shiftKey ? "left" : "right");
          await endExternalFormulaSession("commit", move);
          return;
        }
        if (event.key === "Escape") {
          await endExternalFormulaSession("cancel");
          return;
        }
        if (
          // A typed character, an AltGr one included ("$" in an absolute
          // reference is AltGr+4 on sv-SE; isTypedCharacterKey).
          isTypedCharacterKey(event) &&
          !event.nativeEvent.isComposing &&
          event.nativeEvent.keyCode !== 229
        ) {
          // The character goes INTO the formula at its caret, then the caret
          // goes back to the view that hosts it.
          const caret = externalSession.getCursor();
          const text = externalSession.getText();
          externalSession.setText(text.slice(0, caret) + event.key + text.slice(caret), caret + 1);
        } else if (
          event.key === "Backspace" &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey
        ) {
          // Backspace deletes the character before the formula's caret. Parked
          // with the formula bar HIDDEN this container is the session's only
          // keyboard (focusExternalSessionView focuses it), so a Backspace that
          // only handed the keyboard back -- to this same container -- left a
          // mistyped formula impossible to correct without the mouse.
          const caret = externalSession.getCursor();
          if (caret > 0) {
            const text = externalSession.getText();
            externalSession.setText(text.slice(0, caret - 1) + text.slice(caret), caret - 1);
          }
        }
        // Everything else (Delete, arrows, F2, a lone modifier) is never a grid
        // action while a session is live: hand the keyboard back.
        focusExternalSessionView();
        return;
      }

      // === THE EDITOR IS OPENING ===
      // Opening the editor by typing is asynchronous (two IPC round trips, a
      // React render, then focus). Every keystroke that lands in that window
      // arrives HERE rather than at the editor. Before this check existed they
      // were lost: the ones that arrived before the editing state existed
      // started a SECOND replace-mode edit holding only their own character
      // (so the last keystroke won and "hello" committed as "o"), and the ones
      // that arrived after it fell into the "let the editor handle it"
      // early-return below while the editor did not yet have focus.
      //
      // While the open window is latched we own the keyboard: text keys extend
      // the entry being opened, and Enter/Tab/Escape are latched for the editor
      // to replay through its own handlers the moment it is ready. This runs
      // FIRST -- ahead of the isEditingRef branch -- because the open window
      // spans both sides of that flag flipping.
      if (isEditorOpening()) {
        // Built explicitly rather than passed straight through: React's
        // synthetic keyboard event does not carry `isComposing`, only the
        // native one does, and IME keys must never be buffered.
        const outcome = handleKeyWhileOpening({
          key: event.key,
          shiftKey: event.shiftKey,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          altKey: event.altKey,
          isComposing: event.nativeEvent.isComposing,
          keyCode: event.nativeEvent.keyCode,
        });
        if (outcome.kind !== "passthrough") {
          event.preventDefault();
          // Push the extended entry into the live edit. Before the editing
          // state exists this is a no-op in the reducer and startEditing seeds
          // itself from the buffer instead; after it exists this is what makes
          // the characters visible.
          if (outcome.kind === "text") {
            updateValue(outcome.value);
            // The caret is at the end of everything typed so far. The editor
            // restores the caret from this when it finally takes focus, so
            // leaving it behind would drop the user mid-word: type "a", let
            // "bc" land during the window, and the next character would be
            // inserted at position 1 ("aXbc").
            setGlobalCursorPosition(outcome.value.length);
          }
          return;
        }
      }

      // FIX: Use ONLY the synchronous ref for editing check
      // The ref is updated immediately when editing starts/stops, before React re-renders.
      // This prevents:
      // 1. Race condition on double-click (editing starts, ref true, but React state false)
      // 2. Arrow key blocking after commit (editing stops, ref false, but React state true)
      // Using OR would cause stale React state to block navigation after commit.
      if (isEditingRef.current) {
        // FIX: Handle Enter/Escape when editing, even if InlineEditor should have focus.
        // This handles two cases:
        // 1. Cross-sheet formula editing (InlineEditor not rendered on target sheet)
        // 2. Race condition where user presses Enter before InlineEditor focuses
        // If InlineEditor has focus, it handles these keys and stops propagation,
        // so this code only runs when the container has focus during editing.
        if (event.key === "Enter") {
          // Alt+Enter - insert newline in cell (during cross-sheet editing)
          if (event.altKey && !event.ctrlKey && !event.metaKey && editing) {
            event.preventDefault();
            const currentValue = editing.value;
            // Append newline at end (no cursor position available in container mode)
            updateValue(currentValue + "\n");
            return;
          }
          event.preventDefault();
          console.log("[handleContainerKeyDown] Enter pressed while isEditingRef.current is true, editing state:", !!editing);
          // FIX: If editing state is not yet set (race condition with async startEditing),
          // don't try to commit. Just wait for InlineEditor to render - the user can
          // press Enter there. This prevents the bug where commit clears globalIsEditing
          // but then startEditing completes and renders InlineEditor, leaving the user
          // stuck with InlineEditor focused but unable to navigate.
          if (!editing) {
            console.log("[handleContainerKeyDown] Enter pressed but editing not set yet, waiting for InlineEditor");
            return;
          }
          // Ctrl+Enter - fill selected range with current entry
          if (event.ctrlKey || event.metaKey) {
            await handleInlineCtrlEnter();
            focusContainerRef.current?.focus();
            return;
          }
          const success = await handleCommitEdit();
          console.log("[handleContainerKeyDown] handleCommitEdit returned:", success);
          if (success) {
            // Move-after-Return, as the in-cell editor's own Enter (E4).
            moveAfterReturn(event.shiftKey);
          }
          focusContainerRef.current?.focus();
          return;
        } else if (event.key === "Escape") {
          event.preventDefault();
          // FIX: Same race condition fix for Escape
          if (!editing) {
            console.log("[handleContainerKeyDown] Escape pressed but editing not set yet");
            setGlobalIsEditing(false);
            return;
          }
          cancelEdit();
          focusContainerRef.current?.focus();
          return;
        }

        // FIX: Self-healing for stuck editing state.
        // If isEditingRef is true but React editing state is null, we have an
        // inconsistent state (likely from a race condition or error during startEdit).
        // Clear the stuck global flag and allow navigation to proceed.
        if (!editing) {
          // ...unless an open is genuinely in flight. startEditing sets the
          // global flag before it has finished awaiting, so this state is
          // NORMAL for a few milliseconds after the first keystroke; tearing it
          // down here is what used to let the next keystroke start a second
          // edit and throw the first one away.
          if (isEditorOpening()) return;
          console.warn("[handleContainerKeyDown] Editing ref stuck without editing state, clearing...");
          setGlobalIsEditing(false);
          // Don't return - let the key be handled normally below
        } else {
          // For other keys during editing, return early (let InlineEditor handle if focused)
          return;
        }
      }

      const navigationKeys = [
        "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
        "PageUp", "PageDown", "Home", "End"
      ];

      if (navigationKeys.includes(event.key)) {
        return;
      }

      // A key that would BEGIN an entry in Core's active cell -- F2, a typed
      // character (AltGr included), or the bare Delete/Backspace that clears it
      // -- while something else OWNS the selection (core/lib/selectionOwner.ts).
      // A floating grid selected as a whole OBJECT keeps the keyboard on this
      // container with Core's active cell hidden under it, and the entry opened
      // THERE; Enter then wrote the hidden cell (the BUG-0185 class, review C).
      // Type-to-edit is a door that writes to Core's selection, so it asks the
      // owner and refuses, once. The owner's own cell takes its keys before
      // they get here (a floating grid's type-to-edit swallows them). With no
      // cell selection (a canvas) nothing would be written, so nothing refuses.
      const isBareClear =
        (event.key === "Delete" || event.key === "Backspace") &&
        !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
      const beginsEntry =
        event.key === "F2" ||
        (isTypedCharacterKey(event) &&
          !event.nativeEvent.isComposing &&
          event.nativeEvent.keyCode !== 229);
      if (selection && (beginsEntry || isBareClear) && refuseIfSelectionOwned(isBareClear ? "Clear Contents" : "Edit Cell")) {
        event.preventDefault();
        return;
      }

      // Synchronous guard: block editing in protected ranges (e.g., pivot tables)
      if (selection) {
        const guard = checkRangeGuards(selection.endRow, selection.endCol, selection.endRow, selection.endCol);
        if (guard?.blocked) {
          // Allow navigation keys but block all editing keys
          if (event.key !== "Enter" && !navigationKeys.includes(event.key)) {
            event.preventDefault();
          }
          return;
        }
      }

      if (event.key === "F2") {
        event.preventDefault();
        await startEditing();
        return;
      }

      if (event.key === "Enter") {
        event.preventDefault();
        moveActiveCell(event.shiftKey ? -1 : 1, 0);
        scrollToSelection();
        return;
      }

      if (
        // A typed character STARTS an entry -- an AltGr one included: on
        // sv-SE "@" and "$" arrive with Ctrl AND Alt set, and a "no Ctrl, no
        // Alt" test dropped them (E13; isTypedCharacterKey).
        isTypedCharacterKey(event) &&
        // An IME composition delivers its result to the focused element as a
        // composition/input event, not as a character keydown. Opening on it
        // would consume the key and leave the composition nowhere to land.
        !event.nativeEvent.isComposing &&
        event.nativeEvent.keyCode !== 229
      ) {
        event.preventDefault();
        // Latch SYNCHRONOUSLY, before the first await inside startEditing:
        // whichever keystroke arrives next must find an open already in flight.
        beginEditorOpen(event.key);
        await startEditing(event.key);
        // startEditing only raises the global editing flag once it has cleared
        // its guards. If it bailed out (protected range, extension guard, no
        // selection) no editor is coming, so the latch must not survive to
        // swallow the keyboard.
        if (!getGlobalIsEditing()) abortEditorOpen();
        return;
      }

      // A clear is the BARE key (useGridKeyboard's onDelete branch asks the
      // same): a modified Delete/Backspace that the grid keyboard now lets
      // through must not land here and clear the cell after all.
      if (
        (event.key === "Delete" || event.key === "Backspace") &&
        !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
      ) {
        event.preventDefault();
        await startEditing("");
        await handleCommitEdit();
        return;
      }
    },
    [isEditingRef, editing, isOnDifferentSheet, startEditing, handleCommitEdit, handleInlineCtrlEnter, cancelEdit, updateValue, moveActiveCell, scrollToSelection, focusContainerRef, selection, moveAfterReturn]
  );

  const getFormulaBarValueInternal = (): string => {
    if (isEditing && editing) {
      return editing.value;
    }
    return selectedCellContent;
  };

  return {
    statusMessage,
    setStatusMessage,
    editingState: {
      isEditing,
      isFormulaMode,
      isCommitting,
      editing
    },
    handlers: {
      handleCommitBeforeSelect,
      handleFormulaInputChange,
      handleFormulaBarFocus,
      handleFormulaInputKeyDown,
      handleInlineValueChange,
      handleInlineCommit,
      handleInlineCancel,
      handleInlineTab,
      handleInlineEnter,
      handleInlineCtrlEnter,
      handleContainerKeyDown,
      handleArrowKeyReference,
      clearError
    },
    ui: {
      getFormulaBarValue: getFormulaBarValueInternal
    }
  };
}