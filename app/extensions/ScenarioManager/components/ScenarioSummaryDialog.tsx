//! FILENAME: app/extensions/ScenarioManager/components/ScenarioSummaryDialog.tsx
// PURPOSE: Scenario Summary dialog - shows comparison table of all scenarios.

import React, { useState, useEffect, useCallback, useRef } from "react";
import type { DialogProps } from "../../../src/api/uiTypes";
import {
  scenarioSummary,
  columnToLetter,
} from "../../../src/api";
import type { ScenarioSummaryRow, ScenarioCell } from "../../../src/api";

// ============================================================================
// Styles
// ============================================================================

const v = (name: string) => `var(${name})`;

const styles = {
  backdrop: {
    position: "fixed" as const,
    inset: 0,
    zIndex: 1060,
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
    width: 680,
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
    gap: 12,
    overflow: "auto",
  },
  fieldRow: {
    display: "flex",
    alignItems: "center",
    gap: 12,
  },
  fieldLabel: {
    width: 100,
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
  },
  table: {
    width: "100%",
    borderCollapse: "collapse" as const,
    fontSize: 12,
    fontFamily: "monospace",
  },
  th: {
    padding: "6px 8px",
    background: v("--grid-bg"),
    borderBottom: `2px solid ${v("--border-default")}`,
    textAlign: "left" as const,
    fontWeight: 600,
    fontSize: 12,
  },
  td: {
    padding: "4px 8px",
    borderBottom: `1px solid ${v("--border-default")}`,
    fontSize: 12,
  },
  sectionHeader: {
    padding: "6px 8px",
    background: v("--grid-bg"),
    fontWeight: 600,
    fontSize: 12,
    fontFamily: '"Segoe UI", system-ui, sans-serif',
  },
  btn: {
    padding: "6px 16px",
    fontSize: 13,
    borderRadius: 4,
    cursor: "pointer",
    background: v("--grid-bg"),
    color: v("--text-primary"),
    border: `1px solid ${v("--border-default")}`,
  },
  btnPrimary: {
    padding: "6px 16px",
    fontSize: 13,
    borderRadius: 4,
    cursor: "pointer",
    background: v("--accent-primary"),
    color: "#ffffff",
    border: `1px solid ${v("--accent-primary")}`,
  },
  errorText: {
    color: "#e74c3c",
    fontSize: 12,
  },
  footer: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 8,
    padding: "12px 16px",
    borderTop: `1px solid ${v("--border-default")}`,
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

function parseCellRange(rangeStr: string): { row: number; col: number }[] {
  const cells: { row: number; col: number }[] = [];
  const parts = rangeStr.split(",");
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (trimmed.includes(":")) {
      const [startRef, endRef] = trimmed.split(":");
      const start = parseCellRef(startRef);
      const end = parseCellRef(endRef);
      if (start && end) {
        for (let r = Math.min(start.row, end.row); r <= Math.max(start.row, end.row); r++) {
          for (let c = Math.min(start.col, end.col); c <= Math.max(start.col, end.col); c++) {
            cells.push({ row: r, col: c });
          }
        }
      }
    } else {
      const cell = parseCellRef(trimmed);
      if (cell) cells.push(cell);
    }
  }
  return cells;
}

// ============================================================================
// Component
// ============================================================================

export function ScenarioSummaryDialog(props: DialogProps): React.ReactElement | null {
  const { onClose, data } = props;
  const dialogRef = useRef<HTMLDivElement>(null);

  const [resultCellsRef, setResultCellsRef] = useState("");
  const [summaryRows, setSummaryRows] = useState<ScenarioSummaryRow[] | null>(null);
  const [scenarioNames, setScenarioNames] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const sheetIndex = (data as Record<string, unknown>)?.sheetIndex as number ?? 0;

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  const handleGenerate = useCallback(async () => {
    setLoading(true);
    setError(null);

    const resultCells: ScenarioCell[] = parseCellRange(resultCellsRef).map((c) => ({
      row: c.row,
      col: c.col,
      value: "",
    }));

    try {
      const result = await scenarioSummary({
        sheetIndex,
        resultCells,
      });

      if (result.error) {
        setError(result.error);
      } else {
        setScenarioNames(result.scenarioNames);
        setSummaryRows(result.rows);
      }
    } catch (err) {
      setError(`Failed to generate summary: ${err}`);
    } finally {
      setLoading(false);
    }
  }, [resultCellsRef, sheetIndex]);

  return (
    <div style={styles.backdrop}>
      <div ref={dialogRef} style={styles.dialog}>
        <div style={styles.header}>
          <span style={styles.title}>Scenario Summary</span>
          <button style={styles.closeBtn} onClick={onClose}>
            X
          </button>
        </div>

        <div style={styles.body}>
          {!summaryRows ? (
            <>
              <div style={styles.fieldRow}>
                <label style={styles.fieldLabel}>Result cells:</label>
                <input
                  style={styles.fieldInput}
                  value={resultCellsRef}
                  onChange={(e) => setResultCellsRef(e.target.value)}
                  placeholder="$C$5,$C$6 or $C$5:$C$10 (optional)"
                  autoFocus
                />
              </div>
              <div style={{ fontSize: 12, color: v("--text-secondary") }}>
                Enter the cells that contain formulas you want to compare across scenarios.
                Leave empty to show only changing cell values.
              </div>
              {error && <div style={styles.errorText}>{error}</div>}
            </>
          ) : (
            <>
              <div style={{ overflow: "auto", maxHeight: 400 }}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={styles.th}></th>
                      <th style={styles.th}>Current Values</th>
                      {scenarioNames.map((name) => (
                        <th key={name} style={styles.th}>
                          {name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {summaryRows.some((r) => r.isChangingCell) && (
                      <tr>
                        <td
                          colSpan={2 + scenarioNames.length}
                          style={styles.sectionHeader}
                        >
                          Changing Cells:
                        </td>
                      </tr>
                    )}
                    {summaryRows
                      .filter((r) => r.isChangingCell)
                      .map((row) => (
                        <tr key={`c-${row.cellRef}`}>
                          <td style={styles.td}>{row.cellRef}</td>
                          <td style={styles.td}>{row.currentValue}</td>
                          {row.scenarioValues.map((val, i) => (
                            <td key={i} style={styles.td}>
                              {val}
                            </td>
                          ))}
                        </tr>
                      ))}
                    {summaryRows.some((r) => !r.isChangingCell) && (
                      <tr>
                        <td
                          colSpan={2 + scenarioNames.length}
                          style={styles.sectionHeader}
                        >
                          Result Cells:
                        </td>
                      </tr>
                    )}
                    {summaryRows
                      .filter((r) => !r.isChangingCell)
                      .map((row) => (
                        <tr key={`r-${row.cellRef}`}>
                          <td style={styles.td}>{row.cellRef}</td>
                          <td style={styles.td}>{row.currentValue}</td>
                          {row.scenarioValues.map((val, i) => (
                            <td key={i} style={styles.td}>
                              {val}
                            </td>
                          ))}
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              {error && <div style={styles.errorText}>{error}</div>}
            </>
          )}
        </div>

        <div style={styles.footer}>
          {!summaryRows ? (
            <>
              <button style={styles.btn} onClick={onClose}>
                Cancel
              </button>
              <button
                style={loading ? { ...styles.btnPrimary, opacity: 0.6 } : styles.btnPrimary}
                onClick={handleGenerate}
                disabled={loading}
              >
                {loading ? "Generating..." : "OK"}
              </button>
            </>
          ) : (
            <button style={styles.btn} onClick={onClose}>
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
