// FILENAME: shell/FormulaBar/NameBox.tsx
// PURPOSE: Name Box component displaying active cell address with navigation support
// CONTEXT: Shows current selection (e.g., "A1") and allows typing an address to navigate

import React, { useState, useEffect, useRef, useCallback } from "react";
import { useGridContext } from "../../core/state/GridContext";
import { setSelection, scrollToCell } from "../../core/state/gridActions";
import { columnToLetter, letterToColumn } from "../../core/types/types";

/**
 * Parse a cell reference string (e.g., "A1", "Z100", "AA25") into row and column indices.
 * Returns null if the reference is invalid.
 */
function parseCellReference(ref: string): { row: number; col: number } | null {
  const trimmed = ref.trim().toUpperCase();
  if (!trimmed) return null;

  // Match pattern: letters followed by numbers (e.g., "A1", "AA100", "XFD1048576")
  const match = trimmed.match(/^([A-Z]+)(\d+)$/);
  if (!match) return null;

  const colLetters = match[1];
  const rowNumber = parseInt(match[2], 10);

  // Row numbers are 1-based in display, convert to 0-based index
  if (rowNumber < 1) return null;
  const row = rowNumber - 1;

  // Convert column letters to 0-based index
  const col = letterToColumn(colLetters);

  // Validate within reasonable bounds (Excel limits: 1048576 rows, 16384 cols)
  if (row > 1048575 || col > 16383) return null;

  return { row, col };
}

/**
 * Format a selection as a display string.
 * Single cell: "A1"
 * Range: "A1:B5"
 */
function formatSelectionAddress(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number
): string {
  const startColLetter = columnToLetter(startCol);
  const startRowDisplay = startRow + 1;
  const endColLetter = columnToLetter(endCol);
  const endRowDisplay = endRow + 1;

  // Single cell
  if (startRow === endRow && startCol === endCol) {
    return `${startColLetter}${startRowDisplay}`;
  }

  // Range - normalize to top-left:bottom-right
  const minRow = Math.min(startRow, endRow);
  const maxRow = Math.max(startRow, endRow);
  const minCol = Math.min(startCol, endCol);
  const maxCol = Math.max(startCol, endCol);

  const topLeft = `${columnToLetter(minCol)}${minRow + 1}`;
  const bottomRight = `${columnToLetter(maxCol)}${maxRow + 1}`;

  return `${topLeft}:${bottomRight}`;
}

export function NameBox(): React.ReactElement {
  const { state, dispatch } = useGridContext();
  const [inputValue, setInputValue] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Get current display address from selection
  const displayAddress = state.selection
    ? formatSelectionAddress(
        state.selection.startRow,
        state.selection.startCol,
        state.selection.endRow,
        state.selection.endCol
      )
    : "A1";

  // Update input value when selection changes (and not editing)
  useEffect(() => {
    if (!isEditing) {
      setInputValue(displayAddress);
    }
  }, [displayAddress, isEditing]);

  const handleFocus = useCallback(() => {
    setIsEditing(true);
    // Select all text on focus for easy replacement
    setTimeout(() => {
      inputRef.current?.select();
    }, 0);
  }, []);

  const handleBlur = useCallback(() => {
    setIsEditing(false);
    // Reset to current selection address on blur without navigation
    setInputValue(displayAddress);
  }, [displayAddress]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const parsed = parseCellReference(inputValue);
        if (parsed) {
          // Navigate to the cell
          dispatch(setSelection(parsed.row, parsed.col, parsed.row, parsed.col, "cells"));
          dispatch(scrollToCell(parsed.row, parsed.col, false));
          setIsEditing(false);
          // Return focus to the grid
          inputRef.current?.blur();
        } else {
          // Invalid reference - reset to current selection
          setInputValue(displayAddress);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        setIsEditing(false);
        setInputValue(displayAddress);
        inputRef.current?.blur();
      }
    },
    [inputValue, displayAddress, dispatch]
  );

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setInputValue(e.target.value);
  }, []);

  return (
    <input
      ref={inputRef}
      type="text"
      value={inputValue}
      onChange={handleChange}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      style={{
        width: "80px",
        height: "22px",
        border: "1px solid #c0c0c0",
        borderRadius: "0",
        padding: "0 4px",
        fontSize: "12px",
        fontFamily: "system-ui, -apple-system, sans-serif",
        outline: "none",
        backgroundColor: isEditing ? "#ffffff" : "#f9f9f9",
      }}
      aria-label="Name Box"
    />
  );
}