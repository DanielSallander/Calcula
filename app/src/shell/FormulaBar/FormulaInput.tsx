// FILENAME: shell/FormulaBar/FormulaInput.tsx
// PURPOSE: Formula input field that syncs with cell editing state
// CONTEXT: Part of FormulaBar, displays and edits the current cell formula/value

import React, { useCallback, useRef, useEffect } from "react";
import { useGridContext } from "../../core/state/GridContext";
import { useEditing, setGlobalIsEditing } from "../../core/hooks/useEditing";
import { getCell } from "../../core/lib/tauri-api";

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
  useEffect(() => {
    if (!editing && state.selection) {
      const { endRow, endCol } = state.selection;
      getCell(endRow, endCol).then((cell) => {
        if (cell) {
          setDisplayValue(cell.formula || cell.display || "");
        } else {
          setDisplayValue("");
        }
      }).catch(() => {
        setDisplayValue("");
      });
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
        cancelEdit();
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