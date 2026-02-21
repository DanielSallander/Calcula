//! FILENAME: app/extensions/Consolidate/components/ConsolidateDialog.tsx
// PURPOSE: Data Consolidation dialog - aggregates data from multiple sheet ranges.
// CONTEXT: Two-section dialog: configuration form, then execution.

import React, { useState, useEffect, useCallback, useRef } from "react";
import type { DialogProps } from "../../../src/api/uiTypes";
import {
  getSheets,
  consolidateData,
  columnToLetter,
  letterToColumn,
  beginUndoTransaction,
  commitUndoTransaction,
  restoreFocusToGrid,
} from "../../../src/api";
import type { ConsolidationFunction } from "../../../src/api";
import { CONSOLIDATION_FUNCTIONS } from "../types";
import type { SourceRangeEntry } from "../types";

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
    width: 460,
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
    gap: 12,
  },
  fieldRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
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
    fontFamily: '"Segoe UI", system-ui, sans-serif',
  },
  select: {
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
  addBtn: {
    padding: "5px 14px",
    fontSize: 13,
    borderRadius: 3,
    cursor: "pointer",
    background: v("--grid-bg"),
    color: v("--text-primary"),
    border: `1px solid ${v("--border-default")}`,
    flexShrink: 0,
  },
  listLabel: {
    fontSize: 13,
    marginBottom: 4,
  },
  listBox: {
    border: `1px solid ${v("--border-default")}`,
    borderRadius: 3,
    background: v("--grid-bg"),
    height: 120,
    overflowY: "auto" as const,
    padding: 2,
  },
  listItem: {
    padding: "3px 8px",
    fontSize: 13,
    cursor: "pointer",
    borderRadius: 2,
  },
  listItemSelected: {
    padding: "3px 8px",
    fontSize: 13,
    cursor: "pointer",
    borderRadius: 2,
    background: v("--accent-primary"),
    color: "#ffffff",
  },
  deleteRow: {
    display: "flex",
    justifyContent: "flex-end",
    marginTop: 4,
  },
  deleteBtn: {
    padding: "4px 14px",
    fontSize: 13,
    borderRadius: 3,
    cursor: "pointer",
    background: v("--grid-bg"),
    color: v("--text-primary"),
    border: `1px solid ${v("--border-default")}`,
  },
  separator: {
    borderTop: `1px solid ${v("--border-default")}`,
    margin: "4px 0",
  },
  checkboxRow: {
    display: "flex",
    gap: 24,
    alignItems: "center",
  },
  checkboxLabel: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontSize: 13,
    cursor: "pointer",
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: 600,
    color: v("--text-secondary"),
    marginTop: 4,
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
  },
};

// ============================================================================
// Helpers
// ============================================================================

/**
 * Parse a range reference string like "Sheet1!$A$1:$D$10" or "Sheet1!A1:D10"
 * into a SourceRangeEntry. Returns null if the reference is invalid.
 */
function parseRangeReference(
  ref: string,
  sheets: Array<{ index: number; name: string }>,
): SourceRangeEntry | null {
  const trimmed = ref.trim();
  if (!trimmed) return null;

  // Split on "!" to separate sheet name from range
  const bangIdx = trimmed.lastIndexOf("!");
  if (bangIdx === -1) return null;

  let sheetName = trimmed.substring(0, bangIdx);
  const rangePart = trimmed.substring(bangIdx + 1);

  // Remove surrounding quotes from sheet name if present
  if (sheetName.startsWith("'") && sheetName.endsWith("'")) {
    sheetName = sheetName.substring(1, sheetName.length - 1);
  }

  // Find sheet by name (case-insensitive)
  const sheet = sheets.find(
    (s) => s.name.toLowerCase() === sheetName.toLowerCase(),
  );
  if (!sheet) return null;

  // Parse range part: "A1:D10" or "$A$1:$D$10"
  const rangeParts = rangePart.split(":");
  if (rangeParts.length !== 2) return null;

  const startRef = parseCellRef(rangeParts[0]);
  const endRef = parseCellRef(rangeParts[1]);
  if (!startRef || !endRef) return null;

  // Normalize so start <= end
  const startRow = Math.min(startRef.row, endRef.row);
  const startCol = Math.min(startRef.col, endRef.col);
  const endRow = Math.max(startRef.row, endRef.row);
  const endCol = Math.max(startRef.col, endRef.col);

  return {
    display: formatRangeDisplay(sheet.name, startRow, startCol, endRow, endCol),
    sheetIndex: sheet.index,
    sheetName: sheet.name,
    startRow,
    startCol,
    endRow,
    endCol,
  };
}

/**
 * Parse a cell reference like "A1", "$A$1", "B5" to 0-based {row, col}.
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
 * Format a range as a display string: "SheetName!$A$1:$D$10"
 */
function formatRangeDisplay(
  sheetName: string,
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
): string {
  const needsQuotes = /[^A-Za-z0-9_]/.test(sheetName);
  const quotedName = needsQuotes ? `'${sheetName}'` : sheetName;
  return `${quotedName}!$${columnToLetter(startCol)}$${startRow + 1}:$${columnToLetter(endCol)}$${endRow + 1}`;
}

// ============================================================================
// Component
// ============================================================================

export function ConsolidateDialog(
  props: DialogProps,
): React.ReactElement | null {
  const { onClose, data } = props;
  const dialogRef = useRef<HTMLDivElement>(null);
  const refInputRef = useRef<HTMLInputElement>(null);

  // State
  const [selectedFunction, setSelectedFunction] =
    useState<ConsolidationFunction>("sum");
  const [referenceInput, setReferenceInput] = useState("");
  const [sourceRanges, setSourceRanges] = useState<SourceRangeEntry[]>([]);
  const [selectedRangeIndex, setSelectedRangeIndex] = useState<number | null>(
    null,
  );
  const [useTopRow, setUseTopRow] = useState(false);
  const [useLeftColumn, setUseLeftColumn] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [sheets, setSheets] = useState<Array<{ index: number; name: string }>>(
    [],
  );

  // Destination info from opening data
  const destRow = (data as Record<string, unknown> | undefined)?.activeRow as
    | number
    | undefined;
  const destCol = (data as Record<string, unknown> | undefined)?.activeCol as
    | number
    | undefined;

  // Load sheets on mount
  useEffect(() => {
    getSheets().then((result) => {
      setSheets(result.sheets);
    });
  }, []);

  // Keyboard handlers
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

  // Click outside to close
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (
        dialogRef.current &&
        !dialogRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    },
    [onClose],
  );

  // --- Handlers ---

  const handleAdd = useCallback(() => {
    setValidationError(null);

    if (!referenceInput.trim()) {
      setValidationError("Please enter a range reference.");
      return;
    }

    const entry = parseRangeReference(referenceInput, sheets);
    if (!entry) {
      setValidationError(
        'Invalid reference. Use format: SheetName!A1:D10 or SheetName!$A$1:$D$10',
      );
      return;
    }

    // Check for duplicate
    const isDuplicate = sourceRanges.some(
      (r) =>
        r.sheetIndex === entry.sheetIndex &&
        r.startRow === entry.startRow &&
        r.startCol === entry.startCol &&
        r.endRow === entry.endRow &&
        r.endCol === entry.endCol,
    );
    if (isDuplicate) {
      setValidationError("This range has already been added.");
      return;
    }

    setSourceRanges((prev) => [...prev, entry]);
    setReferenceInput("");
    refInputRef.current?.focus();
  }, [referenceInput, sheets, sourceRanges]);

  const handleDelete = useCallback(() => {
    if (selectedRangeIndex === null) return;
    setSourceRanges((prev) => prev.filter((_, i) => i !== selectedRangeIndex));
    setSelectedRangeIndex(null);
    setValidationError(null);
  }, [selectedRangeIndex]);

  const handleOk = useCallback(async () => {
    setValidationError(null);

    if (sourceRanges.length === 0) {
      setValidationError("Add at least one source range.");
      return;
    }

    const activeSheetResult = await getSheets();
    const destSheetIndex = activeSheetResult.activeIndex;

    setIsLoading(true);
    try {
      await beginUndoTransaction("Data Consolidation");

      const result = await consolidateData({
        function: selectedFunction,
        sourceRanges: sourceRanges.map((r) => ({
          sheetIndex: r.sheetIndex,
          startRow: r.startRow,
          startCol: r.startCol,
          endRow: r.endRow,
          endCol: r.endCol,
        })),
        destSheetIndex,
        destRow: destRow ?? 0,
        destCol: destCol ?? 0,
        useTopRow,
        useLeftColumn,
      });

      await commitUndoTransaction();

      if (!result.success) {
        setValidationError(result.error ?? "Consolidation failed.");
        setIsLoading(false);
        return;
      }

      // Refresh the grid to show results
      window.dispatchEvent(new CustomEvent("grid:refresh"));
      restoreFocusToGrid();
      onClose();
    } catch (err) {
      setValidationError(`Consolidation failed: ${err}`);
    } finally {
      setIsLoading(false);
    }
  }, [
    sourceRanges,
    selectedFunction,
    destRow,
    destCol,
    useTopRow,
    useLeftColumn,
    onClose,
  ]);

  const handleRefInputKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        handleAdd();
      }
    },
    [handleAdd],
  );

  // --- Render ---

  const destCellDisplay =
    destRow !== undefined && destCol !== undefined
      ? `$${columnToLetter(destCol)}$${destRow + 1}`
      : "A1";

  return (
    <div style={styles.backdrop} onMouseDown={handleBackdropClick}>
      <div ref={dialogRef} style={styles.dialog}>
        {/* Header */}
        <div style={styles.header}>
          <span style={styles.title}>Consolidate</span>
          <button style={styles.closeBtn} onClick={onClose}>
            X
          </button>
        </div>

        {/* Body */}
        <div style={styles.body}>
          {/* Function dropdown */}
          <div style={styles.fieldRow}>
            <label style={styles.fieldLabel}>Function:</label>
            <select
              style={styles.select}
              value={selectedFunction}
              onChange={(e) => {
                setSelectedFunction(
                  e.target.value as ConsolidationFunction,
                );
                setValidationError(null);
              }}
            >
              {CONSOLIDATION_FUNCTIONS.map((fn) => (
                <option key={fn.value} value={fn.value}>
                  {fn.label}
                </option>
              ))}
            </select>
          </div>

          {/* Reference input + Add */}
          <div style={styles.fieldRow}>
            <label style={styles.fieldLabel}>Reference:</label>
            <input
              ref={refInputRef}
              style={styles.fieldInput}
              value={referenceInput}
              onChange={(e) => {
                setReferenceInput(e.target.value);
                setValidationError(null);
              }}
              onKeyDown={handleRefInputKeyDown}
              placeholder="Sheet1!$A$1:$D$10"
              autoFocus
            />
            <button style={styles.addBtn} onClick={handleAdd}>
              Add
            </button>
          </div>

          {/* All references list */}
          <div>
            <div style={styles.listLabel}>All references:</div>
            <div style={styles.listBox}>
              {sourceRanges.map((entry, idx) => (
                <div
                  key={idx}
                  style={
                    idx === selectedRangeIndex
                      ? styles.listItemSelected
                      : styles.listItem
                  }
                  onClick={() => setSelectedRangeIndex(idx)}
                  onDoubleClick={() => {
                    setReferenceInput(entry.display);
                    setSourceRanges((prev) =>
                      prev.filter((_, i) => i !== idx),
                    );
                    setSelectedRangeIndex(null);
                    refInputRef.current?.focus();
                  }}
                >
                  {entry.display}
                </div>
              ))}
            </div>
            <div style={styles.deleteRow}>
              <button
                style={{
                  ...styles.deleteBtn,
                  opacity: selectedRangeIndex === null ? 0.5 : 1,
                  cursor:
                    selectedRangeIndex === null ? "not-allowed" : "pointer",
                }}
                onClick={handleDelete}
                disabled={selectedRangeIndex === null}
              >
                Delete
              </button>
            </div>
          </div>

          {/* Use labels section */}
          <div style={styles.separator} />
          <div style={styles.sectionLabel}>Use labels in:</div>
          <div style={styles.checkboxRow}>
            <label style={styles.checkboxLabel}>
              <input
                type="checkbox"
                checked={useTopRow}
                onChange={(e) => {
                  setUseTopRow(e.target.checked);
                  setValidationError(null);
                }}
              />
              Top row
            </label>
            <label style={styles.checkboxLabel}>
              <input
                type="checkbox"
                checked={useLeftColumn}
                onChange={(e) => {
                  setUseLeftColumn(e.target.checked);
                  setValidationError(null);
                }}
              />
              Left column
            </label>
          </div>

          {/* Destination info */}
          <div
            style={{
              fontSize: 12,
              color: v("--text-secondary"),
              marginTop: 2,
            }}
          >
            Destination: {destCellDisplay} (current selection)
          </div>

          {/* Error message */}
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
            {isLoading ? "Consolidating..." : "OK"}
          </button>
        </div>
      </div>
    </div>
  );
}
