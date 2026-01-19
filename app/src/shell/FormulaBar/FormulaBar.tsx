// FILENAME: shell/FormulaBar/FormulaBar.tsx
// PURPOSE: Formula bar with Name Box, Cancel/Enter buttons, and formula input
// CONTEXT: Positioned between Ribbon and Spreadsheet grid
// FEATURES: 
//   - Cancel (X) and Enter (checkmark) buttons appear during editing
//   - Insert Function (fx) button opens function dialog
//   - Formula input syncs with inline cell editor

import React, { useState, useCallback } from "react";
import { NameBox } from "./NameBox";
import { FormulaInput } from "./FormulaInput";
import { InsertFunctionDialog } from "./InsertFunctionDialog";
import { useGridContext } from "../../core/state/GridContext";
import { useEditing } from "../../core/hooks/useEditing";

// Icons using text/spans for reliable rendering
function CancelIcon(): React.ReactElement {
  return (
    <span
      style={{
        fontSize: "16px",
        fontWeight: "bold",
        lineHeight: 1,
        fontFamily: "Arial, sans-serif",
      }}
    >
      X
    </span>
  );
}

function EnterIcon(): React.ReactElement {
  // Using Unicode checkmark character
  return (
    <span
      style={{
        fontSize: "18px",
        fontWeight: "bold",
        lineHeight: 1,
        fontFamily: "Arial, sans-serif",
      }}
    >
      {"\u2713"}
    </span>
  );
}

function InsertFunctionIcon(): React.ReactElement {
  return (
    <span
      style={{
        fontSize: "14px",
        fontStyle: "italic",
        fontFamily: "Times New Roman, Georgia, serif",
        fontWeight: "normal",
        lineHeight: 1,
      }}
    >
      fx
    </span>
  );
}

export function FormulaBar(): React.ReactElement {
  const { state } = useGridContext();
  const { editing, commitEdit, cancelEdit, updateValue, startEditing } = useEditing();
  const [showFunctionDialog, setShowFunctionDialog] = useState(false);
  
  const isEditing = editing !== null;

  // FIX: Prevent mousedown from stealing focus (which would trigger blur commit)
  const handleCancelMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
  }, []);

  const handleCancel = useCallback(async () => {
    await cancelEdit();
  }, [cancelEdit]);

  // FIX: Prevent mousedown from stealing focus for Enter button too (consistency)
  const handleEnterMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
  }, []);

  const handleEnter = useCallback(async () => {
    await commitEdit();
  }, [commitEdit]);

  const handleInsertFunction = useCallback(() => {
    // If not editing, start editing with "="
    if (!editing) {
      startEditing("=");
    }
    setShowFunctionDialog(true);
  }, [editing, startEditing]);

  const handleFunctionSelect = useCallback((functionName: string, template: string) => {
    if (editing) {
      // If current value is just "=" or empty, replace with template
      const currentValue = editing.value;
      if (currentValue === "=" || currentValue === "") {
        updateValue(template);
      } else if (currentValue.endsWith("(") || currentValue.endsWith(",") || currentValue.endsWith("=")) {
        // Append function name with opening paren
        updateValue(currentValue + functionName + "(");
      } else {
        // Append the function
        updateValue(currentValue + functionName + "(");
      }
    }
    setShowFunctionDialog(false);
  }, [editing, updateValue]);

  const handleDialogClose = useCallback(() => {
    setShowFunctionDialog(false);
  }, []);

  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          height: "28px",
          borderBottom: "1px solid #d0d0d0",
          backgroundColor: "#f3f3f3",
          padding: "0 4px",
          gap: "2px",
        }}
      >
        {/* Name Box */}
        <NameBox />

        {/* Button group: Cancel, Enter, Insert Function */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            borderLeft: "1px solid #c0c0c0",
            borderRight: "1px solid #c0c0c0",
            height: "100%",
            padding: "0 2px",
            gap: "1px",
          }}
        >
          {/* Cancel button (X) - only active when editing */}
          <button
            onMouseDown={handleCancelMouseDown}
            onClick={handleCancel}
            disabled={!isEditing}
            title="Cancel (Esc)"
            style={{
              width: "24px",
              height: "24px",
              border: "none",
              backgroundColor: "transparent",
              cursor: isEditing ? "pointer" : "default",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: isEditing ? "#c42b1c" : "#a0a0a0",
              borderRadius: "2px",
              opacity: isEditing ? 1 : 0.5,
            }}
            onMouseEnter={(e) => {
              if (isEditing) {
                e.currentTarget.style.backgroundColor = "#fde7e9";
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = "transparent";
            }}
          >
            <CancelIcon />
          </button>

          {/* Enter button (checkmark) - only active when editing */}
          <button
            onMouseDown={handleEnterMouseDown}
            onClick={handleEnter}
            disabled={!isEditing}
            title="Enter"
            style={{
              width: "24px",
              height: "24px",
              border: "none",
              backgroundColor: "transparent",
              cursor: isEditing ? "pointer" : "default",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: isEditing ? "#0f7b0f" : "#a0a0a0",
              borderRadius: "2px",
              opacity: isEditing ? 1 : 0.5,
            }}
            onMouseEnter={(e) => {
              if (isEditing) {
                e.currentTarget.style.backgroundColor = "#dff6dd";
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = "transparent";
            }}
          >
            <EnterIcon />
          </button>

          {/* Insert Function button (fx) - always active */}
          <button
            onClick={handleInsertFunction}
            title="Insert Function"
            style={{
              width: "24px",
              height: "24px",
              border: "none",
              backgroundColor: "transparent",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#444444",
              borderRadius: "2px",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = "#e5e5e5";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = "transparent";
            }}
          >
            <InsertFunctionIcon />
          </button>
        </div>

        {/* Formula input area */}
        <FormulaInput />
      </div>

      {/* Insert Function Dialog */}
      {showFunctionDialog && (
        <InsertFunctionDialog
          onSelect={handleFunctionSelect}
          onClose={handleDialogClose}
        />
      )}
    </>
  );
}