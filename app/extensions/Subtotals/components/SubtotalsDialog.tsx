//! FILENAME: app/extensions/Subtotals/components/SubtotalsDialog.tsx
// PURPOSE: Dialog for configuring automatic subtotals.
// CONTEXT: User selects: group-by column, function, and target columns for subtotaling.

import React, { useState, useEffect, useCallback } from "react";
import type { DialogProps } from "../../../src/api/uiTypes";
import {
  indexToCol,
  colToIndex,
  restoreFocusToGrid,
} from "../../../src/api";
import { SUBTOTAL_FUNCTIONS } from "../types";
import type { SubtotalFunction, SubtotalConfig } from "../types";
import { applySubtotals } from "../lib/subtotalEngine";

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
    width: 420,
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
    fontSize: 18,
    lineHeight: 1,
    padding: "2px 6px",
  },
  body: {
    padding: "16px",
    display: "flex",
    flexDirection: "column" as const,
    gap: 12,
  },
  label: {
    fontWeight: 500,
    marginBottom: 4,
    display: "block",
  },
  select: {
    width: "100%",
    padding: "6px 8px",
    background: v("--input-bg"),
    color: v("--text-primary"),
    border: `1px solid ${v("--border-default")}`,
    borderRadius: 4,
    fontSize: 13,
  },
  checkboxList: {
    maxHeight: 160,
    overflowY: "auto" as const,
    border: `1px solid ${v("--border-default")}`,
    borderRadius: 4,
    padding: "6px 8px",
    background: v("--input-bg"),
  },
  checkboxItem: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "3px 0",
  },
  footer: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 8,
    padding: "12px 16px",
    borderTop: `1px solid ${v("--border-default")}`,
  },
  button: {
    padding: "6px 16px",
    borderRadius: 4,
    border: `1px solid ${v("--border-default")}`,
    background: v("--button-bg"),
    color: v("--text-primary"),
    cursor: "pointer",
    fontSize: 13,
  },
  primaryButton: {
    padding: "6px 16px",
    borderRadius: 4,
    border: "none",
    background: v("--accent-primary"),
    color: "#fff",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 600,
  },
};

// ============================================================================
// Component
// ============================================================================

interface SubtotalsDialogContext {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
}

export function SubtotalsDialog({ onClose, context }: DialogProps) {
  const ctx = context as SubtotalsDialogContext | undefined;

  // Default to a reasonable range if no context
  const startRow = ctx?.startRow ?? 0;
  const endRow = ctx?.endRow ?? 10;
  const startCol = ctx?.startCol ?? 0;
  const endCol = ctx?.endCol ?? 5;

  // Build column list from the range
  const columns: { index: number; letter: string }[] = [];
  for (let c = startCol; c <= endCol; c++) {
    columns.push({ index: c, letter: indexToCol(c) });
  }

  const [groupByCol, setGroupByCol] = useState(startCol);
  const [functionCode, setFunctionCode] = useState<SubtotalFunction>(9); // SUM
  const [selectedCols, setSelectedCols] = useState<Set<number>>(() => {
    // Default: select all numeric columns (all except groupByCol)
    const s = new Set<number>();
    for (let c = startCol; c <= endCol; c++) {
      if (c !== startCol) s.add(c);
    }
    return s;
  });
  const [isApplying, setIsApplying] = useState(false);

  // Update selected cols when groupByCol changes (uncheck the group-by column)
  useEffect(() => {
    setSelectedCols((prev) => {
      const next = new Set(prev);
      next.delete(groupByCol);
      return next;
    });
  }, [groupByCol]);

  const handleToggleCol = useCallback((col: number) => {
    setSelectedCols((prev) => {
      const next = new Set(prev);
      if (next.has(col)) {
        next.delete(col);
      } else {
        next.add(col);
      }
      return next;
    });
  }, []);

  const handleApply = useCallback(async () => {
    if (selectedCols.size === 0) return;
    setIsApplying(true);

    try {
      const config: SubtotalConfig = {
        groupByCol,
        subtotalCols: Array.from(selectedCols).sort((a, b) => a - b),
        functionCode,
        replaceExisting: true,
        startRow: startRow + 1, // Skip header row (row 0 is header)
        endRow,
        startCol,
        endCol,
      };

      await applySubtotals(config);
      onClose();
      restoreFocusToGrid();
    } catch (err) {
      console.error("[Subtotals] Apply failed:", err);
    } finally {
      setIsApplying(false);
    }
  }, [groupByCol, selectedCols, functionCode, startRow, endRow, startCol, endCol, onClose]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        restoreFocusToGrid();
      } else if (e.key === "Enter") {
        handleApply();
      }
    },
    [onClose, handleApply],
  );

  return (
    <div style={styles.backdrop} onKeyDown={handleKeyDown}>
      <div style={styles.dialog}>
        {/* Header */}
        <div style={styles.header}>
          <span style={styles.title}>Subtotals</span>
          <button
            style={styles.closeBtn}
            onClick={() => { onClose(); restoreFocusToGrid(); }}
            title="Close"
          >
            X
          </button>
        </div>

        {/* Body */}
        <div style={styles.body}>
          {/* Group by column */}
          <div>
            <label style={styles.label}>At each change in:</label>
            <select
              style={styles.select}
              value={groupByCol}
              onChange={(e) => setGroupByCol(Number(e.target.value))}
            >
              {columns.map((c) => (
                <option key={c.index} value={c.index}>
                  Column {c.letter}
                </option>
              ))}
            </select>
          </div>

          {/* Function */}
          <div>
            <label style={styles.label}>Use function:</label>
            <select
              style={styles.select}
              value={functionCode}
              onChange={(e) => setFunctionCode(Number(e.target.value) as SubtotalFunction)}
            >
              {SUBTOTAL_FUNCTIONS.map((f) => (
                <option key={f.code} value={f.code}>
                  {f.label}
                </option>
              ))}
            </select>
          </div>

          {/* Subtotal columns */}
          <div>
            <label style={styles.label}>Add subtotal to:</label>
            <div style={styles.checkboxList}>
              {columns
                .filter((c) => c.index !== groupByCol)
                .map((c) => (
                  <label key={c.index} style={styles.checkboxItem}>
                    <input
                      type="checkbox"
                      checked={selectedCols.has(c.index)}
                      onChange={() => handleToggleCol(c.index)}
                    />
                    Column {c.letter}
                  </label>
                ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div style={styles.footer}>
          <button
            style={styles.button}
            onClick={() => { onClose(); restoreFocusToGrid(); }}
          >
            Cancel
          </button>
          <button
            style={{
              ...styles.primaryButton,
              opacity: selectedCols.size === 0 || isApplying ? 0.5 : 1,
            }}
            onClick={handleApply}
            disabled={selectedCols.size === 0 || isApplying}
          >
            {isApplying ? "Applying..." : "OK"}
          </button>
        </div>
      </div>
    </div>
  );
}
