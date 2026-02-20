//! FILENAME: app/extensions/GoalSeek/components/GoalSeekDialog.tsx
// PURPOSE: Goal Seek dialog - single-variable solver UI.
// CONTEXT: Two-phase dialog: input form, then result/status display.

import React, { useState, useEffect, useCallback, useRef } from "react";
import type { DialogProps } from "../../../src/api/uiTypes";
import {
  getCell,
  updateCellsBatch,
  goalSeek,
  columnToLetter,
} from "../../../src/api";

// ============================================================================
// Styles (CSS variables from app theme)
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
    width: 380,
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
  title: {
    fontWeight: 600,
    fontSize: 15,
  },
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
    width: 120,
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
  statusDialog: {
    background: v("--panel-bg"),
    border: `1px solid ${v("--border-default")}`,
    borderRadius: 8,
    boxShadow: "0 12px 40px rgba(0, 0, 0, 0.5)",
    width: 380,
    display: "flex",
    flexDirection: "column" as const,
    color: v("--text-primary"),
    fontFamily: '"Segoe UI", system-ui, sans-serif',
    fontSize: 13,
  },
  statusBody: {
    padding: "20px 16px",
    display: "flex",
    flexDirection: "column" as const,
    gap: 10,
  },
  statusLine: {
    fontSize: 13,
    lineHeight: 1.5,
  },
  detailGrid: {
    display: "grid" as const,
    gridTemplateColumns: "auto 1fr",
    gap: "4px 12px",
    fontSize: 13,
    marginTop: 4,
  },
  detailLabel: {
    color: v("--text-secondary"),
  },
  detailValue: {
    fontFamily: "monospace",
  },
};

// ============================================================================
// Helpers
// ============================================================================

/**
 * Parse a cell reference like "A1", "$A$1", "B5" to 0-based {row, col}.
 * Returns null if the reference is invalid.
 */
function parseCellRef(ref: string): { row: number; col: number } | null {
  const cleaned = ref.trim().replace(/\$/g, "");
  const match = cleaned.match(/^([A-Za-z]+)(\d+)$/);
  if (!match) return null;

  const colStr = match[1].toUpperCase();
  const rowNum = parseInt(match[2], 10);
  if (isNaN(rowNum) || rowNum < 1) return null;

  // Convert column letters to 0-based index
  let colIdx = 0;
  for (let i = 0; i < colStr.length; i++) {
    colIdx = colIdx * 26 + (colStr.charCodeAt(i) - 64);
  }

  return { row: rowNum - 1, col: colIdx - 1 };
}

/**
 * Format 0-based row/col to absolute cell reference "$A$1".
 */
function formatCellRef(row: number, col: number): string {
  return `$${columnToLetter(col)}$${row + 1}`;
}

// ============================================================================
// Component
// ============================================================================

export function GoalSeekDialog(props: DialogProps): React.ReactElement | null {
  const { onClose, data } = props;
  const dialogRef = useRef<HTMLDivElement>(null);

  // Input phase state
  const [setCellRef, setSetCellRef] = useState("");
  const [toValue, setToValue] = useState("");
  const [changingCellRef, setChangingCellRef] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Result phase state
  const [result, setResult] = useState<{
    foundSolution: boolean;
    targetRef: string;
    variableRef: string;
    variableValue: number;
    targetResult: number;
    iterations: number;
    originalVariableValue: number;
    variableRow: number;
    variableCol: number;
  } | null>(null);

  // Pre-fill Set cell with active cell on mount
  useEffect(() => {
    const sel = data as Record<string, unknown> | undefined;
    const activeRow = (sel?.activeRow as number) ?? 0;
    const activeCol = (sel?.activeCol as number) ?? 0;
    setSetCellRef(formatCellRef(activeRow, activeCol));
  }, []);

  // Keyboard handlers
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (result) {
        if (e.key === "Escape") {
          e.stopPropagation();
          handleRevert();
        } else if (e.key === "Enter") {
          e.stopPropagation();
          handleAccept();
        }
        return;
      }
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
  }, [result, setCellRef, toValue, changingCellRef]);

  // Click outside to close
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) {
        if (!result) {
          onClose();
        }
      }
    },
    [onClose, result],
  );

  // --- Handlers ---

  const handleOk = useCallback(async () => {
    setValidationError(null);

    // Parse cell references
    const targetCoords = parseCellRef(setCellRef);
    if (!targetCoords) {
      setValidationError("Invalid Set cell reference.");
      return;
    }

    const valueNum = parseFloat(toValue);
    if (isNaN(valueNum)) {
      setValidationError("To value must be a number.");
      return;
    }

    const variableCoords = parseCellRef(changingCellRef);
    if (!variableCoords) {
      setValidationError("Invalid By changing cell reference.");
      return;
    }

    // Same cell check
    if (targetCoords.row === variableCoords.row && targetCoords.col === variableCoords.col) {
      setValidationError("Set cell and By changing cell must be different.");
      return;
    }

    // Validate target cell has a formula
    const targetCell = await getCell(targetCoords.row, targetCoords.col);
    if (!targetCell?.formula) {
      setValidationError("Cell must contain a formula.");
      return;
    }

    // Validate variable cell does NOT have a formula
    const variableCell = await getCell(variableCoords.row, variableCoords.col);
    if (variableCell?.formula) {
      setValidationError("Changing cell must not contain a formula.");
      return;
    }

    // Run goal seek
    setIsLoading(true);
    try {
      const gsResult = await goalSeek({
        targetRow: targetCoords.row,
        targetCol: targetCoords.col,
        targetValue: valueNum,
        variableRow: variableCoords.row,
        variableCol: variableCoords.col,
      });

      if (gsResult.error) {
        setValidationError(gsResult.error);
        setIsLoading(false);
        return;
      }

      // Refresh the grid to show updated values
      window.dispatchEvent(new CustomEvent("grid:refresh"));

      // Show result phase
      setResult({
        foundSolution: gsResult.foundSolution,
        targetRef: formatCellRef(targetCoords.row, targetCoords.col),
        variableRef: formatCellRef(variableCoords.row, variableCoords.col),
        variableValue: gsResult.variableValue,
        targetResult: gsResult.targetResult,
        iterations: gsResult.iterations,
        originalVariableValue: gsResult.originalVariableValue,
        variableRow: variableCoords.row,
        variableCol: variableCoords.col,
      });
    } catch (err) {
      setValidationError(`Goal Seek failed: ${err}`);
    } finally {
      setIsLoading(false);
    }
  }, [setCellRef, toValue, changingCellRef]);

  // Accept result and close
  const handleAccept = useCallback(() => {
    onClose();
  }, [onClose]);

  // Revert to original value and close
  const handleRevert = useCallback(async () => {
    if (result) {
      try {
        await updateCellsBatch([{
          row: result.variableRow,
          col: result.variableCol,
          value: String(result.originalVariableValue),
        }]);
        window.dispatchEvent(new CustomEvent("grid:refresh"));
      } catch (err) {
        console.error("[GoalSeek] Revert failed:", err);
      }
    }
    onClose();
  }, [result, onClose]);

  // --- Result / Status Dialog ---

  if (result) {
    const statusMsg = result.foundSolution
      ? `Goal Seeking with Cell ${result.targetRef} found a solution.`
      : `Goal Seeking with Cell ${result.targetRef} may not have found a solution.`;

    return (
      <div style={styles.backdrop}>
        <div ref={dialogRef} style={styles.statusDialog}>
          <div style={styles.header}>
            <span style={styles.title}>Goal Seek Status</span>
          </div>

          <div style={styles.statusBody}>
            <div style={styles.statusLine}>{statusMsg}</div>

            <div style={styles.detailGrid}>
              <span style={styles.detailLabel}>Target value:</span>
              <span style={styles.detailValue}>{toValue}</span>

              <span style={styles.detailLabel}>Current value:</span>
              <span style={styles.detailValue}>
                {Number.isFinite(result.targetResult)
                  ? result.targetResult.toPrecision(10).replace(/\.?0+$/, "")
                  : String(result.targetResult)}
              </span>
            </div>
          </div>

          <div style={styles.footer}>
            <button style={styles.btn} onClick={handleRevert}>
              Cancel
            </button>
            <button style={styles.btnPrimary} onClick={handleAccept}>
              OK
            </button>
          </div>
        </div>
      </div>
    );
  }

  // --- Input Dialog ---

  return (
    <div style={styles.backdrop} onMouseDown={handleBackdropClick}>
      <div ref={dialogRef} style={styles.dialog}>
        {/* Header */}
        <div style={styles.header}>
          <span style={styles.title}>Goal Seek</span>
          <button style={styles.closeBtn} onClick={onClose}>
            X
          </button>
        </div>

        {/* Body */}
        <div style={styles.body}>
          <div style={styles.fieldRow}>
            <label style={styles.fieldLabel}>Set cell:</label>
            <input
              style={styles.fieldInput}
              value={setCellRef}
              onChange={(e) => {
                setSetCellRef(e.target.value);
                setValidationError(null);
              }}
              placeholder="$B$5"
              autoFocus
            />
          </div>

          <div style={styles.fieldRow}>
            <label style={styles.fieldLabel}>To value:</label>
            <input
              style={styles.fieldInput}
              value={toValue}
              onChange={(e) => {
                setToValue(e.target.value);
                setValidationError(null);
              }}
              placeholder="50000"
              type="text"
              inputMode="decimal"
            />
          </div>

          <div style={styles.fieldRow}>
            <label style={styles.fieldLabel}>By changing cell:</label>
            <input
              style={styles.fieldInput}
              value={changingCellRef}
              onChange={(e) => {
                setChangingCellRef(e.target.value);
                setValidationError(null);
              }}
              placeholder="$A$1"
            />
          </div>

          {validationError && (
            <div style={styles.errorText}>{validationError}</div>
          )}
        </div>

        {/* Footer */}
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
            {isLoading ? "Seeking..." : "OK"}
          </button>
        </div>
      </div>
    </div>
  );
}
