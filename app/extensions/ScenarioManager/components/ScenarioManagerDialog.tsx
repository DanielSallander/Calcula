//! FILENAME: app/extensions/ScenarioManager/components/ScenarioManagerDialog.tsx
// PURPOSE: Scenario Manager dialog - create, edit, show, and delete scenarios.

import React, { useState, useEffect, useCallback, useRef } from "react";
import type { DialogProps } from "@api/uiTypes";
import {
  scenarioList,
  scenarioAdd,
  scenarioDelete,
  scenarioShow,
  columnToLetter,
  DialogExtensions,
} from "@api";
import type { Scenario, ScenarioCell } from "@api";

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
    width: 520,
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
  listBox: {
    border: `1px solid ${v("--border-default")}`,
    borderRadius: 4,
    background: v("--grid-bg"),
    minHeight: 120,
    maxHeight: 200,
    overflow: "auto",
  },
  listItem: {
    padding: "6px 10px",
    cursor: "pointer",
    fontSize: 13,
    borderBottom: `1px solid ${v("--border-default")}`,
  },
  listItemSelected: {
    padding: "6px 10px",
    cursor: "pointer",
    fontSize: 13,
    borderBottom: `1px solid ${v("--border-default")}`,
    background: v("--accent-primary"),
    color: "#ffffff",
  },
  buttonRow: {
    display: "flex",
    gap: 8,
    flexWrap: "wrap" as const,
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
  btnDisabled: {
    padding: "6px 16px",
    fontSize: 13,
    borderRadius: 4,
    cursor: "not-allowed",
    background: v("--grid-bg"),
    color: v("--text-secondary"),
    border: `1px solid ${v("--border-default")}`,
    opacity: 0.6,
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
  errorText: {
    color: "#e74c3c",
    fontSize: 12,
  },
  infoText: {
    color: v("--text-secondary"),
    fontSize: 12,
    fontStyle: "italic" as const,
  },
  footer: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 8,
    padding: "12px 16px",
    borderTop: `1px solid ${v("--border-default")}`,
  },
  cellValueRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 13,
  },
  cellValueLabel: {
    width: 80,
    fontFamily: "monospace",
    flexShrink: 0,
  },
  cellValueInput: {
    flex: 1,
    padding: "4px 8px",
    fontSize: 13,
    borderRadius: 3,
    border: `1px solid ${v("--border-default")}`,
    background: v("--grid-bg"),
    color: v("--text-primary"),
    outline: "none",
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

function parseCellRange(rangeStr: string): { row: number; col: number }[] {
  const cells: { row: number; col: number }[] = [];
  const parts = rangeStr.split(",");
  for (const part of parts) {
    const trimmed = part.trim();
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
// Modes
// ============================================================================

type Mode = "list" | "add" | "edit";

// ============================================================================
// Component
// ============================================================================

export function ScenarioManagerDialog(props: DialogProps): React.ReactElement | null {
  const { onClose, data } = props;
  const dialogRef = useRef<HTMLDivElement>(null);

  const [mode, setMode] = useState<Mode>("list");
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Add/Edit form state
  const [formName, setFormName] = useState("");
  const [formComment, setFormComment] = useState("");
  const [formChangingCellsRef, setFormChangingCellsRef] = useState("");
  const [formCellValues, setFormCellValues] = useState<{ row: number; col: number; value: string }[]>([]);

  const sheetIndex = 0; // Use active sheet

  // Load scenarios
  const loadScenarios = useCallback(async () => {
    try {
      const result = await scenarioList(sheetIndex);
      setScenarios(result.scenarios);
    } catch (err) {
      console.error("[ScenarioManager] Failed to load scenarios:", err);
    }
  }, [sheetIndex]);

  useEffect(() => {
    loadScenarios();
  }, [loadScenarios]);

  // Keyboard handler
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        if (mode !== "list") {
          setMode("list");
          setError(null);
        } else {
          onClose();
        }
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [mode, onClose]);

  // Parse changing cells and set up value inputs
  const handleChangingCellsChange = useCallback((ref: string) => {
    setFormChangingCellsRef(ref);
    const cells = parseCellRange(ref);
    setFormCellValues(cells.map((c) => ({ row: c.row, col: c.col, value: "" })));
  }, []);

  // --- Handlers ---

  const handleAdd = useCallback(() => {
    setMode("add");
    setFormName("");
    setFormComment("");
    const sel = data as Record<string, unknown> | undefined;
    const activeRow = (sel?.activeRow as number) ?? 0;
    const activeCol = (sel?.activeCol as number) ?? 0;
    const endRow = (sel?.endRow as number) ?? activeRow;
    const endCol = (sel?.endCol as number) ?? activeCol;

    if (activeRow !== endRow || activeCol !== endCol) {
      const ref = `${formatCellRef(activeRow, activeCol)}:${formatCellRef(endRow, endCol)}`;
      handleChangingCellsChange(ref);
    } else {
      setFormChangingCellsRef(formatCellRef(activeRow, activeCol));
      setFormCellValues([{ row: activeRow, col: activeCol, value: "" }]);
    }
    setError(null);
  }, [data, handleChangingCellsChange]);

  const handleEdit = useCallback(() => {
    const scenario = scenarios.find((s) => s.name === selectedName);
    if (!scenario) return;
    setMode("edit");
    setFormName(scenario.name);
    setFormComment(scenario.comment);
    const refs = scenario.changingCells.map((c) => formatCellRef(c.row, c.col)).join(", ");
    setFormChangingCellsRef(refs);
    setFormCellValues(
      scenario.changingCells.map((c) => ({
        row: c.row,
        col: c.col,
        value: c.value,
      })),
    );
    setError(null);
  }, [scenarios, selectedName]);

  const handleSave = useCallback(async () => {
    if (!formName.trim()) {
      setError("Scenario name is required.");
      return;
    }
    if (formCellValues.length === 0) {
      setError("At least one changing cell is required.");
      return;
    }

    setLoading(true);
    setError(null);

    const changingCells: ScenarioCell[] = formCellValues.map((cv) => ({
      row: cv.row,
      col: cv.col,
      value: cv.value,
    }));

    try {
      const result = await scenarioAdd({
        name: formName.trim(),
        changingCells,
        comment: formComment,
        sheetIndex,
      });

      if (!result.success) {
        setError(result.error || "Failed to save scenario.");
      } else {
        await loadScenarios();
        setMode("list");
        setSelectedName(formName.trim());
      }
    } catch (err) {
      setError(`Failed to save: ${err}`);
    } finally {
      setLoading(false);
    }
  }, [formName, formComment, formCellValues, sheetIndex, loadScenarios]);

  const handleDelete = useCallback(async () => {
    if (!selectedName) return;
    setLoading(true);
    try {
      await scenarioDelete({ name: selectedName, sheetIndex });
      await loadScenarios();
      setSelectedName(null);
    } catch (err) {
      setError(`Failed to delete: ${err}`);
    } finally {
      setLoading(false);
    }
  }, [selectedName, sheetIndex, loadScenarios]);

  const handleShow = useCallback(async () => {
    if (!selectedName) return;
    setLoading(true);
    setError(null);
    try {
      const result = await scenarioShow({ name: selectedName, sheetIndex });
      if (result.error) {
        setError(result.error);
      } else {
        window.dispatchEvent(new CustomEvent("grid:refresh"));
      }
    } catch (err) {
      setError(`Failed to show scenario: ${err}`);
    } finally {
      setLoading(false);
    }
  }, [selectedName, sheetIndex]);

  const handleSummary = useCallback(() => {
    DialogExtensions.openDialog("scenario-summary", { sheetIndex });
  }, [sheetIndex]);

  // --- Render ---

  if (mode === "add" || mode === "edit") {
    return (
      <div style={styles.backdrop}>
        <div ref={dialogRef} style={styles.dialog}>
          <div style={styles.header}>
            <span style={styles.title}>
              {mode === "add" ? "Add Scenario" : "Edit Scenario"}
            </span>
            <button style={styles.closeBtn} onClick={() => setMode("list")}>
              X
            </button>
          </div>

          <div style={styles.body}>
            <div style={styles.fieldRow}>
              <label style={styles.fieldLabel}>Scenario name:</label>
              <input
                style={styles.fieldInput}
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="Best Case"
                autoFocus
                disabled={mode === "edit"}
              />
            </div>

            <div style={styles.fieldRow}>
              <label style={styles.fieldLabel}>Changing cells:</label>
              <input
                style={styles.fieldInput}
                value={formChangingCellsRef}
                onChange={(e) => handleChangingCellsChange(e.target.value)}
                placeholder="$B$2,$B$3 or $B$2:$B$5"
              />
            </div>

            <div style={styles.fieldRow}>
              <label style={styles.fieldLabel}>Comment:</label>
              <input
                style={styles.fieldInput}
                value={formComment}
                onChange={(e) => setFormComment(e.target.value)}
                placeholder="Optional description"
              />
            </div>

            {formCellValues.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>Cell values:</div>
                {formCellValues.map((cv, i) => (
                  <div key={`${cv.row}-${cv.col}`} style={styles.cellValueRow}>
                    <span style={styles.cellValueLabel}>
                      {formatCellRef(cv.row, cv.col)}:
                    </span>
                    <input
                      style={styles.cellValueInput}
                      value={cv.value}
                      onChange={(e) => {
                        const updated = [...formCellValues];
                        updated[i] = { ...cv, value: e.target.value };
                        setFormCellValues(updated);
                      }}
                      placeholder="Value"
                    />
                  </div>
                ))}
              </div>
            )}

            {error && <div style={styles.errorText}>{error}</div>}
          </div>

          <div style={styles.footer}>
            <button style={styles.btn} onClick={() => setMode("list")}>
              Cancel
            </button>
            <button
              style={loading ? { ...styles.btnPrimary, opacity: 0.6 } : styles.btnPrimary}
              onClick={handleSave}
              disabled={loading}
            >
              {loading ? "Saving..." : "OK"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // --- List mode ---
  const selectedScenario = scenarios.find((s) => s.name === selectedName);

  return (
    <div style={styles.backdrop}>
      <div ref={dialogRef} style={styles.dialog}>
        <div style={styles.header}>
          <span style={styles.title}>Scenario Manager</span>
          <button style={styles.closeBtn} onClick={onClose}>
            X
          </button>
        </div>

        <div style={styles.body}>
          <div style={{ fontSize: 13 }}>Scenarios:</div>
          <div style={styles.listBox}>
            {scenarios.length === 0 ? (
              <div style={{ padding: "12px", color: v("--text-secondary"), fontStyle: "italic" }}>
                No scenarios defined. Click "Add..." to create one.
              </div>
            ) : (
              scenarios.map((s) => (
                <div
                  key={s.name}
                  style={s.name === selectedName ? styles.listItemSelected : styles.listItem}
                  onClick={() => setSelectedName(s.name)}
                  onDoubleClick={handleShow}
                >
                  {s.name}
                </div>
              ))
            )}
          </div>

          {selectedScenario && (
            <div style={styles.infoText}>
              Changing cells: {selectedScenario.changingCells.map((c) => formatCellRef(c.row, c.col)).join(", ")}
              {selectedScenario.comment ? ` -- ${selectedScenario.comment}` : ""}
              {selectedScenario.createdBy ? ` (by ${selectedScenario.createdBy})` : ""}
            </div>
          )}

          {error && <div style={styles.errorText}>{error}</div>}

          <div style={styles.buttonRow}>
            <button style={styles.btnPrimary} onClick={handleShow} disabled={!selectedName}>
              Show
            </button>
            <button style={styles.btn} onClick={handleAdd}>
              Add...
            </button>
            <button
              style={selectedName ? styles.btn : styles.btnDisabled}
              onClick={handleEdit}
              disabled={!selectedName}
            >
              Edit...
            </button>
            <button
              style={selectedName ? styles.btn : styles.btnDisabled}
              onClick={handleDelete}
              disabled={!selectedName}
            >
              Delete
            </button>
            <button
              style={scenarios.length > 0 ? styles.btn : styles.btnDisabled}
              onClick={handleSummary}
              disabled={scenarios.length === 0}
            >
              Summary...
            </button>
          </div>
        </div>

        <div style={styles.footer}>
          <button style={styles.btn} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
