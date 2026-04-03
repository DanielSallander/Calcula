//! FILENAME: app/extensions/DataTables/components/DataTableDialog.tsx
// PURPOSE: Data Table dialog - one-variable and two-variable What-If data tables.

import React, { useState, useEffect, useCallback, useRef } from "react";
import type { DialogProps } from "@api/uiTypes";
import {
  dataTableOneVar,
  dataTableTwoVar,
  columnToLetter,
} from "@api";

// ============================================================================
// Styles
// ============================================================================

const v = (name: string) => `var(${name})`;

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
    background: v("--panel-bg"),
    border: `1px solid ${v("--border-default")}`,
    borderRadius: 8,
    boxShadow: "0 12px 40px rgba(0, 0, 0, 0.5)",
    width: 400,
    display: "flex",
    flexDirection: "column" as const,
    color: v("--text-primary"),
    fontFamily: '"Segoe UI", system-ui, sans-serif',
    fontSize: 13,
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "12px 16px",
    borderBottom: `1px solid ${v("--border-default")}`,
  },
  title: { fontWeight: 600, fontSize: 15 },
  closeBtn: {
    background: "transparent",
    border: "none",
    color: v("--text-secondary"),
    cursor: "pointer",
    padding: "4px 8px",
    borderRadius: 4,
    fontSize: 14,
    lineHeight: 1,
  },
  body: {
    padding: "16px",
    display: "flex",
    flexDirection: "column" as const,
    gap: 14,
  },
  fieldRow: {
    display: "flex",
    alignItems: "center",
    gap: 12,
  },
  fieldLabel: {
    width: 130,
    fontSize: 13,
    flexShrink: 0,
  },
  fieldInput: {
    flex: 1,
    padding: "5px 8px",
    fontSize: 13,
    borderRadius: 3,
    border: `1px solid ${v("--border-default")}`,
    background: v("--grid-bg"),
    color: v("--text-primary"),
    outline: "none",
    fontFamily: '"Segoe UI", system-ui, sans-serif',
  },
  footer: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 8,
    padding: "12px 16px",
    borderTop: `1px solid ${v("--border-default")}`,
  },
  btn: {
    padding: "6px 20px",
    fontSize: 13,
    borderRadius: 4,
    cursor: "pointer",
    minWidth: 80,
    background: v("--grid-bg"),
    color: v("--text-primary"),
    border: `1px solid ${v("--border-default")}`,
  },
  btnPrimary: {
    padding: "6px 20px",
    fontSize: 13,
    borderRadius: 4,
    cursor: "pointer",
    minWidth: 80,
    background: v("--accent-primary"),
    color: "#ffffff",
    border: `1px solid ${v("--accent-primary")}`,
  },
  errorText: {
    color: "#e74c3c",
    fontSize: 12,
    marginTop: -8,
  },
  hint: {
    fontSize: 12,
    color: v("--text-secondary"),
    lineHeight: 1.4,
  },
};

// ============================================================================
// Helpers
// ============================================================================

function parseCellRef(ref: string): { row: number; col: number } | null {
  const cleaned = ref.trim().replace(/\$/g, "");
  const match = cleaned.match(/^([A-Za-z]+)(\d+)$/);
  if (!match) return null;
  const colStr = match[1].toUpperCase();
  const rowNum = parseInt(match[2], 10);
  if (isNaN(rowNum) || rowNum < 1) return null;
  let colIdx = 0;
  for (let i = 0; i < colStr.length; i++) {
    colIdx = colIdx * 26 + (colStr.charCodeAt(i) - 64);
  }
  return { row: rowNum - 1, col: colIdx - 1 };
}

function formatCellRef(row: number, col: number): string {
  return `$${columnToLetter(col)}$${row + 1}`;
}

// ============================================================================
// Component
// ============================================================================

export function DataTableDialog(props: DialogProps): React.ReactElement | null {
  const { onClose, data } = props;
  const dialogRef = useRef<HTMLDivElement>(null);

  const [rowInputRef, setRowInputRef] = useState("");
  const [colInputRef, setColInputRef] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const sel = data as Record<string, unknown> | undefined;
  const startRow = (sel?.activeRow as number) ?? 0;
  const startCol = (sel?.activeCol as number) ?? 0;
  const endRow = (sel?.endRow as number) ?? startRow;
  const endCol = (sel?.endCol as number) ?? startCol;

  // Keyboard handlers
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
      if (e.key === "Enter") {
        e.stopPropagation();
        handleOk();
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [rowInputRef, colInputRef]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) {
        onClose();
      }
    },
    [onClose],
  );

  const handleOk = useCallback(async () => {
    setValidationError(null);

    const hasRowInput = rowInputRef.trim().length > 0;
    const hasColInput = colInputRef.trim().length > 0;

    if (!hasRowInput && !hasColInput) {
      setValidationError("Specify at least one input cell (Row or Column).");
      return;
    }

    // Validate table range
    if (startRow === endRow && startCol === endCol) {
      setValidationError("Select a table range first (at least 2x2 cells).");
      return;
    }

    let rowInput: { row: number; col: number } | null = null;
    let colInput: { row: number; col: number } | null = null;

    if (hasRowInput) {
      rowInput = parseCellRef(rowInputRef);
      if (!rowInput) {
        setValidationError("Invalid Row input cell reference.");
        return;
      }
    }

    if (hasColInput) {
      colInput = parseCellRef(colInputRef);
      if (!colInput) {
        setValidationError("Invalid Column input cell reference.");
        return;
      }
    }

    setIsLoading(true);

    try {
      if (hasRowInput && hasColInput) {
        // Two-variable data table
        const result = await dataTableTwoVar({
          sheetIndex: 0,
          startRow,
          startCol,
          endRow,
          endCol,
          rowInputRow: rowInput!.row,
          rowInputCol: rowInput!.col,
          colInputRow: colInput!.row,
          colInputCol: colInput!.col,
        });

        if (result.error) {
          setValidationError(result.error);
          setIsLoading(false);
          return;
        }
      } else {
        // One-variable data table
        const result = await dataTableOneVar({
          sheetIndex: 0,
          startRow,
          startCol,
          endRow,
          endCol,
          rowInputRow: rowInput?.row,
          rowInputCol: rowInput?.col,
          colInputRow: colInput?.row,
          colInputCol: colInput?.col,
        });

        if (result.error) {
          setValidationError(result.error);
          setIsLoading(false);
          return;
        }
      }

      window.dispatchEvent(new CustomEvent("grid:refresh"));
      onClose();
    } catch (err) {
      setValidationError(`Data table calculation failed: ${err}`);
    } finally {
      setIsLoading(false);
    }
  }, [rowInputRef, colInputRef, startRow, startCol, endRow, endCol, onClose]);

  const rangeLabel =
    startRow !== endRow || startCol !== endCol
      ? `${formatCellRef(startRow, startCol)}:${formatCellRef(endRow, endCol)}`
      : "(no range selected)";

  return (
    <div style={styles.backdrop} onMouseDown={handleBackdropClick}>
      <div ref={dialogRef} style={styles.dialog}>
        <div style={styles.header}>
          <span style={styles.title}>Data Table</span>
          <button style={styles.closeBtn} onClick={onClose}>
            X
          </button>
        </div>

        <div style={styles.body}>
          <div style={styles.hint}>
            Table range: {rangeLabel}
          </div>

          <div style={styles.fieldRow}>
            <label style={styles.fieldLabel}>Row input cell:</label>
            <input
              style={styles.fieldInput}
              value={rowInputRef}
              onChange={(e) => {
                setRowInputRef(e.target.value);
                setValidationError(null);
              }}
              placeholder="$B$1"
              autoFocus
            />
          </div>

          <div style={styles.fieldRow}>
            <label style={styles.fieldLabel}>Column input cell:</label>
            <input
              style={styles.fieldInput}
              value={colInputRef}
              onChange={(e) => {
                setColInputRef(e.target.value);
                setValidationError(null);
              }}
              placeholder="$A$1"
            />
          </div>

          <div style={styles.hint}>
            For a one-variable table, enter either a Row or Column input cell.
            For a two-variable table, enter both.
          </div>

          {validationError && (
            <div style={styles.errorText}>{validationError}</div>
          )}
        </div>

        <div style={styles.footer}>
          <button style={styles.btn} onClick={onClose}>
            Cancel
          </button>
          <button
            style={{
              ...styles.btnPrimary,
              opacity: isLoading ? 0.6 : 1,
              cursor: isLoading ? "not-allowed" : "pointer",
            }}
            onClick={handleOk}
            disabled={isLoading}
          >
            {isLoading ? "Calculating..." : "OK"}
          </button>
        </div>
      </div>
    </div>
  );
}
