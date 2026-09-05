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
import { useGridState } from "../../state";
import { toggleReferenceAtCursor } from "../../lib/formulaRefToggle";
import { updateCellsBatch, beginUndoTransaction, commitUndoTransaction, cancelUndoTransaction, type CellUpdateInput } from "../../lib/tauri-api";
import { cellEvents } from "../../lib/cellEvents";
import { checkRangeGuards } from "../../lib/editGuards";
import {
  beginEditorOpen,
  isEditorOpening,
  handleKeyWhileOpening,
  abortEditorOpen,
} from "../../lib/editOpenBuffer";
import { getMoveAfterReturn, getMoveDirection, getMoveDelta } from "../../../api/editingPreferences";
import { alertAsync } from "../../lib/dialogs";
import { isKeyClaimed } from "../../lib/pointerClaims";

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
        moveActiveCell(shiftKey ? -1 : 1, 0);
        scrollToSelection();
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
  }, [moveActiveCell, scrollToSelection, focusContainerRef]);

  // FIX: Also check isGlobalFormulaMode() synchronously to prevent committing
  // when React state is stale. This handles the race where the user types an operator
  // (e.g., comma) and immediately clicks a cell before React re-renders.
  const handleCommitBeforeSelect = useCallback(async () => {
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

    // Build batch updates for every cell in the selection
    try {
      const updates: CellUpdateInput[] = [];
      for (let row = minRow; row <= maxRow; row++) {
        for (let col = minCol; col <= maxCol; col++) {
          updates.push({ row, col, value: fillValue });
        }
      }

      await beginUndoTransaction(`Fill ${updates.length} cells`);
      const updatedCells = await updateCellsBatch(updates);
      await commitUndoTransaction();

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
      await cancelUndoTransaction().catch(() => {});
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
            console.log("[handleContainerKeyDown] Calling moveActiveCell");
            moveActiveCell(event.shiftKey ? -1 : 1, 0);
            scrollToSelection();
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
        event.key.length === 1 &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
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

      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        await startEditing("");
        await handleCommitEdit();
        return;
      }
    },
    [isEditingRef, editing, isOnDifferentSheet, startEditing, handleCommitEdit, handleInlineCtrlEnter, cancelEdit, updateValue, moveActiveCell, scrollToSelection, focusContainerRef, selection]
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