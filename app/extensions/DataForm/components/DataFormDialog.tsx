//! FILENAME: app/extensions/DataForm/components/DataFormDialog.tsx
// PURPOSE: Data Form dialog - form-based row viewer/editor.
// CONTEXT: Shows one record at a time with labeled fields from column headers.

import React, { useState, useEffect, useCallback, useRef } from "react";
import type { DialogProps } from "@api/uiTypes";
import {
  getCell,
  updateCellsBatch,
  deleteRows,
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
    width: 460,
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
    gap: 10,
    overflowY: "auto" as const,
    flex: 1,
  },
  fieldRow: {
    display: "flex",
    alignItems: "center",
    gap: 12,
  },
  fieldLabel: {
    width: 140,
    fontSize: 13,
    flexShrink: 0,
    overflow: "hidden" as const,
    textOverflow: "ellipsis" as const,
    whiteSpace: "nowrap" as const,
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
  recordInfo: {
    fontSize: 12,
    color: v("--text-secondary"),
    textAlign: "center" as const,
    padding: "4px 0",
  },
  footer: {
    display: "flex",
    justifyContent: "space-between",
    gap: 8,
    padding: "12px 16px",
    borderTop: `1px solid ${v("--border-default")}`,
    flexWrap: "wrap" as const,
  },
  footerLeft: {
    display: "flex",
    gap: 8,
  },
  footerRight: {
    display: "flex",
    gap: 8,
  },
  btn: {
    padding: "6px 16px",
    fontSize: 13,
    borderRadius: 4,
    cursor: "pointer",
    minWidth: 72,
    background: v("--grid-bg"),
    color: v("--text-primary"),
    border: `1px solid ${v("--border-default")}`,
  },
  btnPrimary: {
    padding: "6px 16px",
    fontSize: 13,
    borderRadius: 4,
    cursor: "pointer",
    minWidth: 72,
    background: v("--accent-primary"),
    color: "#ffffff",
    border: `1px solid ${v("--accent-primary")}`,
  },
  btnDanger: {
    padding: "6px 16px",
    fontSize: 13,
    borderRadius: 4,
    cursor: "pointer",
    minWidth: 72,
    background: "#c0392b",
    color: "#ffffff",
    border: "1px solid #a93226",
  },
  newRecordBanner: {
    fontSize: 12,
    color: v("--accent-primary"),
    textAlign: "center" as const,
    fontStyle: "italic" as const,
    padding: "4px 0",
  },
};

// ============================================================================
// Types
// ============================================================================

interface RegionData {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

// ============================================================================
// Component
// ============================================================================

export function DataFormDialog(props: DialogProps): React.ReactElement | null {
  const { onClose, data } = props;
  const dialogRef = useRef<HTMLDivElement>(null);

  // Region bounds from dialog data
  const region = data as unknown as RegionData | undefined;
  const startRow = region?.startRow ?? 0;
  const startCol = region?.startCol ?? 0;
  const endRow = region?.endRow ?? 0;
  const endCol = region?.endCol ?? 0;

  const colCount = endCol - startCol + 1;

  // State
  const [headers, setHeaders] = useState<string[]>([]);
  const [currentRecordIndex, setCurrentRecordIndex] = useState(0);
  const [fieldValues, setFieldValues] = useState<string[]>([]);
  const [originalValues, setOriginalValues] = useState<string[]>([]);
  const [totalRecords, setTotalRecords] = useState(0);
  const [isNewRecord, setIsNewRecord] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  // Track dynamic end row as records are added/deleted
  const [currentEndRow, setCurrentEndRow] = useState(endRow);

  // First data row is right after the header row
  const headerRow = startRow;
  const firstDataRow = startRow + 1;

  // ============================================================================
  // Load headers on mount
  // ============================================================================

  useEffect(() => {
    loadHeaders();
  }, []);

  async function loadHeaders(): Promise<void> {
    const hdrs: string[] = [];
    for (let c = startCol; c <= endCol; c++) {
      const cell = await getCell(headerRow, c);
      hdrs.push(cell?.display || columnToLetter(c));
    }
    setHeaders(hdrs);

    const recordCount = currentEndRow - headerRow; // rows after header
    setTotalRecords(Math.max(0, recordCount));

    if (recordCount > 0) {
      await loadRecord(0);
    } else {
      setFieldValues(new Array(colCount).fill(""));
      setOriginalValues(new Array(colCount).fill(""));
    }
    setIsLoading(false);
  }

  // ============================================================================
  // Load a record by index
  // ============================================================================

  async function loadRecord(index: number): Promise<void> {
    const row = firstDataRow + index;
    const values: string[] = [];
    for (let c = startCol; c <= endCol; c++) {
      const cell = await getCell(row, c);
      // Use the formula if present, otherwise the display value
      values.push(cell?.formula ? `=${cell.formula}` : cell?.display || "");
    }
    setFieldValues(values);
    setOriginalValues([...values]);
    setCurrentRecordIndex(index);
    setIsNewRecord(false);
    setIsDirty(false);
  }

  // ============================================================================
  // Save current record changes
  // ============================================================================

  async function saveCurrentRecord(): Promise<void> {
    if (!isDirty) return;

    const row = isNewRecord
      ? currentEndRow + 1 // append after current last row
      : firstDataRow + currentRecordIndex;

    const updates = fieldValues.map((val, i) => ({
      row,
      col: startCol + i,
      value: val,
    }));

    await updateCellsBatch(updates);
    window.dispatchEvent(new CustomEvent("grid:refresh"));

    if (isNewRecord) {
      // Expand the range
      const newEndRow = currentEndRow + 1;
      setCurrentEndRow(newEndRow);
      setTotalRecords(newEndRow - headerRow);
      setIsNewRecord(false);
      setCurrentRecordIndex(newEndRow - headerRow - 1);
    }

    setOriginalValues([...fieldValues]);
    setIsDirty(false);
  }

  // ============================================================================
  // Navigation
  // ============================================================================

  const handlePrevious = useCallback(async () => {
    if (isDirty) await saveCurrentRecord();
    if (currentRecordIndex > 0) {
      await loadRecord(currentRecordIndex - 1);
    }
  }, [currentRecordIndex, isDirty, fieldValues, isNewRecord, currentEndRow]);

  const handleNext = useCallback(async () => {
    if (isDirty) await saveCurrentRecord();
    if (currentRecordIndex < totalRecords - 1) {
      await loadRecord(currentRecordIndex + 1);
    }
  }, [currentRecordIndex, totalRecords, isDirty, fieldValues, isNewRecord, currentEndRow]);

  // ============================================================================
  // New Record
  // ============================================================================

  const handleNew = useCallback(async () => {
    if (isDirty) await saveCurrentRecord();
    setFieldValues(new Array(colCount).fill(""));
    setOriginalValues(new Array(colCount).fill(""));
    setIsNewRecord(true);
    setIsDirty(false);
  }, [isDirty, fieldValues, colCount, isNewRecord, currentEndRow]);

  // ============================================================================
  // Delete Record
  // ============================================================================

  const handleDelete = useCallback(async () => {
    if (isNewRecord || totalRecords === 0) return;

    const row = firstDataRow + currentRecordIndex;
    await deleteRows(row, 1);
    window.dispatchEvent(new CustomEvent("grid:refresh"));

    const newEndRow = currentEndRow - 1;
    setCurrentEndRow(newEndRow);
    const newTotal = Math.max(0, newEndRow - headerRow);
    setTotalRecords(newTotal);

    if (newTotal === 0) {
      // No records left
      setFieldValues(new Array(colCount).fill(""));
      setOriginalValues(new Array(colCount).fill(""));
      setCurrentRecordIndex(0);
      setIsDirty(false);
    } else if (currentRecordIndex >= newTotal) {
      // Was last record, go to new last
      await loadRecord(newTotal - 1);
    } else {
      // Same index, but row shifted up — reload
      await loadRecord(currentRecordIndex);
    }
  }, [currentRecordIndex, totalRecords, isNewRecord, currentEndRow, colCount]);

  // ============================================================================
  // Close
  // ============================================================================

  const handleClose = useCallback(async () => {
    if (isDirty) await saveCurrentRecord();
    onClose();
  }, [isDirty, fieldValues, isNewRecord, currentEndRow, onClose]);

  // ============================================================================
  // Find (simple sequential search)
  // ============================================================================

  const handleFindNext = useCallback(async () => {
    if (isDirty) await saveCurrentRecord();
    // Search forward from current position
    for (let i = currentRecordIndex + 1; i < totalRecords; i++) {
      const row = firstDataRow + i;
      for (let c = startCol; c <= endCol; c++) {
        const cell = await getCell(row, c);
        const cellVal = cell?.display || "";
        // Match against non-empty field values as criteria
        const fieldIdx = c - startCol;
        const criteria = fieldValues[fieldIdx];
        if (
          criteria &&
          cellVal.toLowerCase().includes(criteria.toLowerCase())
        ) {
          await loadRecord(i);
          return;
        }
      }
    }
  }, [currentRecordIndex, totalRecords, fieldValues, isDirty, isNewRecord, currentEndRow]);

  const handleFindPrev = useCallback(async () => {
    if (isDirty) await saveCurrentRecord();
    // Search backward from current position
    for (let i = currentRecordIndex - 1; i >= 0; i--) {
      const row = firstDataRow + i;
      for (let c = startCol; c <= endCol; c++) {
        const cell = await getCell(row, c);
        const cellVal = cell?.display || "";
        const fieldIdx = c - startCol;
        const criteria = fieldValues[fieldIdx];
        if (
          criteria &&
          cellVal.toLowerCase().includes(criteria.toLowerCase())
        ) {
          await loadRecord(i);
          return;
        }
      }
    }
  }, [currentRecordIndex, fieldValues, isDirty, isNewRecord, currentEndRow]);

  // ============================================================================
  // Field change handler
  // ============================================================================

  function handleFieldChange(index: number, value: string): void {
    const newValues = [...fieldValues];
    newValues[index] = value;
    setFieldValues(newValues);
    setIsDirty(true);
  }

  // ============================================================================
  // Keyboard handlers
  // ============================================================================

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        // If dirty, revert instead of saving
        if (isDirty && !isNewRecord) {
          setFieldValues([...originalValues]);
          setIsDirty(false);
        } else {
          onClose();
        }
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [isDirty, isNewRecord, originalValues, onClose]);

  // Click outside to close
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) {
        handleClose();
      }
    },
    [handleClose],
  );

  // ============================================================================
  // Render
  // ============================================================================

  if (isLoading) {
    return (
      <div style={styles.backdrop}>
        <div ref={dialogRef} style={styles.dialog}>
          <div style={styles.header}>
            <span style={styles.title}>Data Form</span>
          </div>
          <div style={styles.body}>
            <div style={styles.recordInfo}>Loading...</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.backdrop} onMouseDown={handleBackdropClick}>
      <div ref={dialogRef} style={styles.dialog}>
        {/* Header */}
        <div style={styles.header}>
          <span style={styles.title}>Data Form</span>
          <button style={styles.closeBtn} onClick={handleClose}>
            X
          </button>
        </div>

        {/* Body - field inputs */}
        <div style={styles.body}>
          {headers.map((header, i) => (
            <div key={i} style={styles.fieldRow}>
              <label style={styles.fieldLabel} title={header}>
                {header}:
              </label>
              <input
                style={styles.fieldInput}
                value={fieldValues[i] ?? ""}
                onChange={(e) => handleFieldChange(i, e.target.value)}
                autoFocus={i === 0}
              />
            </div>
          ))}

          {/* Record counter */}
          {isNewRecord ? (
            <div style={styles.newRecordBanner}>New Record</div>
          ) : (
            <div style={styles.recordInfo}>
              {totalRecords > 0
                ? `Record ${currentRecordIndex + 1} of ${totalRecords}`
                : "No records"}
            </div>
          )}
        </div>

        {/* Footer - action buttons */}
        <div style={styles.footer}>
          <div style={styles.footerLeft}>
            <button style={styles.btn} onClick={handleNew}>
              New
            </button>
            <button
              style={{
                ...styles.btnDanger,
                opacity: isNewRecord || totalRecords === 0 ? 0.5 : 1,
                cursor:
                  isNewRecord || totalRecords === 0
                    ? "not-allowed"
                    : "pointer",
              }}
              onClick={handleDelete}
              disabled={isNewRecord || totalRecords === 0}
            >
              Delete
            </button>
            <button
              style={{
                ...styles.btn,
                opacity: totalRecords === 0 ? 0.5 : 1,
                cursor: totalRecords === 0 ? "not-allowed" : "pointer",
              }}
              onClick={handleFindPrev}
              disabled={totalRecords === 0}
            >
              Find Prev
            </button>
            <button
              style={{
                ...styles.btn,
                opacity: totalRecords === 0 ? 0.5 : 1,
                cursor: totalRecords === 0 ? "not-allowed" : "pointer",
              }}
              onClick={handleFindNext}
              disabled={totalRecords === 0}
            >
              Find Next
            </button>
          </div>
          <div style={styles.footerRight}>
            <button
              style={{
                ...styles.btn,
                opacity: currentRecordIndex <= 0 || isNewRecord ? 0.5 : 1,
                cursor:
                  currentRecordIndex <= 0 || isNewRecord
                    ? "not-allowed"
                    : "pointer",
              }}
              onClick={handlePrevious}
              disabled={currentRecordIndex <= 0 || isNewRecord}
            >
              Previous
            </button>
            <button
              style={{
                ...styles.btn,
                opacity:
                  currentRecordIndex >= totalRecords - 1 || isNewRecord
                    ? 0.5
                    : 1,
                cursor:
                  currentRecordIndex >= totalRecords - 1 || isNewRecord
                    ? "not-allowed"
                    : "pointer",
              }}
              onClick={handleNext}
              disabled={currentRecordIndex >= totalRecords - 1 || isNewRecord}
            >
              Next
            </button>
            <button style={styles.btnPrimary} onClick={handleClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
