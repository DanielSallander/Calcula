//! FILENAME: app/src/shell/FormulaBar/NameBox.tsx
// PURPOSE: Name Box component displaying active cell address (or named range name)
//          with navigation, name creation, and dropdown support.
// CONTEXT: Shows current selection (e.g., "A1" or "SalesData") and allows typing
//          an address or name to navigate. Supports creating new names from input.
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
  getNamedRangeForSelection,
  getAllNamedRanges,
  createNamedRange,
  getNamedRange,
  AppEvents,
  emitAppEvent,
  onAppEvent,
} from "../../api";
import type { NamedRange } from "../../api";
import { setGlobalIsEditing } from "../../api/editing";
import { NameBoxDropdown } from "./NameBoxDropdown";
import * as S from "./NameBox.styles";

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

/**
 * Build a refersTo formula string from selection coordinates.
 * Example: "=Sheet1!$A$1:$B$10"
 */
function buildRefersTo(
  sheetName: string,
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number
): string {
  const minRow = Math.min(startRow, endRow);
  const maxRow = Math.max(startRow, endRow);
  const minCol = Math.min(startCol, endCol);
  const maxCol = Math.max(startCol, endCol);

  const startRef = `$${columnToLetter(minCol)}$${minRow + 1}`;
  const endRef = `$${columnToLetter(maxCol)}$${maxRow + 1}`;

  if (minRow === maxRow && minCol === maxCol) {
    return `=${sheetName}!${startRef}`;
  }
  return `=${sheetName}!${startRef}:${endRef}`;
}

/**
 * Basic client-side name validation matching Rust rules.
 */
function isValidName(name: string): boolean {
  if (!name || name.length === 0) return false;

  const first = name[0];
  if (!/[a-zA-Z_]/.test(first)) return false;

  for (let i = 1; i < name.length; i++) {
    const ch = name[i];
    if (!/[a-zA-Z0-9_.]/.test(ch)) return false;
  }

  const upper = name.toUpperCase();
  if (upper === "TRUE" || upper === "FALSE" || upper === "NULL") return false;

  // Cannot be a cell reference
  if (parseCellReference(name) !== null) return false;

  return true;
}

export function NameBox(): React.ReactElement {
  const { state, dispatch } = useGridContext();
  const [inputValue, setInputValue] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [matchedName, setMatchedName] = useState<string | null>(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const [dropdownNames, setDropdownNames] = useState<NamedRange[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const displayAddress = state.selection
    ? formatSelectionAddress(
        state.selection.startRow,
        state.selection.startCol,
        state.selection.endRow,
        state.selection.endCol
      )
    : "A1";

  // Check if the current selection matches a named range
  useEffect(() => {
    if (!state.selection || isEditing) return;

    let cancelled = false;
    const sel = state.selection;

    getNamedRangeForSelection(
      state.sheetContext.activeSheetIndex,
      Math.min(sel.startRow, sel.endRow),
      Math.min(sel.startCol, sel.endCol),
      Math.max(sel.startRow, sel.endRow),
      Math.max(sel.startCol, sel.endCol)
    )
      .then((nr) => {
        if (cancelled) return;
        if (nr) {
          setMatchedName(nr.name);
        } else {
          setMatchedName(null);
        }
      })
      .catch(() => {
        if (!cancelled) setMatchedName(null);
      });

    return () => {
      cancelled = true;
    };
  }, [
    state.selection?.startRow,
    state.selection?.startCol,
    state.selection?.endRow,
    state.selection?.endCol,
    state.sheetContext.activeSheetIndex,
    isEditing,
  ]);

  // Listen for named range changes to refresh the matched name
  useEffect(() => {
    return onAppEvent(AppEvents.NAMED_RANGES_CHANGED, () => {
      setMatchedName(null); // Will re-check on next render cycle
    });
  }, []);

  // The displayed value: either a matched name or the cell address
  const displayValue = matchedName ?? displayAddress;

  // Sync inputValue with displayValue when not editing
  const [prevDisplay, setPrevDisplay] = useState(displayValue);
  if (displayValue !== prevDisplay) {
    setPrevDisplay(displayValue);
    if (!isEditing) {
      setInputValue(displayValue);
    }
  }

  useEffect(() => {
    if (!isEditing) return;

    const handleMouseDown = (e: MouseEvent) => {
      if (inputRef.current && !inputRef.current.contains(e.target as Node)) {
        setIsEditing(false);
        setGlobalIsEditing(false);
        setInputValue(displayValue);
      }
    };

    document.addEventListener("mousedown", handleMouseDown, { capture: true });
    return () => {
      document.removeEventListener("mousedown", handleMouseDown, {
        capture: true,
      });
    };
  }, [isEditing, displayValue]);

  const handleFocus = useCallback(() => {
    setIsEditing(true);
    setGlobalIsEditing(true);
    setShowDropdown(false);
    setTimeout(() => {
      inputRef.current?.select();
    }, 0);
  }, []);

  const handleBlur = useCallback(() => {
    setIsEditing(false);
    setGlobalIsEditing(false);
    setInputValue(displayValue);
  }, [displayValue]);

  const navigateToCell = useCallback(
    async (row: number, col: number) => {
      try {
        const mergeInfo = await getMergeInfo(row, col);

        if (mergeInfo) {
          dispatch(
            setSelection({
              startRow: mergeInfo.startRow,
              startCol: mergeInfo.startCol,
              endRow: mergeInfo.endRow,
              endCol: mergeInfo.endCol,
              type: "cells",
            })
          );
          dispatch(scrollToCell(mergeInfo.startRow, mergeInfo.startCol, false));
        } else {
          dispatch(
            setSelection({
              startRow: row,
              startCol: col,
              endRow: row,
              endCol: col,
              type: "cells",
            })
          );
          dispatch(scrollToCell(row, col, false));
        }
      } catch (error) {
        console.error("[NameBox] Failed to get merge info:", error);
        dispatch(
          setSelection({
            startRow: row,
            startCol: col,
            endRow: row,
            endCol: col,
            type: "cells",
          })
        );
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
        const value = inputValue.trim();

        // 1. Try as cell reference
        const parsed = parseCellReference(value);
        if (parsed) {
          await navigateToCell(parsed.row, parsed.col);
          setIsEditing(false);
          setGlobalIsEditing(false);
          inputRef.current?.blur();
          return;
        }

        // 2. Try as existing named range (navigate to it)
        try {
          const nr = await getNamedRange(value);
          if (nr) {
            // Parse the refersTo to extract coordinates and navigate
            // For simple ranges, try to parse them out
            const refMatch = nr.refersTo.match(
              /^=(?:([^!]+)!)?\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?(\d+))?$/i
            );
            if (refMatch) {
              const startCol = letterToColumn(refMatch[2].toUpperCase());
              const startRow = parseInt(refMatch[3], 10) - 1;
              const endCol = refMatch[4]
                ? letterToColumn(refMatch[4].toUpperCase())
                : startCol;
              const endRow = refMatch[5]
                ? parseInt(refMatch[5], 10) - 1
                : startRow;

              dispatch(
                setSelection({
                  startRow,
                  startCol,
                  endRow,
                  endCol,
                  type: "cells",
                })
              );
              dispatch(scrollToCell(startRow, startCol, false));
            }
            setIsEditing(false);
            setGlobalIsEditing(false);
            inputRef.current?.blur();
            return;
          }
        } catch {
          // Ignore lookup errors
        }

        // 3. Try to create a new named range for the current selection
        if (isValidName(value) && state.selection) {
          const sel = state.selection;
          const refersTo = buildRefersTo(
            state.sheetContext.activeSheetName,
            sel.startRow,
            sel.startCol,
            sel.endRow,
            sel.endCol
          );

          try {
            const result = await createNamedRange(value, null, refersTo);
            if (result.success) {
              setMatchedName(value);
              emitAppEvent(AppEvents.NAMED_RANGES_CHANGED);
            } else {
              console.warn("[NameBox] Failed to create name:", result.error);
            }
          } catch (error) {
            console.error("[NameBox] Failed to create named range:", error);
          }

          setIsEditing(false);
          setGlobalIsEditing(false);
          inputRef.current?.blur();
        } else {
          // Invalid input - revert
          setInputValue(displayValue);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        setIsEditing(false);
        setGlobalIsEditing(false);
        setInputValue(displayValue);
        inputRef.current?.blur();
      }
    },
    [inputValue, displayValue, navigateToCell, state.selection, state.sheetContext, dispatch]
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setInputValue(e.target.value);
    },
    []
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLInputElement>) => {
      e.stopPropagation();
    },
    []
  );

  const handleDropdownToggle = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (showDropdown) {
        setShowDropdown(false);
        return;
      }

      try {
        const names = await getAllNamedRanges();
        setDropdownNames(names);
        setShowDropdown(true);
      } catch (error) {
        console.error("[NameBox] Failed to fetch named ranges:", error);
      }
    },
    [showDropdown]
  );

  const handleDropdownSelect = useCallback(
    (nr: NamedRange) => {
      setShowDropdown(false);

      // Parse refersTo and navigate
      const refMatch = nr.refersTo.match(
        /^=(?:([^!]+)!)?\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?(\d+))?$/i
      );
      if (refMatch) {
        const startCol = letterToColumn(refMatch[2].toUpperCase());
        const startRow = parseInt(refMatch[3], 10) - 1;
        const endCol = refMatch[4]
          ? letterToColumn(refMatch[4].toUpperCase())
          : startCol;
        const endRow = refMatch[5]
          ? parseInt(refMatch[5], 10) - 1
          : startRow;

        dispatch(
          setSelection({
            startRow,
            startCol,
            endRow,
            endCol,
            type: "cells",
          })
        );
        dispatch(scrollToCell(startRow, startCol, false));
      }
    },
    [dispatch]
  );

  const handleDropdownClose = useCallback(() => {
    setShowDropdown(false);
  }, []);

  return (
    <S.NameBoxWrapper>
      <S.StyledNameBoxInput
        ref={inputRef}
        type="text"
        value={inputValue}
        onChange={handleChange}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        onMouseDown={handleMouseDown}
        $isEditing={isEditing}
        aria-label="Name Box"
      />
      <S.DropdownArrow
        onMouseDown={handleDropdownToggle}
        tabIndex={-1}
        aria-label="Show named ranges"
      >
        &#9660;
      </S.DropdownArrow>
      {showDropdown && (
        <NameBoxDropdown
          names={dropdownNames}
          onSelect={handleDropdownSelect}
          onClose={handleDropdownClose}
        />
      )}
    </S.NameBoxWrapper>
  );
}
