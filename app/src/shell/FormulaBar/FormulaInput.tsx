// FILENAME: shell/FormulaBar/FormulaInput.tsx
// PURPOSE: Formula input field that syncs with cell editing state
// CONTEXT: Part of FormulaBar, displays and edits the current cell formula/value
// FIX: Now fetches content from master cell for merged regions

import React, { useCallback, useRef, useEffect } from "react";
import { useGridContext } from "../../core/state/GridContext";
import { useEditing, setGlobalIsEditing } from "../../core/hooks/useEditing";
import { getCell, getMergeInfo } from "../../core/lib/tauri-api";

export function FormulaInput(): React.ReactElement {
  const { state } = useGridContext();
  const { editing, updateValue, commitEdit, cancelEdit, startEdit } = useEditing();
  const inputRef = useRef<HTMLInputElement>(null);
  const [displayValue, setDisplayValue] = React.useState("");

  // Track if we're focused on the formula bar input
  const [isFocused, setIsFocused] = React.useState(false);

  // Update display value when editing state changes
  useEffect(() => {
    if (editing) {
      setDisplayValue(editing.value);
    }
  }, [editing]);

  // Fetch cell content when selection changes and not editing
  // FIX: For merged cells, fetch from the master cell (top-left of merge)
  useEffect(() => {
    if (!editing && state.selection) {
      const { startRow, startCol, endRow, endCol } = state.selection;
      
      // FIX: Determine which cell to fetch content from
      // For merged regions, we need the master cell (top-left)
      // The selection's startRow/startCol should be the master cell,
      // but we verify with getMergeInfo to be safe
      const fetchCellContent = async () => {
        try {
          // Check if this selection covers a merged region
          // Use startRow/startCol as that's typically the master cell
          const mergeInfo = await getMergeInfo(startRow, startCol);
          
          let cellRow = startRow;
          let cellCol = startCol;
          
          if (mergeInfo) {
            // Use the master cell from merge info
            cellRow = mergeInfo.startRow;
            cellCol = mergeInfo.startCol;
          } else {
            // For non-merged selections, use the active cell (endRow, endCol)
            // But first check if the active cell is part of a different merge
            const activeMerge = await getMergeInfo(endRow, endCol);
            if (activeMerge) {
              cellRow = activeMerge.startRow;
              cellCol = activeMerge.startCol;
            } else {
              cellRow = endRow;
              cellCol = endCol;
            }
          }
          
          const cell = await getCell(cellRow, cellCol);
          if (cell) {
            setDisplayValue(cell.formula || cell.display || "");
          } else {
            setDisplayValue("");
          }
        } catch (error) {
          console.error("[FormulaInput] Failed to fetch cell content:", error);
          setDisplayValue("");
        }
      };
      
      fetchCellContent();
    }
  }, [editing, state.selection]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = e.target.value;
      setDisplayValue(newValue);
      if (editing) {
        updateValue(newValue);
      }
    },
    [editing, updateValue]
  );

  const handleFocus = useCallback(async () => {
    setIsFocused(true);
    setGlobalIsEditing(true);
    
    // Start editing if not already editing
    if (!editing && state.selection) {
      await startEdit(state.selection.endRow, state.selection.endCol);
    }
  }, [editing, state.selection, startEdit]);

  const handleBlur = useCallback(() => {
    setIsFocused(false);
    // Don't clear global editing here - let commit/cancel handle it
  }, []);

  const handleKeyDown = useCallback(
    async (e: React.KeyboardEvent<HTMLInputElement>) => {
      e.stopPropagation();

      if (e.key === "Enter") {
        e.preventDefault();
        await commitEdit();
        inputRef.current?.blur();
      } else if (e.key === "Escape") {
        e.preventDefault();
        // FIX: Await cancelEdit and ensure we don't commit
        await cancelEdit();
        inputRef.current?.blur();
      }
    },
    [commitEdit, cancelEdit]
  );

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
  }, []);

  return (
    <input
      ref={inputRef}
      type="text"
      value={displayValue}
      onChange={handleChange}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      onMouseDown={handleMouseDown}
      data-formula-bar="true"
      placeholder=""
      style={{
        flex: 1,
        height: "22px",
        border: "1px solid #c0c0c0",
        borderRadius: "0",
        padding: "0 4px",
        fontSize: "12px",
        fontFamily: "Consolas, 'Courier New', monospace",
        outline: "none",
        backgroundColor: isFocused ? "#ffffff" : "#fafafa",
        color: "#000000",
      }}
      aria-label="Formula Bar"
    />
  );
}