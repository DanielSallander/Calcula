//! FILENAME: app/extensions/Solver/components/SolverResultDialog.tsx
// PURPOSE: Solver Result dialog - shows solution status with Accept/Revert options.

import React, { useState, useEffect, useCallback, useRef } from "react";
import type { DialogProps } from "@api/uiTypes";
import { useDialogWindow } from "@api/dialogWindow";
import {
  solverRevert,
  columnToLetter,
} from "@api";
import type { SolverResultData, SolverVariableValue } from "@api";
import { alertAsync } from "@api/dialogs";
import { emitAppEvent, AppEvents } from "@api/events";

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
    width: 440,
    maxHeight: "80vh",
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
  body: {
    padding: "16px",
    display: "flex",
    flexDirection: "column" as const,
    gap: 12,
    overflow: "auto",
  },
  statusMsg: {
    fontSize: 13,
    lineHeight: 1.5,
  },
  detailGrid: {
    display: "grid" as const,
    gridTemplateColumns: "auto 1fr",
    gap: "4px 12px",
    fontSize: 13,
  },
  detailLabel: {
    color: v("--text-secondary"),
  },
  detailValue: {
    fontFamily: "monospace",
  },
  variableTable: {
    width: "100%",
    borderCollapse: "collapse" as const,
    fontSize: 12,
    fontFamily: "monospace",
  },
  th: {
    padding: "4px 8px",
    background: v("--grid-bg"),
    borderBottom: `2px solid ${v("--border-default")}`,
    textAlign: "left" as const,
    fontWeight: 600,
    fontSize: 12,
    fontFamily: '"Segoe UI", system-ui, sans-serif',
  },
  td: {
    padding: "4px 8px",
    borderBottom: `1px solid ${v("--border-default")}`,
    fontSize: 12,
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
};

function formatCellRef(row: number, col: number): string {
  return `$${columnToLetter(col)}$${row + 1}`;
}

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  return n.toPrecision(10).replace(/\.?0+$/, "");
}

// ============================================================================
// Component
// ============================================================================

export function SolverResultDialog(props: DialogProps): React.ReactElement | null {
  const { onClose, data } = props;

  // Movable + resizable dialog window (shared @api hook)
  const win = useDialogWindow({ minWidth: 320, minHeight: 260 });

  const resultData = (data as Record<string, unknown>)?.result as SolverResultData | undefined;

  if (!resultData) return null;

  // Keyboard handler
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        handleRevert();
      }
      if (e.key === "Enter") {
        e.stopPropagation();
        handleKeep();
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  const handleKeep = useCallback(() => {
    onClose();
  }, [onClose]);

  // Restore Original Values names the run's sheet by its STABLE id (the result
  // carries it), never by the index it had when the run started: a tab dragged
  // while this dialog is open used to receive the original values. A refusal
  // (the sheet was deleted meanwhile) is said, not swallowed.
  //
  // A REFUSED Restore KEEPS THE DIALOG OPEN, as Goal Seek's refused Cancel
  // does: the backend refuses while another what-if run is going or an
  // animation holds cells on loan -- things the user can end and then press
  // Restore again -- and closing after the alert left Solver's values with no
  // way back. A result that names no sheet (no stable id on file) cannot be
  // restored at all, and used to close silently with the trial values kept; it
  // now says so, and Keep Solver Solution closes. The run, and the Restore,
  // leave the workbook calculated (Excel, under manual calculation too), so the
  // cells are announced and the status bar asks the calculation state again.
  const revertingRef = useRef(false);
  const handleRevert = useCallback(async () => {
    if (revertingRef.current) return;
    if (resultData.originalValues.length === 0) {
      onClose();
      return;
    }
    if (!resultData.sheetId) {
      await alertAsync(
        "Solver could not restore the original values: the sheet the run worked on has no stable identity. " +
          "Use Undo to take the values back, or Keep Solver Solution to close.",
      );
      return;
    }
    revertingRef.current = true;
    let refusal = "";
    try {
      const answer = await solverRevert(resultData.sheetId, resultData.originalValues);
      window.dispatchEvent(new CustomEvent("grid:refresh"));
      refusal = typeof answer?.error === "string" ? answer.error.trim() : "";
      if (refusal === "") {
        emitAppEvent(AppEvents.CELLS_UPDATED);
      }
    } catch (err) {
      console.error("[Solver] Revert failed:", err);
      refusal = String(err);
    }
    revertingRef.current = false;
    if (refusal !== "") {
      await alertAsync(`Solver could not restore the original values: ${refusal}`);
      return;
    }
    onClose();
  }, [resultData, onClose]);

  return (
    <div style={styles.backdrop}>
      <div ref={win.ref} style={{ ...styles.dialog, position: "relative", ...win.style }}>
        <div style={styles.header} onMouseDown={win.onHeaderMouseDown}>
          <span style={styles.title}>Solver Results</span>
        </div>

        <div style={styles.body}>
          <div style={styles.statusMsg}>{resultData.statusMessage}</div>

          <div style={styles.detailGrid}>
            <span style={styles.detailLabel}>Objective Value:</span>
            <span style={styles.detailValue}>{formatNumber(resultData.objectiveValue)}</span>

            <span style={styles.detailLabel}>Iterations:</span>
            <span style={styles.detailValue}>{resultData.iterations}</span>
          </div>

          {resultData.variableValues.length > 0 && (
            <>
              <div style={{ fontWeight: 600, fontSize: 13, marginTop: 4 }}>Variable Cell Values:</div>
              <table style={styles.variableTable}>
                <thead>
                  <tr>
                    <th style={styles.th}>Cell</th>
                    <th style={styles.th}>Original</th>
                    <th style={styles.th}>Final</th>
                  </tr>
                </thead>
                <tbody>
                  {resultData.variableValues.map((v, i) => {
                    const orig = resultData.originalValues[i];
                    return (
                      <tr key={`${v.row}-${v.col}`}>
                        <td style={styles.td}>{formatCellRef(v.row, v.col)}</td>
                        <td style={styles.td}>{orig ? formatNumber(orig.value) : "-"}</td>
                        <td style={styles.td}>{formatNumber(v.value)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          )}
        </div>

        <div style={styles.footer}>
          <button style={styles.btn} onClick={handleRevert}>
            Restore Original Values
          </button>
          <button style={styles.btnPrimary} onClick={handleKeep}>
            Keep Solver Solution
          </button>
        </div>
        {win.resizeHandles}
      </div>
    </div>
  );
}
