//! FILENAME: app/src/shell/FormulaBar/FormulaInput.tsx
// PURPOSE: Formula input field that syncs with cell editing state
// CONTEXT: Part of FormulaBar, displays and edits the current cell formula/value
// FIX: Now fetches content from master cell for merged regions
// REFACTOR: Imports from api layer instead of core internals

import React, { useCallback, useRef, useEffect } from "react";
import { useGridContext, getCell, getMergeInfo } from "../../api";
import { useEditing, setGlobalIsEditing } from "../../api/editing";
import * as S from './FormulaInput.styles';

export function FormulaInput(): React.ReactElement {
  const { state } = useGridContext();
  const { editing, updateValue, commitEdit, cancelEdit, startEdit } = useEditing();
  const inputRef = useRef<HTMLInputElement>(null);
  const [displayValue, setDisplayValue] = React.useState("");
  const [isFocused, setIsFocused] = React.useState(false);

  useEffect(() => {
    if (editing) {
      setDisplayValue(editing.value);
    }
  }, [editing]);

  useEffect(() => {
    if (!editing && state.selection) {
      const { startRow, startCol, endRow, endCol } = state.selection;
      
      const fetchCellContent = async () => {
        try {
          const mergeInfo = await getMergeInfo(startRow, startCol);
          
          let cellRow = startRow;
          let cellCol = startCol;
          
          if (mergeInfo) {
            cellRow = mergeInfo.startRow;
            cellCol = mergeInfo.startCol;
          } else {
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
    
    if (!editing && state.selection) {
      await startEdit(state.selection.endRow, state.selection.endCol);
    }
  }, [editing, state.selection, startEdit]);

  const handleBlur = useCallback(() => {
    setIsFocused(false);
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
    <S.StyledInput
      ref={inputRef}
      type="text"
      value={displayValue}
      onChange={handleChange}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      onMouseDown={handleMouseDown}
      $isFocused={isFocused}
      data-formula-bar="true"
      placeholder=""
      aria-label="Formula Bar"
    />
  );
}