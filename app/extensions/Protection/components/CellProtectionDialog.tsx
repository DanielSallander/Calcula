//! FILENAME: app/extensions/Protection/components/CellProtectionDialog.tsx
// PURPOSE: Dialog for setting cell-level protection properties (Locked, Formula Hidden).
// CONTEXT: Allows users to set which cells are locked/unlocked before protecting a sheet.

import React, { useState, useEffect } from "react";
import type { DialogProps } from "../../../src/api";
import {
  getCellProtection,
  setCellProtection,
  useGridState,
} from "../../../src/api";

// ============================================================================
// Styles
// ============================================================================

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  backgroundColor: "rgba(0, 0, 0, 0.4)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 9500,
};

const dialogStyle: React.CSSProperties = {
  backgroundColor: "#f0f0f0",
  border: "1px solid #888",
  borderRadius: 4,
  boxShadow: "0 4px 16px rgba(0, 0, 0, 0.3)",
  width: 320,
  padding: 0,
  fontFamily: "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif",
  fontSize: 13,
};

const titleBarStyle: React.CSSProperties = {
  padding: "12px 16px",
  borderBottom: "1px solid #ddd",
  fontWeight: 600,
  fontSize: 13,
};

const bodyStyle: React.CSSProperties = {
  padding: "16px",
};

const checkboxRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 0",
  fontSize: 13,
};

const noteStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#666",
  lineHeight: 1.4,
  marginTop: 12,
  padding: "8px",
  backgroundColor: "#e8e8e8",
  borderRadius: 2,
};

const buttonBarStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
  padding: "8px 16px 16px",
};

const buttonStyle: React.CSSProperties = {
  padding: "4px 16px",
  minWidth: 72,
  border: "1px solid #ababab",
  borderRadius: 2,
  backgroundColor: "#e1e1e1",
  cursor: "pointer",
  fontSize: 13,
  fontFamily: "inherit",
};

const primaryButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  backgroundColor: "#0078d4",
  color: "#fff",
  borderColor: "#0078d4",
};

// ============================================================================
// Component
// ============================================================================

export function CellProtectionDialog(props: DialogProps) {
  const { isOpen, onClose } = props;
  const gridState = useGridState();

  const [locked, setLocked] = useState(true);
  const [formulaHidden, setFormulaHidden] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Load current cell protection when dialog opens
  useEffect(() => {
    if (!isOpen) return;

    const sel = gridState.selection;
    const row = sel?.activeRow ?? 0;
    const col = sel?.activeCol ?? 0;

    getCellProtection(row, col)
      .then((prot) => {
        setLocked(prot.locked);
        setFormulaHidden(prot.formulaHidden);
      })
      .catch((err) => {
        console.error("[Protection] Failed to get cell protection:", err);
      });
  }, [isOpen, gridState.selection]);

  if (!isOpen) {
    return null;
  }

  const sel = gridState.selection;
  const startRow = sel?.startRow ?? sel?.activeRow ?? 0;
  const startCol = sel?.startCol ?? sel?.activeCol ?? 0;
  const endRow = sel?.endRow ?? sel?.activeRow ?? 0;
  const endCol = sel?.endCol ?? sel?.activeCol ?? 0;

  const handleSubmit = async () => {
    setIsSubmitting(true);

    try {
      await setCellProtection({
        startRow: Math.min(startRow, endRow),
        startCol: Math.min(startCol, endCol),
        endRow: Math.max(startRow, endRow),
        endCol: Math.max(startCol, endCol),
        locked,
        formulaHidden,
      });
      onClose();
    } catch (err) {
      console.error("[Protection] Failed to set cell protection:", err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onClose();
    } else if (e.key === "Enter" && !isSubmitting) {
      handleSubmit();
    }
  };

  return (
    <div style={overlayStyle} onKeyDown={handleKeyDown}>
      <div style={dialogStyle} role="dialog" aria-labelledby="cell-prot-title">
        <div style={titleBarStyle} id="cell-prot-title">
          Format Cells - Protection
        </div>
        <div style={bodyStyle}>
          <label style={checkboxRowStyle}>
            <input
              type="checkbox"
              checked={locked}
              onChange={(e) => setLocked(e.target.checked)}
            />
            Locked
          </label>
          <label style={checkboxRowStyle}>
            <input
              type="checkbox"
              checked={formulaHidden}
              onChange={(e) => setFormulaHidden(e.target.checked)}
            />
            Hidden
          </label>

          <div style={noteStyle}>
            Locking cells or hiding formulas has no effect until you protect
            the sheet (Review &gt; Protect Sheet).
          </div>
        </div>
        <div style={buttonBarStyle}>
          <button
            style={primaryButtonStyle}
            onClick={handleSubmit}
            disabled={isSubmitting}
          >
            OK
          </button>
          <button style={buttonStyle} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
