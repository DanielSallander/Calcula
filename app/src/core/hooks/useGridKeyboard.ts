// FILENAME: app/src/hooks/useGridKeyboard.ts
// PURPOSE: Custom hook for handling keyboard navigation in the grid.
// CONTEXT: This hook manages keyboard events for cell navigation including
// arrow keys, Tab, Enter, Page Up/Down, Home, End, modifier combinations,
// clipboard shortcuts (Ctrl+C, Ctrl+V, Ctrl+X, Ctrl+Z), and ESC to clear clipboard.

import { useCallback, useEffect } from "react";
import { useGridContext } from "../state/GridContext";
import { moveSelection, setSelection } from "../state/gridActions";
import { findCtrlArrowTarget, type ArrowDirection } from "../lib/tauri-api";
import { fnLog, stateLog, eventLog } from '../../utils/component-logger';

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
  } = options;
  const { state, dispatch } = useGridContext();
  const { config, viewport, selection } = state;

  /**
   * Handle Ctrl+Arrow navigation by querying the backend for the target cell.
   */
  const handleCtrlArrow = useCallback(
    async (direction: ArrowDirection, extend: boolean) => {
      if (!selection) {
        return;
      }

      const currentRow = selection.endRow;
      const currentCol = selection.endCol;
      const maxRow = config.totalRows - 1;
      const maxCol = config.totalCols - 1;

      try {
        const [targetRow, targetCol] = await findCtrlArrowTarget(
          currentRow,
          currentCol,
          direction,
          maxRow,
          maxCol
        );

        fnLog.exit('handleCtrlArrow', `target=(${targetRow}, ${targetCol})`);

        if (extend) {
          // Extend selection to target
          dispatch(setSelection({
            startRow: selection.startRow,
            startCol: selection.startCol,
            endRow: targetRow,
            endCol: targetCol,
            type: selection.type,
          }));
        } else {
          // Move selection to target
          dispatch(setSelection({
            startRow: targetRow,
            startCol: targetCol,
            endRow: targetRow,
            endCol: targetCol,
            type: "cells",
          }));
        }

        if (onSelectionChange) {
          setTimeout(onSelectionChange, 0);
        }
      } catch (error) {
        console.error("[useGridKeyboard] Ctrl+Arrow navigation failed:", error);
      }
    },
    [selection, config.totalRows, config.totalCols, dispatch, onSelectionChange]
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

      const modKey = ctrlKey || metaKey;

      // Handle ESC key - clear clipboard if content exists
      if (key === "Escape" && !isEditing && hasClipboardContent && onClearClipboard) {
        event.preventDefault();
        event.stopPropagation();
        eventLog.keyboard('Grid', 'handleKeyDown', 'Escape', []);
        onClearClipboard();
        fnLog.exit('handleKeyDown', 'cleared clipboard');
        return;
      }

      // Handle clipboard shortcuts (even during editing for some operations)
      if (modKey && !altKey) {
        switch (key.toLowerCase()) {
          case 'c':
            // Ctrl+C - Copy
            if (!isEditing && onCopy) {
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
            if (!isEditing && onCut) {
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
            if (!isEditing && onPaste) {
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
            if (!isEditing) {
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
            }
            break;
          
          case 'y':
            // Ctrl+Y - Redo (alternative)
            if (!isEditing && onRedo) {
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

      // Skip navigation if editing
      if (isEditing) {
        fnLog.exit('handleKeyDown', 'skipped (editing)');
        return;
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
        
        stateLog.action('GridContext', 'dispatch(moveSelection)', `dRow=${deltaRow}, dCol=${deltaCol}, extend=${extend}`);
        dispatch(moveSelection(deltaRow, deltaCol, extend));

        if (onSelectionChange) {
          setTimeout(onSelectionChange, 0);
        }
        
        fnLog.exit('handleKeyDown', 'handled');
      }
    },
    [enabled, isEditing, config.totalRows, config.totalCols, viewport.rowCount, dispatch, onSelectionChange, onCut, onCopy, onPaste, onUndo, onRedo, onClearClipboard, hasClipboardContent, handleCtrlArrow]
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