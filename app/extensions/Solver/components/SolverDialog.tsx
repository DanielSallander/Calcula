//! FILENAME: app/extensions/Solver/components/SolverDialog.tsx
// PURPOSE: Solver dialog - configure objective, variables, constraints, and method.

import React, { useState, useEffect, useCallback, useRef } from "react";
import type { DialogProps } from "../../../src/api/uiTypes";
import {
  solverSolve,
  columnToLetter,
  DialogExtensions,
} from "../../../src/api";
import type {
  SolverObjective,
  SolverMethod,
  ConstraintOperator,
  SolverConstraint,
  SolverVariableCell,
} from "../../../src/api";

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
    maxHeight: "85vh",
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
  section: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 8,
  },
  sectionLabel: {
    fontWeight: 600,
    fontSize: 13,
  },
  fieldRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
  },
  fieldLabel: {
    width: 110,
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
  radioRow: {
    display: "flex",
    alignItems: "center",
    gap: 16,
    fontSize: 13,
  },
  radioLabel: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    cursor: "pointer",
  },
  constraintBox: {
    border: `1px solid ${v("--border-default")}`,
    borderRadius: 4,
    background: v("--grid-bg"),
    minHeight: 80,
    maxHeight: 150,
    overflow: "auto",
    padding: 4,
  },
  constraintItem: {
    padding: "3px 6px",
    fontSize: 12,
    fontFamily: "monospace",
    borderBottom: `1px solid ${v("--border-default")}`,
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  constraintRemoveBtn: {
    background: "transparent",
    border: "none",
    color: "#e74c3c",
    cursor: "pointer",
    fontSize: 14,
    padding: "0 4px",
  },
  buttonRow: {
    display: "flex",
    gap: 6,
  },
  btn: {
    padding: "5px 14px",
    fontSize: 13,
    borderRadius: 4,
    cursor: "pointer",
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
  select: {
    padding: "5px 8px",
    fontSize: 13,
    borderRadius: 3,
    border: `1px solid ${v("--border-default")}`,
    background: v("--grid-bg"),
    color: v("--text-primary"),
    outline: "none",
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

function formatCellRef(row: number, col: number): string {
  return `$${columnToLetter(col)}$${row + 1}`;
}

function parseCellList(refs: string): SolverVariableCell[] {
  const cells: SolverVariableCell[] = [];
  const parts = refs.split(",");
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

const operatorLabels: Record<ConstraintOperator, string> = {
  lessEqual: "<=",
  greaterEqual: ">=",
  equal: "=",
  integer: "int",
  binary: "bin",
  allDifferent: "dif",
};

interface ConstraintEntry {
  cellRef: string;
  operator: ConstraintOperator;
  rhsRef: string;
}

function formatConstraint(c: ConstraintEntry): string {
  const op = operatorLabels[c.operator];
  if (c.operator === "integer" || c.operator === "binary" || c.operator === "allDifferent") {
    return `${c.cellRef} = ${op}`;
  }
  return `${c.cellRef} ${op} ${c.rhsRef}`;
}

// ============================================================================
// Component
// ============================================================================

export function SolverDialog(props: DialogProps): React.ReactElement | null {
  const { onClose, data } = props;
  const dialogRef = useRef<HTMLDivElement>(null);

  // Form state
  const [objectiveCellRef, setObjectiveCellRef] = useState("");
  const [objectiveType, setObjectiveType] = useState<SolverObjective>("maximize");
  const [targetValueStr, setTargetValueStr] = useState("");
  const [variableCellsRef, setVariableCellsRef] = useState("");
  const [method, setMethod] = useState<SolverMethod>("grgNonlinear");
  const [constraints, setConstraints] = useState<ConstraintEntry[]>([]);

  // Add constraint form
  const [showAddConstraint, setShowAddConstraint] = useState(false);
  const [newConstraintCell, setNewConstraintCell] = useState("");
  const [newConstraintOp, setNewConstraintOp] = useState<ConstraintOperator>("lessEqual");
  const [newConstraintRhs, setNewConstraintRhs] = useState("");

  const [validationError, setValidationError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Pre-fill objective cell
  useEffect(() => {
    const sel = data as Record<string, unknown> | undefined;
    const activeRow = (sel?.activeRow as number) ?? 0;
    const activeCol = (sel?.activeCol as number) ?? 0;
    setObjectiveCellRef(formatCellRef(activeRow, activeCol));
  }, []);

  // Keyboard handler
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        if (showAddConstraint) {
          setShowAddConstraint(false);
        } else {
          onClose();
        }
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose, showAddConstraint]);

  const handleAddConstraint = useCallback(() => {
    if (!newConstraintCell.trim()) return;

    const needsRhs = !["integer", "binary", "allDifferent"].includes(newConstraintOp);
    if (needsRhs && !newConstraintRhs.trim()) return;

    setConstraints((prev) => [
      ...prev,
      {
        cellRef: newConstraintCell.trim(),
        operator: newConstraintOp,
        rhsRef: newConstraintRhs.trim(),
      },
    ]);
    setNewConstraintCell("");
    setNewConstraintRhs("");
    setShowAddConstraint(false);
  }, [newConstraintCell, newConstraintOp, newConstraintRhs]);

  const handleRemoveConstraint = useCallback((index: number) => {
    setConstraints((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleSolve = useCallback(async () => {
    setValidationError(null);

    // Validate objective cell
    const objCell = parseCellRef(objectiveCellRef);
    if (!objCell) {
      setValidationError("Invalid objective cell reference.");
      return;
    }

    // Validate variable cells
    const variableCells = parseCellList(variableCellsRef);
    if (variableCells.length === 0) {
      setValidationError("At least one variable cell is required.");
      return;
    }

    // Validate target value if needed
    let targetValue: number | undefined;
    if (objectiveType === "targetValue") {
      targetValue = parseFloat(targetValueStr);
      if (isNaN(targetValue)) {
        setValidationError("Target value must be a number.");
        return;
      }
    }

    // Build constraints
    const solverConstraints: SolverConstraint[] = [];
    for (const c of constraints) {
      const cellCoords = parseCellRef(c.cellRef);
      if (!cellCoords) {
        setValidationError(`Invalid constraint cell reference: ${c.cellRef}`);
        return;
      }

      const constraint: SolverConstraint = {
        cellRow: cellCoords.row,
        cellCol: cellCoords.col,
        operator: c.operator,
      };

      if (!["integer", "binary", "allDifferent"].includes(c.operator)) {
        // Try parsing as number first, then as cell reference
        const numVal = parseFloat(c.rhsRef);
        if (!isNaN(numVal)) {
          constraint.rhsValue = numVal;
        } else {
          const rhsCell = parseCellRef(c.rhsRef);
          if (!rhsCell) {
            setValidationError(`Invalid constraint RHS: ${c.rhsRef}`);
            return;
          }
          constraint.rhsCellRow = rhsCell.row;
          constraint.rhsCellCol = rhsCell.col;
        }
      }

      solverConstraints.push(constraint);
    }

    setIsLoading(true);

    try {
      const result = await solverSolve({
        sheetIndex: 0,
        objectiveRow: objCell.row,
        objectiveCol: objCell.col,
        objective: objectiveType,
        targetValue,
        variableCells,
        constraints: solverConstraints,
        method,
      });

      if (result.error) {
        setValidationError(result.error);
        setIsLoading(false);
        return;
      }

      // Refresh grid
      window.dispatchEvent(new CustomEvent("grid:refresh"));

      // Show result dialog
      DialogExtensions.openDialog("solver-result", {
        result,
        sheetIndex: 0,
      });

      onClose();
    } catch (err) {
      setValidationError(`Solver failed: ${err}`);
    } finally {
      setIsLoading(false);
    }
  }, [
    objectiveCellRef,
    objectiveType,
    targetValueStr,
    variableCellsRef,
    method,
    constraints,
    onClose,
  ]);

  // --- Add Constraint Sub-form ---

  if (showAddConstraint) {
    return (
      <div style={styles.backdrop}>
        <div ref={dialogRef} style={{ ...styles.dialog, width: 420 }}>
          <div style={styles.header}>
            <span style={styles.title}>Add Constraint</span>
          </div>

          <div style={styles.body}>
            <div style={styles.fieldRow}>
              <label style={styles.fieldLabel}>Cell Reference:</label>
              <input
                style={styles.fieldInput}
                value={newConstraintCell}
                onChange={(e) => setNewConstraintCell(e.target.value)}
                placeholder="$B$2"
                autoFocus
              />
            </div>

            <div style={styles.fieldRow}>
              <label style={styles.fieldLabel}>Operator:</label>
              <select
                style={styles.select}
                value={newConstraintOp}
                onChange={(e) => setNewConstraintOp(e.target.value as ConstraintOperator)}
              >
                <option value="lessEqual">{"<="}</option>
                <option value="greaterEqual">{">="}</option>
                <option value="equal">{"="}</option>
                <option value="integer">int</option>
                <option value="binary">bin</option>
                <option value="allDifferent">dif</option>
              </select>
            </div>

            {!["integer", "binary", "allDifferent"].includes(newConstraintOp) && (
              <div style={styles.fieldRow}>
                <label style={styles.fieldLabel}>Constraint:</label>
                <input
                  style={styles.fieldInput}
                  value={newConstraintRhs}
                  onChange={(e) => setNewConstraintRhs(e.target.value)}
                  placeholder="100 or $C$1"
                />
              </div>
            )}
          </div>

          <div style={styles.footer}>
            <button style={styles.btn} onClick={() => setShowAddConstraint(false)}>
              Cancel
            </button>
            <button style={styles.btnPrimary} onClick={handleAddConstraint}>
              Add
            </button>
          </div>
        </div>
      </div>
    );
  }

  // --- Main Solver Dialog ---

  return (
    <div style={styles.backdrop}>
      <div ref={dialogRef} style={styles.dialog}>
        <div style={styles.header}>
          <span style={styles.title}>Solver Parameters</span>
          <button style={styles.closeBtn} onClick={onClose}>
            X
          </button>
        </div>

        <div style={styles.body}>
          {/* Objective */}
          <div style={styles.section}>
            <div style={styles.fieldRow}>
              <label style={styles.fieldLabel}>Set Objective:</label>
              <input
                style={styles.fieldInput}
                value={objectiveCellRef}
                onChange={(e) => {
                  setObjectiveCellRef(e.target.value);
                  setValidationError(null);
                }}
                placeholder="$D$5"
              />
            </div>

            <div style={styles.radioRow}>
              <label style={styles.radioLabel}>
                <input
                  type="radio"
                  name="objective"
                  checked={objectiveType === "maximize"}
                  onChange={() => setObjectiveType("maximize")}
                />
                Max
              </label>
              <label style={styles.radioLabel}>
                <input
                  type="radio"
                  name="objective"
                  checked={objectiveType === "minimize"}
                  onChange={() => setObjectiveType("minimize")}
                />
                Min
              </label>
              <label style={styles.radioLabel}>
                <input
                  type="radio"
                  name="objective"
                  checked={objectiveType === "targetValue"}
                  onChange={() => setObjectiveType("targetValue")}
                />
                Value Of:
              </label>
              {objectiveType === "targetValue" && (
                <input
                  style={{ ...styles.fieldInput, width: 80, flex: "none" }}
                  value={targetValueStr}
                  onChange={(e) => setTargetValueStr(e.target.value)}
                  placeholder="0"
                  type="text"
                  inputMode="decimal"
                />
              )}
            </div>
          </div>

          {/* Variable Cells */}
          <div style={styles.fieldRow}>
            <label style={styles.fieldLabel}>Variable Cells:</label>
            <input
              style={styles.fieldInput}
              value={variableCellsRef}
              onChange={(e) => {
                setVariableCellsRef(e.target.value);
                setValidationError(null);
              }}
              placeholder="$B$2:$B$5 or $B$2,$C$2"
            />
          </div>

          {/* Constraints */}
          <div style={styles.section}>
            <div style={styles.sectionLabel}>Subject to the Constraints:</div>
            <div style={styles.constraintBox}>
              {constraints.length === 0 ? (
                <div style={{ padding: 8, color: v("--text-secondary"), fontStyle: "italic", fontSize: 12 }}>
                  No constraints added.
                </div>
              ) : (
                constraints.map((c, i) => (
                  <div key={i} style={styles.constraintItem}>
                    <span>{formatConstraint(c)}</span>
                    <button
                      style={styles.constraintRemoveBtn}
                      onClick={() => handleRemoveConstraint(i)}
                      title="Remove constraint"
                    >
                      X
                    </button>
                  </div>
                ))
              )}
            </div>
            <div style={styles.buttonRow}>
              <button style={styles.btn} onClick={() => setShowAddConstraint(true)}>
                Add...
              </button>
            </div>
          </div>

          {/* Method */}
          <div style={styles.fieldRow}>
            <label style={styles.fieldLabel}>Solving Method:</label>
            <select
              style={{ ...styles.select, flex: 1 }}
              value={method}
              onChange={(e) => setMethod(e.target.value as SolverMethod)}
            >
              <option value="grgNonlinear">GRG Nonlinear</option>
              <option value="simplexLp">Simplex LP</option>
              <option value="evolutionary">Evolutionary</option>
            </select>
          </div>

          {validationError && (
            <div style={styles.errorText}>{validationError}</div>
          )}
        </div>

        <div style={styles.footer}>
          <button style={styles.btn} onClick={onClose}>
            Close
          </button>
          <button
            style={{
              ...styles.btnPrimary,
              opacity: isLoading ? 0.6 : 1,
              cursor: isLoading ? "not-allowed" : "pointer",
            }}
            onClick={handleSolve}
            disabled={isLoading}
          >
            {isLoading ? "Solving..." : "Solve"}
          </button>
        </div>
      </div>
    </div>
  );
}
