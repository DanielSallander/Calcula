//! FILENAME: app/src/core/components/Spreadsheet/useSpreadsheetEditing.ts
// PURPOSE: Manages the editing lifecycle, formula bar, and inline inputs.
// CONTEXT: Contains complex logic for handling key events in both the container and inputs.

import { useCallback, useEffect, useState } from "react";
import { useEditing, getGlobalEditingValue } from "../../hooks";
import { useGridState } from "../../state";
import { toggleReferenceAtCursor } from "../../lib/formulaRefToggle";

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

  const handleCommitBeforeSelect = useCallback(async () => {
    if (isEditing && !isFormulaMode) {
      await commitEdit();
    }
  }, [isEditing, isFormulaMode, commitEdit]);

  const handleCommitEdit = useCallback(async (): Promise<boolean> => {
    const result = await commitEdit();
    if (result) {
      if (result.success) {
        return true;
      } else {
        return false;
      }
    }
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
    const success = await handleCommitEdit();
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

  const handleContainerKeyDown = useCallback(
    async (event: React.KeyboardEvent<HTMLDivElement>) => {
      // FIX: Check BOTH the state AND the synchronous ref
      // The ref is updated immediately when editing starts, before React re-renders
      // This prevents the stale closure race condition on double-click
      if (isEditing || isEditingRef.current) {
        // FIX: When editing on a different sheet, InlineEditor is not rendered
        // so we need to handle Enter/Escape here for cross-sheet formula editing
        if (isOnDifferentSheet()) {
          if (event.key === "Enter") {
            event.preventDefault();
            const success = await handleCommitEdit();
            if (success) {
              moveActiveCell(event.shiftKey ? -1 : 1, 0);
              scrollToSelection();
            }
            focusContainerRef.current?.focus();
            return;
          } else if (event.key === "Escape") {
            event.preventDefault();
            cancelEdit();
            focusContainerRef.current?.focus();
            return;
          }
        }
        return;
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
    [isEditing, isEditingRef, isOnDifferentSheet, startEditing, handleCommitEdit, cancelEdit, moveActiveCell, scrollToSelection, focusContainerRef]
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
      handleContainerKeyDown,
      clearError
    },
    ui: {
      getFormulaBarValue: getFormulaBarValueInternal
    }
  };
}