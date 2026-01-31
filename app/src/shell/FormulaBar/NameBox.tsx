//! FILENAME: app/src/shell/FormulaBar/NameBox.tsx
// PURPOSE: Name Box component displaying active cell address with navigation support
// CONTEXT: Shows current selection (e.g., "A1") and allows typing an address to navigate
// FIX: Now participates in global editing state to prevent grid keyboard handler
//      from capturing keystrokes and starting cell editing
// FIX: Added merge-aware navigation - when navigating to a merged cell, expands selection
// REFACTOR: Imports from api layer instead of core internals

import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  useGridContext,
  setSelection,
  scrollToCell,
  columnToLetter,
  letterToColumn,
  getMergeInfo,
} from "../../api";
import { setGlobalIsEditing } from "../../api/editing";
import * as S from './NameBox.styles';

function parseCellReference(ref: string): { row: number; col: number } | null {
  const trimmed = ref.trim().toUpperCase();
  if (!trimmed) return null;

  const match = trimmed.match(/^([A-Z]+)(\d+)$/);
  if (!match) return null;

  const colLetters = match[1];
  const rowNumber = parseInt(match[2], 10);

  if (rowNumber < 1) return null;
  const row = rowNumber - 1;

  const col = letterToColumn(colLetters);

  if (row > 1048575 || col > 16383) return null;

  return { row, col };
}

function formatSelectionAddress(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number
): string {
  const startColLetter = columnToLetter(startCol);
  const startRowDisplay = startRow + 1;

  if (startRow === endRow && startCol === endCol) {
    return `${startColLetter}${startRowDisplay}`;
  }

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

  const displayAddress = state.selection
    ? formatSelectionAddress(
        state.selection.startRow,
        state.selection.startCol,
        state.selection.endRow,
        state.selection.endCol
      )
    : "A1";

  useEffect(() => {
    if (!isEditing) {
      setInputValue(displayAddress);
    }
  }, [displayAddress, isEditing]);

  useEffect(() => {
    if (!isEditing) return;

    const handleMouseDown = (e: MouseEvent) => {
      if (inputRef.current && !inputRef.current.contains(e.target as Node)) {
        setIsEditing(false);
        setGlobalIsEditing(false);
        setInputValue(displayAddress);
      }
    };

    document.addEventListener("mousedown", handleMouseDown, { capture: true });
    return () => {
      document.removeEventListener("mousedown", handleMouseDown, { capture: true });
    };
  }, [isEditing, displayAddress]);

  const handleFocus = useCallback(() => {
    setIsEditing(true);
    setGlobalIsEditing(true);
    setTimeout(() => {
      inputRef.current?.select();
    }, 0);
  }, []);

  const handleBlur = useCallback(() => {
    setIsEditing(false);
    setGlobalIsEditing(false);
    setInputValue(displayAddress);
  }, [displayAddress]);

  const navigateToCell = useCallback(
    async (row: number, col: number) => {
      try {
        const mergeInfo = await getMergeInfo(row, col);
        
        if (mergeInfo) {
          dispatch(setSelection({
            startRow: mergeInfo.startRow,
            startCol: mergeInfo.startCol,
            endRow: mergeInfo.endRow,
            endCol: mergeInfo.endCol,
            type: "cells",
          }));
          dispatch(scrollToCell(mergeInfo.startRow, mergeInfo.startCol, false));
        } else {
          dispatch(setSelection({
            startRow: row,
            startCol: col,
            endRow: row,
            endCol: col,
            type: "cells",
          }));
          dispatch(scrollToCell(row, col, false));
        }
      } catch (error) {
        console.error('[NameBox] Failed to get merge info:', error);
        dispatch(setSelection({
          startRow: row,
          startCol: col,
          endRow: row,
          endCol: col,
          type: "cells",
        }));
        dispatch(scrollToCell(row, col, false));
      }
    },
    [dispatch]
  );

  const handleKeyDown = useCallback(
    async (e: React.KeyboardEvent<HTMLInputElement>) => {
      e.stopPropagation();

      if (e.key === "Enter") {
        e.preventDefault();
        const parsed = parseCellReference(inputValue);
        if (parsed) {
          await navigateToCell(parsed.row, parsed.col);
          setIsEditing(false);
          setGlobalIsEditing(false);
          inputRef.current?.blur();
        } else {
          setInputValue(displayAddress);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        setIsEditing(false);
        setGlobalIsEditing(false);
        setInputValue(displayAddress);
        inputRef.current?.blur();
      }
    },
    [inputValue, displayAddress, navigateToCell]
  );

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setInputValue(e.target.value);
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLInputElement>) => {
    e.stopPropagation();
  }, []);

  return (
    <S.StyledNameBoxInput
      ref={inputRef}
      type="text"
      value={inputValue}
      onChange={handleChange}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      onMouseDown={handleMouseDown}
      isEditing={isEditing}
      aria-label="Name Box"
    />
  );
}