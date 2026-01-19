// FILENAME: shell/FormulaBar/FormulaBar.tsx
// PURPOSE: Formula bar with Name Box, Cancel/Enter buttons, and formula input
// CONTEXT: Positioned between Ribbon and Spreadsheet grid
// FEATURES: 
//   - Cancel (X) and Enter (checkmark) buttons appear during editing
//   - Insert Function (fx) button opens function dialog
//   - Formula input syncs with inline cell editor

import React, { useState, useCallback, useRef, useEffect } from "react";
import { NameBox } from "./NameBox";
import { FormulaInput } from "./FormulaInput";
import { InsertFunctionDialog } from "./InsertFunctionDialog";
import { useGridContext } from "../../core/state/GridContext";
import { useEditing, setGlobalIsEditing } from "../../core/hooks/useEditing";

// Icons as simple SVG components
function CancelIcon(): React.ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path
        d="M2 2L10 10M10 2L2 10"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function EnterIcon(): React.ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path
        d="M2 6L5 9L10 3"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function InsertFunctionIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <text
        x="7"
        y="11"
        textAnchor="middle"
        fontSize="10"
        fontStyle="italic"
        fontFamily="serif"
        fill="currentColor"
      >
        fx
      </text>
    </svg>
  );
}

export function FormulaBar(): React.ReactElement {
  const { state } = useGridContext();
  const { editing, commitEdit, cancelEdit, updateValue, startEditing } = useEditing();
  const [showFunctionDialog, setShowFunctionDialog] = useState(false);
  
  const isEditing = editing !== null;

  const handleCancel = useCallback(() => {
    cancelEdit();
  }, [cancelEdit]);

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
          {/* Cancel button - only visible when editing */}
          <button
            onClick={handleCancel}
            disabled={!isEditing}
            title="Cancel (Esc)"
            style={{
              width: "22px",
              height: "22px",
              border: "none",
              backgroundColor: "transparent",
              cursor: isEditing ? "pointer" : "default",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: isEditing ? "#c00000" : "#cccccc",
              borderRadius: "2px",
              opacity: isEditing ? 1 : 0.4,
            }}
            onMouseEnter={(e) => {
              if (isEditing) {
                e.currentTarget.style.backgroundColor = "#e8e8e8";
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = "transparent";
            }}
          >
            <CancelIcon />
          </button>

          {/* Enter button - only visible when editing */}
          <button
            onClick={handleEnter}
            disabled={!isEditing}
            title="Enter"
            style={{
              width: "22px",
              height: "22px",
              border: "none",
              backgroundColor: "transparent",
              cursor: isEditing ? "pointer" : "default",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: isEditing ? "#008000" : "#cccccc",
              borderRadius: "2px",
              opacity: isEditing ? 1 : 0.4,
            }}
            onMouseEnter={(e) => {
              if (isEditing) {
                e.currentTarget.style.backgroundColor = "#e8e8e8";
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = "transparent";
            }}
          >
            <EnterIcon />
          </button>

          {/* Insert Function button - always active */}
          <button
            onClick={handleInsertFunction}
            title="Insert Function"
            style={{
              width: "22px",
              height: "22px",
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
              e.currentTarget.style.backgroundColor = "#e8e8e8";
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