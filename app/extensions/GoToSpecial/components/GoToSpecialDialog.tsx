//! FILENAME: app/extensions/GoToSpecial/components/GoToSpecialDialog.tsx
// PURPOSE: Go To Special dialog - select cells by type (blanks, formulas, etc.)

import React, { useState, useCallback } from "react";
import type { DialogProps } from "@api/uiTypes";
import {
  goToSpecial,
  useGridDispatch,
  setSelection,
  useGridState,
  restoreFocusToGrid,
} from "@api";
import type { GoToSpecialCriteria } from "@api";

const CRITERIA_OPTIONS: Array<{ value: GoToSpecialCriteria; label: string }> = [
  { value: "blanks", label: "Blanks" },
  { value: "formulas", label: "Formulas" },
  { value: "constants", label: "Constants" },
  { value: "errors", label: "Errors" },
  { value: "comments", label: "Comments" },
  { value: "notes", label: "Notes" },
  { value: "conditionalFormats", label: "Conditional Formats" },
  { value: "dataValidation", label: "Data Validation" },
];

const styles = {
  backdrop: {
    position: "fixed" as const,
    inset: 0,
    zIndex: 1050,
    background: "rgba(0, 0, 0, 0.45)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  dialog: {
    background: "var(--panel-bg, #1e1e1e)",
    border: "1px solid var(--border-default, #3c3c3c)",
    borderRadius: 8,
    boxShadow: "0 12px 40px rgba(0, 0, 0, 0.5)",
    width: 320,
    display: "flex",
    flexDirection: "column" as const,
    color: "var(--text-primary, #cccccc)",
    fontFamily: '"Segoe UI", system-ui, sans-serif',
    fontSize: 13,
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "12px 16px 8px",
    borderBottom: "1px solid var(--border-default, #3c3c3c)",
  },
  title: {
    fontSize: 14,
    fontWeight: 600,
  },
  closeBtn: {
    background: "none",
    border: "none",
    color: "var(--text-secondary, #999)",
    fontSize: 18,
    cursor: "pointer",
    padding: "2px 6px",
    lineHeight: 1,
  },
  body: {
    padding: "12px 16px",
    display: "flex",
    flexDirection: "column" as const,
    gap: 6,
  },
  radioRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "3px 0",
    cursor: "pointer",
  },
  radioInput: {
    margin: 0,
    cursor: "pointer",
  },
  radioLabel: {
    cursor: "pointer",
    userSelect: "none" as const,
  },
  footer: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 8,
    padding: "8px 16px 12px",
    borderTop: "1px solid var(--border-default, #3c3c3c)",
  },
  btn: {
    padding: "5px 16px",
    borderRadius: 4,
    border: "1px solid var(--border-default, #3c3c3c)",
    background: "var(--button-bg, #333)",
    color: "var(--text-primary, #ccc)",
    cursor: "pointer",
    fontSize: 13,
  },
  btnPrimary: {
    padding: "5px 16px",
    borderRadius: 4,
    border: "none",
    background: "var(--accent-bg, #0078d4)",
    color: "#ffffff",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 600,
  },
  status: {
    padding: "4px 16px 8px",
    fontSize: 12,
    color: "var(--text-secondary, #999)",
  },
};

export function GoToSpecialDialog({ isOpen, onClose }: DialogProps): React.ReactElement | null {
  const [selectedCriteria, setSelectedCriteria] = useState<GoToSpecialCriteria>("blanks");
  const [statusMessage, setStatusMessage] = useState<string>("");
  const [isSearching, setIsSearching] = useState(false);
  const dispatch = useGridDispatch();
  const gridState = useGridState();

  const handleOk = useCallback(async () => {
    setIsSearching(true);
    setStatusMessage("Searching...");

    try {
      // Use current selection as search range if it's a multi-cell selection
      const sel = gridState.selection;
      let searchRange: { startRow: number; startCol: number; endRow: number; endCol: number } | undefined;
      if (sel && (sel.startRow !== sel.endRow || sel.startCol !== sel.endCol)) {
        searchRange = {
          startRow: Math.min(sel.startRow, sel.endRow),
          startCol: Math.min(sel.startCol, sel.endCol),
          endRow: Math.max(sel.startRow, sel.endRow),
          endCol: Math.max(sel.startCol, sel.endCol),
        };
      }

      const result = await goToSpecial(selectedCriteria, searchRange);

      if (result.cells.length === 0) {
        setStatusMessage("No cells found matching the criteria.");
        setIsSearching(false);
        return;
      }

      // Select all found cells using multi-selection
      // For simplicity, select the bounding range of all found cells
      let minRow = result.cells[0].row;
      let maxRow = result.cells[0].row;
      let minCol = result.cells[0].col;
      let maxCol = result.cells[0].col;

      for (const cell of result.cells) {
        minRow = Math.min(minRow, cell.row);
        maxRow = Math.max(maxRow, cell.row);
        minCol = Math.min(minCol, cell.col);
        maxCol = Math.max(maxCol, cell.col);
      }

      // If only one type of cells, we can select the first one and create
      // additional ranges for the rest. For now, select bounding range.
      dispatch(setSelection({
        startRow: minRow,
        startCol: minCol,
        endRow: maxRow,
        endCol: maxCol,
        type: "cells",
        additionalRanges: result.cells.length <= 1000
          ? result.cells.map(c => ({
              startRow: c.row,
              startCol: c.col,
              endRow: c.row,
              endCol: c.col,
            }))
          : undefined,
      }));

      setStatusMessage(`Found ${result.cells.length} cell(s).`);
      onClose();
      restoreFocusToGrid();
    } catch (error) {
      setStatusMessage(`Error: ${error}`);
    } finally {
      setIsSearching(false);
    }
  }, [selectedCriteria, dispatch, gridState.selection, onClose]);

  if (!isOpen) return null;

  return (
    <div style={styles.backdrop} onClick={onClose}>
      <div style={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <span style={styles.title}>Go To Special</span>
          <button style={styles.closeBtn} onClick={onClose} title="Close">x</button>
        </div>

        <div style={styles.body}>
          {CRITERIA_OPTIONS.map((option) => (
            <label key={option.value} style={styles.radioRow}>
              <input
                type="radio"
                name="goToSpecialCriteria"
                value={option.value}
                checked={selectedCriteria === option.value}
                onChange={() => setSelectedCriteria(option.value)}
                style={styles.radioInput}
              />
              <span style={styles.radioLabel}>{option.label}</span>
            </label>
          ))}
        </div>

        {statusMessage && (
          <div style={styles.status}>{statusMessage}</div>
        )}

        <div style={styles.footer}>
          <button style={styles.btn} onClick={onClose}>Cancel</button>
          <button
            style={styles.btnPrimary}
            onClick={handleOk}
            disabled={isSearching}
          >
            {isSearching ? "Searching..." : "OK"}
          </button>
        </div>
      </div>
    </div>
  );
}
