//! FILENAME: app/src/core/components/Spreadsheet/useSpreadsheetEditing.ts
// PURPOSE: Manages the editing lifecycle, formula bar, and inline inputs.
// CONTEXT: Contains complex logic for handling key events in both the container and inputs.

import { useCallback, useEffect, useState } from "react";
import { useEditing, getGlobalEditingValue, setGlobalIsEditing } from "../../hooks";
import { useGridState } from "../../state";
import { toggleReferenceAtCursor } from "../../lib/formulaRefToggle";
import { updateCellsBatch, beginUndoTransaction, commitUndoTransaction, type CellUpdateInput } from "../../lib/tauri-api";
import { cellEvents } from "../../lib/cellEvents";

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
      if (isEditing) {
        focusContainerRef.current?.focus();
      }
    };

    window.addEventListener("formula:referenceInserted", handleFocusRestoreForEditing);
    window.addEventListener("sheet:formulaModeSwitch", handleFocusRestoreForEditing);
    return () => {
      window.removeEventListener("formula:referenceInserted", handleFocusRestoreForEditing);
      window.removeEventListener("sheet:formulaModeSwitch", handleFocusRestoreForEditing);
    };
  }, [isEditing, focusContainerRef]);

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

  const handleCommitBeforeSelect = useCallback(async () => {
    if (isEditing && !isFormulaMode) {
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

  const handleFormulaBarFocus = useCallback(() => {
    if (!isEditing && selection) {
      startEditing();
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
    moveActiveCell(shiftKey ? -1 : 1, 0);
    scrollToSelection();
    // FIX: Use focusContainerRef instead of containerRef
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
        });
      }
    } catch (error) {
      console.error("[useSpreadsheetEditing] Ctrl+Enter fill failed:", error);
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

      if (event.key === "F2") {
        event.preventDefault();
        startEditing();
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
        !event.altKey
      ) {
        event.preventDefault();
        startEditing(event.key);
        return;
      }

      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        startEditing("");
        await handleCommitEdit();
        return;
      }
    },
    [isEditingRef, editing, isOnDifferentSheet, startEditing, handleCommitEdit, handleInlineCtrlEnter, cancelEdit, moveActiveCell, scrollToSelection, focusContainerRef]
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