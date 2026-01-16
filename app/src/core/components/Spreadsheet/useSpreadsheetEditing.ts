// FILENAME: app/src/components/Spreadsheet/useSpreadsheetEditing.ts
// PURPOSE: Manages the editing lifecycle, formula bar, and inline inputs.
// CONTEXT: Contains complex logic for handling key events in both the container and inputs.
// FIX: Added event.stopPropagation() to formula input key handler to prevent bubbling
//      which caused the container to trigger "Replace Mode" editing.
// FIX: Use focusContainerRef instead of containerRef for focus restoration.
//      containerRef points to the grid area (not focusable), while focusContainerRef
//      points to the outer container with tabIndex={0}.

import { useCallback, useEffect, useState } from "react";
import { useEditing } from "../../hooks";
import { useGridState } from "../../state";

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
  containerRef,
  focusContainerRef, // FIX: Destructure focusContainerRef
  formulaInputRef,
  state,
  selectedCellContent,
  moveActiveCell,
  scrollToSelection,
  selectCell,
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
    startEditing // Derived here
  } = useEditing();

  const showStatus = useCallback((message: string, duration: number = 3000) => {
    setStatusMessage(message);
    setTimeout(() => setStatusMessage(null), duration);
  }, []);

  useEffect(() => {
    if (lastError) {
      showStatus(`Error: ${lastError}`, 5000);
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
      }
    },
    [handleCommitEdit, cancelEdit, moveActiveCell, scrollToSelection, focusContainerRef]
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
    [isEditing, isEditingRef, startEditing, handleCommitEdit, moveActiveCell, scrollToSelection]
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