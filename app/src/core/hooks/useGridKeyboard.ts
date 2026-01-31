//! FILENAME: app/src/core/hooks/useGridKeyboard.ts
// PURPOSE: Custom hook for handling keyboard navigation in the grid.
// CONTEXT: This hook manages keyboard events for cell navigation including
// arrow keys, Tab, Enter, Page Up/Down, Home, End, modifier combinations,
// clipboard shortcuts (Ctrl+C, Ctrl+V, Ctrl+X, Ctrl+Z), DELETE key, and ESC to clear clipboard.
// FIX: Added check for getGlobalIsEditing() to catch editing state synchronously
//      before React state updates, preventing keystrokes from starting new edits.
// FIX: Added DELETE key handler to clear selection contents.
// FIX: Added merge-aware navigation - when landing on a merged cell, expands selection.
// FIX: When navigating FROM a merged cell, calculate target from the edge of the merge
//      in the direction of movement to avoid getting stuck.
// FIX: Preserve entry column/row when exiting merged cells vertically/horizontally.

import { useCallback, useEffect } from "react";
import { useGridContext } from "../state/GridContext";
import { setSelection } from "../state/gridActions";
import { findCtrlArrowTarget, getMergeInfo, type ArrowDirection } from "../lib/tauri-api";
import { fnLog, stateLog, eventLog } from '../../utils/component-logger';
import { getGlobalIsEditing } from "./useEditing";

/**
 * Options for the useGridKeyboard hook.
 */
interface UseGridKeyboardOptions {
  /** Reference to the container element for event attachment */
  containerRef: React.RefObject<HTMLElement | null>;
  /** Callback when selection changes (for scroll-into-view) */
  onSelectionChange?: () => void;
  /** Whether keyboard handling is enabled */
  enabled?: boolean;
  /** Whether editing is active (if true, skip navigation) */
  isEditing?: boolean;
  /** Callback for cut operation */
  onCut?: () => Promise<void>;
  /** Callback for copy operation */
  onCopy?: () => Promise<void>;
  /** Callback for paste operation */
  onPaste?: () => Promise<void>;
  /** Callback for undo operation */
  onUndo?: () => Promise<void>;
  /** Callback for redo operation */
  onRedo?: () => Promise<void>;
  /** Callback for clearing clipboard (ESC key) */
  onClearClipboard?: () => void;
  /** Whether clipboard has content (for ESC handling) */
  hasClipboardContent?: boolean;
  /** Callback for delete/clear contents operation */
  onDelete?: () => Promise<void>;
}

/**
 * Clamp a value between min and max bounds.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Hook for handling keyboard navigation in the grid.
 *
 * @param options - Configuration options
 */
export function useGridKeyboard(options: UseGridKeyboardOptions): void {
  const {
    containerRef,
    onSelectionChange,
    enabled = true,
    isEditing = false,
    onCut,
    onCopy,
    onPaste,
    onUndo,
    onRedo,
    onClearClipboard,
    hasClipboardContent = false,
    onDelete,
  } = options;
  const { state, dispatch } = useGridContext();
  const { config, viewport, selection } = state;

  /**
   * Handle navigation to a cell, expanding to merged region if needed.
   * This is an async helper that checks for merges and dispatches the appropriate selection.
   * 
   * IMPORTANT: When landing on a merged cell, we preserve the entry point (row, col) as
   * startRow/startCol, and set endRow/endCol to cover the merge extent. This allows
   * subsequent navigation to exit from the correct position.
   */
  const navigateToCell = useCallback(
    async (row: number, col: number, extend: boolean) => {
      try {
        const mergeInfo = await getMergeInfo(row, col);
        
        if (mergeInfo) {
          // Cell is part of a merge - expand selection to cover it
          if (extend && selection) {
            // When extending, keep the start anchor and extend to the merge bounds
            // Use the corner of the merge that's furthest from the start
            const endRow = row >= selection.startRow ? mergeInfo.endRow : mergeInfo.startRow;
            const endCol = col >= selection.startCol ? mergeInfo.endCol : mergeInfo.startCol;
            dispatch(setSelection({
              startRow: selection.startRow,
              startCol: selection.startCol,
              endRow,
              endCol,
              type: selection.type,
            }));
          } else {
            // Not extending - select the entire merged region
            // Keep startRow/startCol at the entry point (row, col)
            // Set endRow/endCol to the opposite corner to cover the full merge
            dispatch(setSelection({
              startRow: row,
              startCol: col,
              // Set end to opposite corner of merge to ensure full coverage
              endRow: row <= mergeInfo.startRow ? mergeInfo.endRow : mergeInfo.startRow,
              endCol: col <= mergeInfo.startCol ? mergeInfo.endCol : mergeInfo.startCol,
              type: "cells",
            }));
          }
        } else {
          // Regular cell - normal selection
          if (extend && selection) {
            dispatch(setSelection({
              startRow: selection.startRow,
              startCol: selection.startCol,
              endRow: row,
              endCol: col,
              type: selection.type,
            }));
          } else {
            dispatch(setSelection({
              startRow: row,
              startCol: col,
              endRow: row,
              endCol: col,
              type: "cells",
            }));
          }
        }
      } catch (error) {
        console.error('[useGridKeyboard] Failed to get merge info:', error);
        // Fallback to regular selection on error
        if (extend && selection) {
          dispatch(setSelection({
            startRow: selection.startRow,
            startCol: selection.startCol,
            endRow: row,
            endCol: col,
            type: selection.type,
          }));
        } else {
          dispatch(setSelection({
            startRow: row,
            startCol: col,
            endRow: row,
            endCol: col,
            type: "cells",
          }));
        }
      }

      if (onSelectionChange) {
        setTimeout(onSelectionChange, 0);
      }
    },
    [selection, dispatch, onSelectionChange]
  );

  /**
   * Handle Ctrl+Arrow navigation by querying the backend for the target cell.
   */
  const handleCtrlArrow = useCallback(
    async (direction: ArrowDirection, extend: boolean) => {
      if (!selection) {
        return;
      }

      // For Ctrl+Arrow from a merged cell, we need to start from the appropriate edge
      // Get the normalized bounds of the current selection
      const minRow = Math.min(selection.startRow, selection.endRow);
      const maxRow = Math.max(selection.startRow, selection.endRow);
      const minCol = Math.min(selection.startCol, selection.endCol);
      const maxCol = Math.max(selection.startCol, selection.endCol);

      // Determine starting position based on direction
      // Use startCol/startRow as the "entry point" for the current position
      let currentRow: number;
      let currentCol: number;

      switch (direction) {
        case "up":
          currentRow = minRow;  // Start from top edge
          currentCol = selection.startCol;  // Preserve entry column
          break;
        case "down":
          currentRow = maxRow;  // Start from bottom edge
          currentCol = selection.startCol;  // Preserve entry column
          break;
        case "left":
          currentRow = selection.startRow;  // Preserve entry row
          currentCol = minCol;  // Start from left edge
          break;
        case "right":
          currentRow = selection.startRow;  // Preserve entry row
          currentCol = maxCol;  // Start from right edge
          break;
        default:
          currentRow = selection.startRow;
          currentCol = selection.startCol;
      }

      const maxRowBound = config.totalRows - 1;
      const maxColBound = config.totalCols - 1;

      try {
        const [targetRow, targetCol] = await findCtrlArrowTarget(
          currentRow,
          currentCol,
          direction,
          maxRowBound,
          maxColBound
        );

        fnLog.exit('handleCtrlArrow', `target=(${targetRow}, ${targetCol})`);

        // Use merge-aware navigation
        await navigateToCell(targetRow, targetCol, extend);
      } catch (error) {
        console.error("[useGridKeyboard] Ctrl+Arrow navigation failed:", error);
      }
    },
    [selection, config.totalRows, config.totalCols, navigateToCell]
  );

  /**
   * Handle regular arrow key navigation with merge awareness.
   * When navigating FROM a merged cell, we calculate the target from the edge
   * of the merge in the direction of movement, while preserving the entry
   * column (for vertical movement) or entry row (for horizontal movement).
   */
  const handleArrowNavigation = useCallback(
    async (deltaRow: number, deltaCol: number, extend: boolean) => {
      if (!selection) {
        // No selection - start at origin
        await navigateToCell(0, 0, false);
        return;
      }

      const maxRow = config.totalRows - 1;
      const maxCol = config.totalCols - 1;

      // Get the normalized bounds of the current selection
      // This handles both regular cells and merged cells
      const minRow = Math.min(selection.startRow, selection.endRow);
      const maxRowSel = Math.max(selection.startRow, selection.endRow);
      const minCol = Math.min(selection.startCol, selection.endCol);
      const maxColSel = Math.max(selection.startCol, selection.endCol);

      // Calculate starting position based on direction of movement
      // This ensures we exit from the correct edge of a merged cell
      // while preserving the entry point for the perpendicular axis
      let startRow: number;
      let startCol: number;

      if (deltaRow < 0) {
        // Moving up - start from top edge
        startRow = minRow;
      } else if (deltaRow > 0) {
        // Moving down - start from bottom edge
        startRow = maxRowSel;
      } else {
        // No vertical movement - preserve the entry row (startRow)
        startRow = selection.startRow;
      }

      if (deltaCol < 0) {
        // Moving left - start from left edge
        startCol = minCol;
      } else if (deltaCol > 0) {
        // Moving right - start from right edge
        startCol = maxColSel;
      } else {
        // No horizontal movement - preserve the entry column (startCol)
        // This is the key fix: when exiting a merged cell vertically,
        // we stay in the same column we entered from
        startCol = selection.startCol;
      }

      // Calculate target position from the appropriate edge
      const targetRow = clamp(startRow + deltaRow, 0, maxRow);
      const targetCol = clamp(startCol + deltaCol, 0, maxCol);

      // Use merge-aware navigation
      await navigateToCell(targetRow, targetCol, extend);
    },
    [selection, config.totalRows, config.totalCols, navigateToCell]
  );

  /**
   * Handle keydown events for navigation and shortcuts.
   */
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      const { key, shiftKey, ctrlKey, metaKey, altKey } = event;
      
      fnLog.enter('handleKeyDown', `key=${key}`);

      if (!enabled) {
        fnLog.exit('handleKeyDown', 'skipped (disabled)');
        return;
      }

      // FIX: Check the global editing flag synchronously
      // The isEditing prop may be stale (from React state that hasn't re-rendered yet)
      // but the global flag is updated immediately when editing starts
      const isCurrentlyEditing = isEditing || getGlobalIsEditing();
      
      if (isCurrentlyEditing) {
        fnLog.exit('handleKeyDown', 'skipped (editing active - global check)');
        return;
      }

      const modKey = ctrlKey || metaKey;

      // Handle ESC key - clear clipboard if content exists
      if (key === "Escape" && hasClipboardContent && onClearClipboard) {
        event.preventDefault();
        event.stopPropagation();
        eventLog.keyboard('Grid', 'handleKeyDown', 'Escape', []);
        onClearClipboard();
        fnLog.exit('handleKeyDown', 'cleared clipboard');
        return;
      }

      // Handle DELETE/Backspace key - clear selection contents
      if ((key === "Delete" || key === "Backspace") && onDelete) {
        event.preventDefault();
        event.stopPropagation();
        eventLog.keyboard('Grid', 'handleKeyDown', key, []);
        onDelete();
        fnLog.exit('handleKeyDown', 'delete contents');
        return;
      }

      // Handle clipboard shortcuts
      if (modKey && !altKey) {
        switch (key.toLowerCase()) {
          case 'c':
            // Ctrl+C - Copy
            if (onCopy) {
              event.preventDefault();
              event.stopPropagation();
              eventLog.keyboard('Grid', 'handleKeyDown', 'Ctrl+C', ['Ctrl']);
              onCopy();
              fnLog.exit('handleKeyDown', 'copy');
              return;
            }
            break;
          
          case 'x':
            // Ctrl+X - Cut
            if (onCut) {
              event.preventDefault();
              event.stopPropagation();
              eventLog.keyboard('Grid', 'handleKeyDown', 'Ctrl+X', ['Ctrl']);
              onCut();
              fnLog.exit('handleKeyDown', 'cut');
              return;
            }
            break;
          
          case 'v':
            // Ctrl+V - Paste
            if (onPaste) {
              event.preventDefault();
              event.stopPropagation();
              eventLog.keyboard('Grid', 'handleKeyDown', 'Ctrl+V', ['Ctrl']);
              onPaste();
              fnLog.exit('handleKeyDown', 'paste');
              return;
            }
            break;
          
          case 'z':
            // Ctrl+Z - Undo, Ctrl+Shift+Z - Redo
            event.preventDefault();
            event.stopPropagation();
            if (shiftKey && onRedo) {
              eventLog.keyboard('Grid', 'handleKeyDown', 'Ctrl+Shift+Z', ['Ctrl', 'Shift']);
              onRedo();
              fnLog.exit('handleKeyDown', 'redo');
            } else if (onUndo) {
              eventLog.keyboard('Grid', 'handleKeyDown', 'Ctrl+Z', ['Ctrl']);
              onUndo();
              fnLog.exit('handleKeyDown', 'undo');
            }
            return;
          
          case 'y':
            // Ctrl+Y - Redo (alternative)
            if (onRedo) {
              event.preventDefault();
              event.stopPropagation();
              eventLog.keyboard('Grid', 'handleKeyDown', 'Ctrl+Y', ['Ctrl']);
              onRedo();
              fnLog.exit('handleKeyDown', 'redo');
              return;
            }
            break;
        }
      }

      // Handle Ctrl+Arrow for Excel-like navigation (async)
      if (modKey && !altKey) {
        let direction: ArrowDirection | null = null;
        
        switch (key) {
          case "ArrowUp":
            direction = "up";
            break;
          case "ArrowDown":
            direction = "down";
            break;
          case "ArrowLeft":
            direction = "left";
            break;
          case "ArrowRight":
            direction = "right";
            break;
        }
        
        if (direction) {
          event.preventDefault();
          event.stopPropagation();
          
          const mods: string[] = ['Ctrl'];
          if (shiftKey) mods.push('Shift');
          eventLog.keyboard('Grid', 'handleKeyDown', `Ctrl+${key}`, mods);
          
          // Call async handler (non-blocking)
          handleCtrlArrow(direction, shiftKey);
          fnLog.exit('handleKeyDown', 'ctrl+arrow (async)');
          return;
        }
      }

      let deltaRow = 0;
      let deltaCol = 0;
      let handled = false;

      switch (key) {
        case "ArrowUp":
          deltaRow = -1;
          handled = true;
          break;

        case "ArrowDown":
          deltaRow = 1;
          handled = true;
          break;

        case "ArrowLeft":
          deltaCol = -1;
          handled = true;
          break;

        case "ArrowRight":
          deltaCol = 1;
          handled = true;
          break;

        case "Tab":
          if (shiftKey) {
            deltaCol = -1;
          } else {
            deltaCol = 1;
          }
          handled = true;
          break;

        case "PageUp":
          deltaRow = -Math.max(1, viewport.rowCount - 1);
          handled = true;
          break;

        case "PageDown":
          deltaRow = Math.max(1, viewport.rowCount - 1);
          handled = true;
          break;

        case "Home":
          if (modKey) {
            deltaRow = -config.totalRows;
            deltaCol = -config.totalCols;
          } else {
            deltaCol = -config.totalCols;
          }
          handled = true;
          break;

        case "End":
          if (modKey) {
            deltaRow = config.totalRows;
            deltaCol = config.totalCols;
          } else {
            deltaCol = config.totalCols;
          }
          handled = true;
          break;

        default:
          fnLog.exit('handleKeyDown', 'not a navigation key');
          return;
      }

      if (handled) {
        const mods: string[] = [];
        if (ctrlKey) mods.push('Ctrl');
        if (shiftKey) mods.push('Shift');
        if (altKey) mods.push('Alt');
        if (metaKey) mods.push('Meta');
        
        eventLog.keyboard('Grid', 'handleKeyDown', key, mods);

        event.preventDefault();
        event.stopPropagation();

        const extend = shiftKey && key !== "Tab";
        
        stateLog.action('GridContext', 'dispatch(handleArrowNavigation)', `dRow=${deltaRow}, dCol=${deltaCol}, extend=${extend}`);
        
        // Use merge-aware navigation (async)
        handleArrowNavigation(deltaRow, deltaCol, extend);
        
        fnLog.exit('handleKeyDown', 'handled');
      }
    },
    [enabled, isEditing, config.totalRows, config.totalCols, viewport.rowCount, onSelectionChange, onCut, onCopy, onPaste, onUndo, onRedo, onClearClipboard, hasClipboardContent, onDelete, handleCtrlArrow, handleArrowNavigation]
  );

  /**
   * Attach keyboard event listener to the container.
   */
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !enabled) {
      return;
    }

    fnLog.enter('useGridKeyboard.effect', 'adding listener');

    container.addEventListener("keydown", handleKeyDown, { capture: false });

    return () => {
      fnLog.exit('useGridKeyboard.effect', 'removing listener');
      container.removeEventListener("keydown", handleKeyDown, { capture: false });
    };
  }, [containerRef, enabled, handleKeyDown]);
}