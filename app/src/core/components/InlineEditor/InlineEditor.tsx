//! FILENAME: app/src/core/components/InlineEditor/InlineEditor.tsx
// PURPOSE: Inline cell editor component that renders directly over the cell being edited.
// CONTEXT: Refactored to separate styles into .styles.ts file using styled-components.

import React, { useRef, useEffect, useCallback, useState } from "react";
import type { GridConfig, Viewport, EditingCell, DimensionOverrides } from "../../types";
import { isFormulaExpectingReference, createEmptyDimensionOverrides } from "../../types";
import { useGridContext } from "../../state/GridContext";
import * as S from "./InlineEditor.styles";

/**
 * Global flag to prevent blur from committing during sheet tab navigation.
 * This is set by SheetTabs before clicking and cleared after.
 * Using a global because the blur event fires between mousedown and click,
 * and we need to coordinate across components.
 */
let preventBlurCommit = false;

/**
 * Set the preventBlurCommit flag. Called by SheetTabs during formula mode sheet switching.
 */
export function setPreventBlurCommit(value: boolean): void {
  preventBlurCommit = value;
}

/**
 * Get the current preventBlurCommit flag value.
 */
export function getPreventBlurCommit(): boolean {
  return preventBlurCommit;
}

export interface InlineEditorProps {
  /** Current editing state */
  editing: EditingCell;
  /** Grid configuration for cell dimensions */
  config: GridConfig;
  /** Current viewport for scroll position */
  viewport: Viewport;
  /** Custom dimension overrides for columns/rows */
  dimensions?: DimensionOverrides;
  /** Callback to update the editing value */
  onValueChange: (value: string) => void;
  /** Callback to commit the edit */
  onCommit: () => Promise<boolean>;
  /** Callback to cancel the edit */
  onCancel: () => void;
  /** Callback when Tab is pressed (to move to next cell) */
  onTab?: (shiftKey: boolean) => void;
  /** Callback when Enter is pressed (to move down after commit) */
  onEnter?: (shiftKey: boolean) => void;
  /** Callback to restore focus to the grid container after commit */
  onRestoreFocus?: () => void;
  /** Whether the editor is disabled (e.g., during save) */
  disabled?: boolean;
}

/**
 * Get the width of a specific column, using custom width if set.
 */
function getColumnWidth(
  col: number,
  config: GridConfig,
  dimensions: DimensionOverrides
): number {
  const customWidth = dimensions.columnWidths.get(col);
  if (customWidth !== undefined && customWidth > 0) {
    return customWidth;
  }
  return config.defaultCellWidth || 100;
}

/**
 * Get the height of a specific row, using custom height if set.
 */
function getRowHeight(
  row: number,
  config: GridConfig,
  dimensions: DimensionOverrides
): number {
  const customHeight = dimensions.rowHeights.get(row);
  if (customHeight !== undefined && customHeight > 0) {
    return customHeight;
  }
  return config.defaultCellHeight || 24;
}

/**
 * Calculate the X position of a column (left edge) accounting for variable widths.
 */
function calculateColumnX(
  col: number,
  config: GridConfig,
  dimensions: DimensionOverrides,
  scrollX: number
): number {
  const rowHeaderWidth = config.rowHeaderWidth || 50;
  let x = rowHeaderWidth;
  for (let c = 0; c < col; c++) {
    x += getColumnWidth(c, config, dimensions);
  }
  return x - scrollX;
}

/**
 * Calculate the Y position of a row (top edge) accounting for variable heights.
 */
function calculateRowY(
  row: number,
  config: GridConfig,
  dimensions: DimensionOverrides,
  scrollY: number
): number {
  const colHeaderHeight = config.colHeaderHeight || 24;
  let y = colHeaderHeight;
  for (let r = 0; r < row; r++) {
    y += getRowHeight(r, config, dimensions);
  }
  return y - scrollY;
}

/**
 * Calculate the total width for a cell spanning multiple columns.
 */
function getMergedWidth(
  startCol: number,
  colSpan: number,
  config: GridConfig,
  dimensions: DimensionOverrides
): number {
  let totalWidth = 0;
  for (let c = startCol; c < startCol + colSpan; c++) {
    totalWidth += getColumnWidth(c, config, dimensions);
  }
  return totalWidth;
}

/**
 * Calculate the total height for a cell spanning multiple rows.
 */
function getMergedHeight(
  startRow: number,
  rowSpan: number,
  config: GridConfig,
  dimensions: DimensionOverrides
): number {
  let totalHeight = 0;
  for (let r = startRow; r < startRow + rowSpan; r++) {
    totalHeight += getRowHeight(r, config, dimensions);
  }
  return totalHeight;
}

/**
 * Calculate the position and visibility of the inline editor.
 */
function calculateEditorPosition(
  editing: EditingCell,
  config: GridConfig,
  viewport: Viewport,
  dimensions: DimensionOverrides
): {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
} {
  const { row, col, rowSpan = 1, colSpan = 1 } = editing;
  const { rowHeaderWidth, colHeaderHeight } = config;

  // Calculate cell position using proper dimension-aware functions
  const cellX = calculateColumnX(col, config, dimensions, viewport.scrollX);
  const cellY = calculateRowY(row, config, dimensions, viewport.scrollY);
   
  // FIX: Calculate dimensions accounting for merged cell spans
  const cellWidth = colSpan > 1 
    ? getMergedWidth(col, colSpan, config, dimensions)
    : getColumnWidth(col, config, dimensions);
  const cellHeight = rowSpan > 1
    ? getMergedHeight(row, rowSpan, config, dimensions)
    : getRowHeight(row, config, dimensions);

  // Check if cell is visible (not scrolled out of view)
  const visible =
    cellX + cellWidth > rowHeaderWidth &&
    cellY + cellHeight > colHeaderHeight &&
    cellX < window.innerWidth &&
    cellY < window.innerHeight;

  // Clamp position to ensure editor doesn't overlap headers
  const x = Math.max(cellX, rowHeaderWidth);
  const y = Math.max(cellY, colHeaderHeight);

  // Adjust width/height if partially clipped by headers
  const clipLeft = Math.max(0, rowHeaderWidth - cellX);
  const clipTop = Math.max(0, colHeaderHeight - cellY);
  const width = cellWidth - clipLeft;
  const height = cellHeight - clipTop;

  return { x, y, width, height, visible };
}

/**
 * InlineEditor component - renders a text input directly over the cell being edited.
 */
export function InlineEditor(props: InlineEditorProps): React.ReactElement | null {
  const {
    editing,
    config,
    viewport,
    dimensions,
    onValueChange,
    onCommit,
    onCancel,
    onTab,
    onEnter,
    onRestoreFocus,
    disabled = false,
  } = props;

  const inputRef = useRef<HTMLInputElement | null>(null);
  const isCommittingRef = useRef(false);
  // FIX: Track when ESC is pressed to prevent blur from committing
  const isCancelingRef = useRef(false);
   
  // Get current sheet context to determine if we should render
  const { state: gridState } = useGridContext();
  const currentSheetIndex = gridState.sheetContext.activeSheetIndex;
  // Counter to force refocus after sheet switches
  const [refocusTrigger, setRefocusTrigger] = useState(0);

  // Ensure we have valid dimensions
  const dims = dimensions || createEmptyDimensionOverrides();

  // Calculate position
  const position = calculateEditorPosition(editing, config, viewport, dims);

  /**
   * Handle input value changes.
   */
  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      if (!disabled) {
        onValueChange(event.target.value);
      }
    },
    [onValueChange, disabled]
  );

  /**
   * Handle keyboard events.
   */
  const handleKeyDown = useCallback(
    async (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (disabled || isCommittingRef.current) {
        return;
      }

      switch (event.key) {
        case "Enter":
          event.preventDefault();
          event.stopPropagation();
          isCommittingRef.current = true;
          try {
            const commitSuccess = await onCommit();
            if (commitSuccess && onEnter) {
              onEnter(event.shiftKey);
            }
            // Restore focus to grid container so keyboard navigation works
            onRestoreFocus?.();
          } finally {
            isCommittingRef.current = false;
          }
          break;

        case "Escape":
          event.preventDefault();
          event.stopPropagation();
          // FIX: Set canceling flag BEFORE calling onCancel to prevent blur from committing
          isCancelingRef.current = true;
          onCancel();
          // Restore focus to grid container so keyboard navigation works
          onRestoreFocus?.();
          break;

        case "Tab":
          event.preventDefault();
          event.stopPropagation();
          isCommittingRef.current = true;
          try {
            const tabSuccess = await onCommit();
            if (tabSuccess && onTab) {
              onTab(event.shiftKey);
            }
            // Restore focus to grid container so keyboard navigation works
            onRestoreFocus?.();
          } finally {
            isCommittingRef.current = false;
          }
          break;

        default:
          // Let other keys propagate normally for text input
          break;
      }
    },
    [onCommit, onCancel, onTab, onEnter, onRestoreFocus, disabled]
  );

  /**
   * Handle blur - commit edit when focus leaves the editor.
   * Uses the actual input value at blur time to avoid stale closure issues.
   * Also checks the global preventBlurCommit flag set by SheetTabs.
   * FIX: Also checks isCancelingRef to prevent commit after ESC.
   */
  const handleBlur = useCallback(
    async (event: React.FocusEvent<HTMLInputElement>) => {
      // Don't commit if already committing (e.g., from Enter key)
      if (isCommittingRef.current || disabled) {
        return;
      }

      // FIX: Don't commit if we're canceling (ESC was pressed)
      if (isCancelingRef.current) {
        console.log("[InlineEditor] Blur prevented - cancel in progress");
        return;
      }

      // Check the global flag set by SheetTabs during formula mode navigation
      if (preventBlurCommit) {
        console.log("[InlineEditor] Blur prevented by global flag");
        return;
      }

      // Check the actual input value at blur time (not closure) to determine formula mode
      const currentValue = event.target.value;
      const isCurrentlyInFormulaMode = isFormulaExpectingReference(currentValue);
      
      if (isCurrentlyInFormulaMode) {
        console.log("[InlineEditor] Blur prevented - formula mode active, value:", currentValue);
        return;
      }

      // Check if focus is moving to the formula bar input
      // FIX: Ensure data-formula-bar attribute is checked
      const relatedTarget = event.relatedTarget as HTMLElement | null;
      if (relatedTarget?.getAttribute("data-formula-bar") === "true") {
        return;
      }

      // Focus moving elsewhere - commit
      console.log("[InlineEditor] Blur committing, value:", currentValue);
      isCommittingRef.current = true;
      try {
        // Restore focus to grid container so keyboard navigation works
        onRestoreFocus?.();
        await onCommit();
      } finally {
        isCommittingRef.current = false;
      }
    },
    [onCommit, disabled, onRestoreFocus]
  );

  /**
   * Listen for sheet switch events during formula mode.
   * When the user switches sheets while editing a formula, we need to refocus
   * the input so they can continue editing and selecting cells.
   */
  useEffect(() => {
    const handleFormulaModeSheetSwitch = () => {
      console.log("[InlineEditor] Received sheet switch event, will refocus");
      // Clear the prevent flag now that the switch is complete
      preventBlurCommit = false;
      // Trigger a refocus by updating the trigger counter
      setRefocusTrigger(prev => prev + 1);
    };

    window.addEventListener("sheet:formulaModeSwitch", handleFormulaModeSheetSwitch);
    
    return () => {
      window.removeEventListener("sheet:formulaModeSwitch", handleFormulaModeSheetSwitch);
    };
  }, []);

  /**
   * Auto-focus the input when editing starts or when triggered by sheet switch.
   */
  useEffect(() => {
    if (inputRef.current && position.visible && !disabled) {
      // Use setTimeout to ensure focus happens after any pending DOM updates
      // This is especially important after sheet switches
      const timeoutId = setTimeout(() => {
        if (inputRef.current) {
          // FIX: Check if focus is already on the formula bar (data-formula-bar)
          // If it is, DO NOT steal focus. Let the user type in the formula bar.
          const activeElement = document.activeElement;
          if (activeElement?.getAttribute("data-formula-bar") === "true") {
            console.log("[InlineEditor] Formula bar active, skipping autofocus");
            return;
          }

          inputRef.current.focus();
          // Place cursor at end of text
          const len = inputRef.current.value.length;
          inputRef.current.setSelectionRange(len, len);
          console.log("[InlineEditor] Focused input, cursor at position:", len);
        }
      }, 0);
      
      return () => clearTimeout(timeoutId);
    }
  }, [editing.row, editing.col, position.visible, disabled, refocusTrigger]);

  // Don't render the inline editor if we're viewing a different sheet than the source.
  // This happens during cross-sheet formula reference selection (point mode).
  // The formula bar still shows the formula, but we don't overlay the editor on the target sheet.
  // This matches Excel behavior where you see the target sheet clearly while selecting references.
  const isOnDifferentSheet = 
    editing.sourceSheetIndex !== undefined && 
    editing.sourceSheetIndex !== currentSheetIndex;

  // Don't render if not visible OR if viewing a different sheet during formula mode
  // NOTE: This check must be AFTER all hooks to avoid React hooks rule violation
  if (!position.visible || isOnDifferentSheet) {
    return null;
  }

  return (
    <S.EditorInput
      ref={inputRef}
      $x={position.x}
      $y={position.y}
      $width={position.width}
      $height={position.height}
      value={editing.value}
      onChange={handleChange}
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
      disabled={disabled}
      spellCheck={false}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
    />
  );
}

export default InlineEditor;