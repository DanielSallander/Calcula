//! FILENAME: app/extensions/Table/components/CreateTableDialog.tsx
// PURPOSE: Insert Table dialog component.
// CONTEXT: Simplified dialog for creating a table from a data range.
//          Follows the same pattern and styling as CreatePivotDialog.

import React, { useState, useEffect, useCallback } from "react";
import {
  detectDataRegion,
  useGridState,
  indexToCol,
  getSheets,
} from "../../../src/api";
import type { DialogProps } from "../../../src/api";
import { emitAppEvent } from "../../../src/api/events";
import { createTable } from "../lib/tableStore";
import { TableEvents } from "../lib/tableEvents";

// ============================================================================
// Utility Functions
// ============================================================================

function toA1Notation(row: number, col: number): string {
  return `${indexToCol(col)}${row + 1}`;
}

function selectionToRange(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
): string {
  const minRow = Math.min(startRow, endRow);
  const maxRow = Math.max(startRow, endRow);
  const minCol = Math.min(startCol, endCol);
  const maxCol = Math.max(startCol, endCol);
  return `${toA1Notation(minRow, minCol)}:${toA1Notation(maxRow, maxCol)}`;
}

function buildSheetRange(sheetName: string, range: string): string {
  if (/[^a-zA-Z0-9_]/.test(sheetName)) {
    return `'${sheetName}'!${range}`;
  }
  return `${sheetName}!${range}`;
}

/**
 * Parse a range reference like "Sheet1!A1:D10" into row/col bounds (0-indexed).
 * Returns null if parsing fails.
 */
function parseRangeReference(
  rangeRef: string,
): { startRow: number; startCol: number; endRow: number; endCol: number } | null {
  // Strip sheet prefix if present
  let ref = rangeRef;
  const bangIndex = ref.lastIndexOf("!");
  if (bangIndex !== -1) {
    ref = ref.substring(bangIndex + 1);
  }

  ref = ref.replace(/'/g, "").trim().toUpperCase();

  const match = ref.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
  if (!match) return null;

  const startColLetters = match[1];
  const startRowNum = parseInt(match[2], 10);
  const endColLetters = match[3];
  const endRowNum = parseInt(match[4], 10);

  if (isNaN(startRowNum) || isNaN(endRowNum) || startRowNum < 1 || endRowNum < 1) {
    return null;
  }

  // Convert column letters to 0-indexed
  let startCol = 0;
  for (let i = 0; i < startColLetters.length; i++) {
    startCol = startCol * 26 + (startColLetters.charCodeAt(i) - 64);
  }
  startCol -= 1;

  let endCol = 0;
  for (let i = 0; i < endColLetters.length; i++) {
    endCol = endCol * 26 + (endColLetters.charCodeAt(i) - 64);
  }
  endCol -= 1;

  return {
    startRow: startRowNum - 1,
    startCol,
    endRow: endRowNum - 1,
    endCol,
  };
}

// ============================================================================
// Component
// ============================================================================

export function CreateTableDialog({
  isOpen,
  onClose,
  data,
}: DialogProps): React.ReactElement | null {
  const gridState = useGridState();

  // Form state
  const [sourceRange, setSourceRange] = useState("");
  const [hasHeaders, setHasHeaders] = useState(true);

  // UI state
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentSheetName, setCurrentSheetName] = useState("Sheet1");
  const [currentSheetIndex, setCurrentSheetIndex] = useState(0);
  const [hasAutoDetected, setHasAutoDetected] = useState(false);

  // Load sheet info and reset on open
  useEffect(() => {
    if (isOpen) {
      setHasAutoDetected(false);
      setError(null);
      loadSheets();
    }
  }, [isOpen]);

  // Auto-detect the contiguous data region around the active cell
  useEffect(() => {
    if (!isOpen || hasAutoDetected || !currentSheetName) return;

    const sel = gridState.selection;
    if (!sel) return;

    const activeRow = sel.endRow;
    const activeCol = sel.endCol;

    setHasAutoDetected(true);

    detectDataRegion(activeRow, activeCol)
      .then((region) => {
        if (region) {
          const [startRow, startCol, endRow, endCol] = region;
          const range = selectionToRange(startRow, startCol, endRow, endCol);
          setSourceRange(buildSheetRange(currentSheetName, range));
        } else if (sel) {
          const range = selectionToRange(
            sel.startRow,
            sel.startCol,
            sel.endRow,
            sel.endCol,
          );
          setSourceRange(buildSheetRange(currentSheetName, range));
        }
      })
      .catch((err) => {
        console.error("[CreateTableDialog] Auto-detect failed:", err);
        if (sel) {
          const range = selectionToRange(
            sel.startRow,
            sel.startCol,
            sel.endRow,
            sel.endCol,
          );
          setSourceRange(buildSheetRange(currentSheetName, range));
        }
      });
  }, [isOpen, hasAutoDetected, currentSheetName, gridState.selection]);

  const loadSheets = async () => {
    try {
      const result = await getSheets();
      const activeSheet = result.sheets.find((s) => s.index === result.activeIndex);
      if (activeSheet) {
        setCurrentSheetName(activeSheet.name);
        setCurrentSheetIndex(activeSheet.index);
      }
    } catch (err) {
      console.error("[CreateTableDialog] Failed to load sheets:", err);
    }
  };

  const handleClose = useCallback(() => {
    setError(null);
    setIsLoading(false);
    onClose();
  }, [onClose]);

  const handleCreate = async () => {
    setError(null);
    setIsLoading(true);

    try {
      if (!sourceRange.trim()) {
        throw new Error("Please enter a data range for the table.");
      }

      // Parse the range
      const parsed = parseRangeReference(sourceRange);
      if (!parsed) {
        throw new Error(
          "Invalid range format. Use a range like Sheet1!A1:D10.",
        );
      }

      // Create the table in the in-memory store
      const table = createTable({
        sheetIndex: currentSheetIndex,
        startRow: parsed.startRow,
        startCol: parsed.startCol,
        endRow: parsed.endRow,
        endCol: parsed.endCol,
        hasHeaders,
      });

      console.log("[CreateTableDialog] Table created:", table.name, table);

      // Emit event so other components can react
      emitAppEvent(TableEvents.TABLE_CREATED, { tableId: table.tableId });

      handleClose();
    } catch (err) {
      console.error("[CreateTableDialog] Error creating table:", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      handleClose();
    } else if (e.key === "Enter" && !isLoading) {
      handleCreate();
    }
  };

  if (!isOpen) {
    return null;
  }

  return (
    <div style={styles.overlay} onClick={handleClose}>
      <div
        style={styles.dialog}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div style={styles.header}>
          <h2 style={styles.title}>Create Table</h2>
          <button
            style={styles.closeButton}
            onClick={handleClose}
            aria-label="Close"
          >
            x
          </button>
        </div>

        {/* Content */}
        <div style={styles.content}>
          {/* Source Range */}
          <div style={styles.fieldGroup}>
            <label style={styles.label}>
              Where is the data for your table?
            </label>
            <input
              type="text"
              style={styles.input}
              value={sourceRange}
              onChange={(e) => setSourceRange(e.target.value)}
              placeholder="e.g., Sheet1!A1:D10"
              disabled={isLoading}
              autoFocus
            />
            <span style={styles.hint}>
              Include the sheet name and range (e.g., Sheet1!A1:D10)
            </span>
          </div>

          {/* Has Headers Checkbox */}
          <div style={styles.checkboxGroup}>
            <label style={styles.checkboxLabel}>
              <input
                type="checkbox"
                checked={hasHeaders}
                onChange={(e) => setHasHeaders(e.target.checked)}
                disabled={isLoading}
                style={styles.checkbox}
              />
              <span>My table has headers</span>
            </label>
          </div>

          {/* Error Message */}
          {error && <div style={styles.error}>{error}</div>}
        </div>

        {/* Footer */}
        <div style={styles.footer}>
          <button
            style={styles.cancelButton}
            onClick={handleClose}
            disabled={isLoading}
          >
            Cancel
          </button>
          <button
            style={{
              ...styles.okButton,
              ...(isLoading ? styles.buttonDisabled : {}),
            }}
            onClick={handleCreate}
            disabled={isLoading}
          >
            {isLoading ? "Creating..." : "OK"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Styles (matches CreatePivotDialog dark theme)
// ============================================================================

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 10000,
  },
  dialog: {
    backgroundColor: "#2d2d2d",
    borderRadius: "8px",
    border: "1px solid #454545",
    boxShadow: "0 8px 32px rgba(0, 0, 0, 0.4)",
    width: "420px",
    maxWidth: "90vw",
    maxHeight: "90vh",
    display: "flex",
    flexDirection: "column",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "16px 20px",
    borderBottom: "1px solid #454545",
  },
  title: {
    margin: 0,
    fontSize: "16px",
    fontWeight: 600,
    color: "#ffffff",
  },
  closeButton: {
    background: "transparent",
    border: "none",
    color: "#888888",
    fontSize: "18px",
    cursor: "pointer",
    padding: "4px 8px",
    borderRadius: "4px",
    lineHeight: 1,
  },
  content: {
    padding: "20px",
    overflowY: "auto",
  },
  fieldGroup: {
    marginBottom: "20px",
  },
  label: {
    display: "block",
    fontSize: "13px",
    fontWeight: 500,
    color: "#cccccc",
    marginBottom: "8px",
  },
  input: {
    width: "100%",
    padding: "8px 12px",
    fontSize: "13px",
    backgroundColor: "#1e1e1e",
    border: "1px solid #454545",
    borderRadius: "4px",
    color: "#ffffff",
    outline: "none",
    boxSizing: "border-box" as const,
  },
  hint: {
    display: "block",
    fontSize: "11px",
    color: "#888888",
    marginTop: "4px",
  },
  checkboxGroup: {
    marginBottom: "20px",
  },
  checkboxLabel: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    fontSize: "13px",
    color: "#cccccc",
    cursor: "pointer",
  },
  checkbox: {
    margin: 0,
    cursor: "pointer",
  },
  error: {
    padding: "10px 12px",
    backgroundColor: "rgba(220, 53, 69, 0.15)",
    border: "1px solid #dc3545",
    borderRadius: "4px",
    color: "#ff6b6b",
    fontSize: "13px",
  },
  footer: {
    display: "flex",
    justifyContent: "flex-end",
    gap: "8px",
    padding: "16px 20px",
    borderTop: "1px solid #454545",
  },
  cancelButton: {
    padding: "8px 16px",
    fontSize: "13px",
    backgroundColor: "transparent",
    border: "1px solid #454545",
    borderRadius: "4px",
    color: "#cccccc",
    cursor: "pointer",
  },
  okButton: {
    padding: "8px 20px",
    fontSize: "13px",
    backgroundColor: "#0e639c",
    border: "1px solid #0e639c",
    borderRadius: "4px",
    color: "#ffffff",
    cursor: "pointer",
    fontWeight: 500,
  },
  buttonDisabled: {
    opacity: 0.6,
    cursor: "not-allowed",
  },
};

export default CreateTableDialog;
