//! FILENAME: app/src/shell/FormulaBar/FormulaInput.tsx
// PURPOSE: Formula input field that syncs with cell editing state
// CONTEXT: Part of FormulaBar, displays and edits the current cell formula/value
// FIX: Now fetches content from master cell for merged regions
// FIX: Added F4 key handler for toggling absolute/relative cell references
// FIX: Parses formula references on selection change for passive highlighting
// REFACTOR: Imports from api layer instead of core internals

import React, { useCallback, useRef, useEffect } from "react";
import { useGridContext, getCell, getMergeInfo, isSheetProtected, getCellProtection } from "../../api";
import { useEditing, setGlobalIsEditing, getGlobalEditingValue, setGlobalCursorPosition, getGlobalCursorPosition } from "../../api/editing";
import { toggleReferenceAtCursor } from "../../core/lib/formulaRefToggle";
import { parseFormulaReferences } from "../../core/lib/formulaRefParser";
import { setFormulaReferences, clearFormulaReferences } from "../../core/state/gridActions";
import { isFormulaAutocompleteVisible, AutocompleteEvents } from "../../api/formulaAutocomplete";
import * as S from './FormulaInput.styles';

export function FormulaInput(): React.ReactElement {
  const { state, dispatch } = useGridContext();
  const { editing, updateValue, commitEdit, cancelEdit, startEdit } = useEditing();
  const inputRef = useRef<HTMLInputElement>(null);
  const [displayValue, setDisplayValue] = React.useState("");
  const [isFocused, setIsFocused] = React.useState(false);
  const [prevEditing, setPrevEditing] = React.useState(editing);

  // Sync displayValue with editing state (render-time derived state pattern)
  if (editing !== prevEditing) {
    setPrevEditing(editing);
    if (editing) {
      setDisplayValue(editing.value);
    }
  }

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
            let content = cell.formula || cell.display || "";

            // Formula hiding: if sheet is protected and cell has formulaHidden, show blank
            if (cell.formula && cell.formula.startsWith("=")) {
              try {
                const [sheetProt, cellProt] = await Promise.all([
                  isSheetProtected(),
                  getCellProtection(cellRow, cellCol),
                ]);
                if (sheetProt && cellProt.formulaHidden) {
                  content = "";
                }
              } catch {
                // Ignore errors - show formula as fallback
              }
            }

            setDisplayValue(content);

            // FIX: Parse formula references for passive highlighting when selecting a formula cell
            if (content && content.startsWith("=")) {
              const refs = parseFormulaReferences(content, true);
              dispatch(setFormulaReferences(refs));
            } else {
              dispatch(clearFormulaReferences());
            }
          } else {
            setDisplayValue("");
            dispatch(clearFormulaReferences());
          }
        } catch (error) {
          console.error("[FormulaInput] Failed to fetch cell content:", error);
          setDisplayValue("");
          dispatch(clearFormulaReferences());
        }
      };
      
      fetchCellContent();
    }
  }, [editing, state.selection, dispatch]);

  // Listen for autocomplete accepted events to update the formula bar value
  React.useEffect(() => {
    const handleAccepted = (e: Event) => {
      const { newValue, newCursorPosition } = (e as CustomEvent).detail;
      setDisplayValue(newValue);
      if (editing) {
        updateValue(newValue);
      }
      requestAnimationFrame(() => {
        if (inputRef.current) {
          inputRef.current.setSelectionRange(newCursorPosition, newCursorPosition);
        }
      });
    };

    window.addEventListener(AutocompleteEvents.ACCEPTED, handleAccepted);
    return () => window.removeEventListener(AutocompleteEvents.ACCEPTED, handleAccepted);
  }, [editing, updateValue]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = e.target.value;
      setDisplayValue(newValue);
      if (editing) {
        updateValue(newValue);
      }

      // FIX: Track cursor position globally for cursor-aware formula mode detection
      const inputEl = inputRef.current;
      const cursorPos = inputEl?.selectionStart ?? newValue.length;
      setGlobalCursorPosition(cursorPos);

      // Emit autocomplete input event with cursor position and anchor rect
      if (inputEl) {
        const rect = inputEl.getBoundingClientRect();
        window.dispatchEvent(
          new CustomEvent(AutocompleteEvents.INPUT, {
            detail: {
              value: newValue,
              cursorPosition: cursorPos,
              anchorRect: {
                x: rect.left,
                y: rect.bottom,
                width: rect.width,
                height: rect.height,
              },
              source: "formulaBar",
            },
          })
        );
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

  /**
   * FIX: Track cursor position changes from arrow keys, mouse clicks within input, etc.
   * This ensures globalCursorPosition stays accurate even when the value doesn't change.
   */
  const handleSelect = useCallback(() => {
    if (inputRef.current) {
      setGlobalCursorPosition(inputRef.current.selectionStart ?? inputRef.current.value.length);
    }
  }, []);

  const handleKeyDown = useCallback(
    async (e: React.KeyboardEvent<HTMLInputElement>) => {
      e.stopPropagation();

      // Intercept keys for formula autocomplete when the dropdown is visible
      if (isFormulaAutocompleteVisible()) {
        const autocompleteKeys = ["ArrowUp", "ArrowDown", "Tab", "Escape", "Enter"];
        if (autocompleteKeys.includes(e.key)) {
          e.preventDefault();
          window.dispatchEvent(
            new CustomEvent(AutocompleteEvents.KEY, {
              detail: { key: e.key },
            })
          );
          return;
        }
      }

      if (e.key === "Enter") {
        e.preventDefault();
        const shiftKey = e.shiftKey;
        const result = await commitEdit();
        inputRef.current?.blur();
        // FIX: Dispatch event so core layer can move active cell and restore focus
        // The core layer (useSpreadsheetEditing) listens for this event
        if (result?.success) {
          window.dispatchEvent(new CustomEvent("formulaBar:commitComplete", {
            detail: { key: "Enter", shiftKey }
          }));
        }
      } else if (e.key === "Tab") {
        e.preventDefault();
        const shiftKey = e.shiftKey;
        const result = await commitEdit();
        inputRef.current?.blur();
        // FIX: Dispatch event so core layer can move active cell and restore focus
        if (result?.success) {
          window.dispatchEvent(new CustomEvent("formulaBar:commitComplete", {
            detail: { key: "Tab", shiftKey }
          }));
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        await cancelEdit();
        inputRef.current?.blur();
        // FIX: Dispatch event so core layer can restore focus to grid
        window.dispatchEvent(new CustomEvent("formulaBar:commitComplete", {
          detail: { key: "Escape", shiftKey: false }
        }));
      } else if (e.key === "F4") {
        // FIX: Toggle absolute/relative reference mode on the cell reference
        // at the current cursor position. Only active when editing a formula.
        const inputEl = inputRef.current;
        if (!inputEl) return;
        
        // Use global value (updated synchronously) with fallback to DOM
        const currentValue = getGlobalEditingValue() || inputEl.value;
        if (currentValue.startsWith("=")) {
          e.preventDefault();
          e.stopPropagation();
          const cursorPos = inputEl.selectionStart ?? 0;
          const result = toggleReferenceAtCursor(currentValue, cursorPos);
          if (result.formula !== currentValue) {
            setDisplayValue(result.formula);
            updateValue(result.formula);
            // Restore cursor position after React re-renders the input value
            requestAnimationFrame(() => {
              inputEl.setSelectionRange(result.cursorPos, result.cursorPos);
            });
          }
        }
      }
    },
    [commitEdit, cancelEdit, updateValue]
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
      onSelect={handleSelect}
      $isFocused={isFocused}
      data-formula-bar="true"
      placeholder=""
      aria-label="Formula Bar"
    />
  );
}