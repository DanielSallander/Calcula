//! FILENAME: app/extensions/DataForm/components/DataFormDialog.tsx
// PURPOSE: Data Form dialog - form-based row viewer/editor.
// CONTEXT: Shows one record at a time with labeled fields from column headers.
//          Supports record navigation (First/Prev/Next/Last + jump-to), keyboard
//          flow (Enter = next, Shift+Enter = prev, Ctrl+Home/End), reverting
//          edits, and an Excel-style Criteria search mode (AND across fields).

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
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    padding: "4px 0",
  },
  jumpInput: {
    width: 48,
    padding: "3px 4px",
    fontSize: 12,
    textAlign: "center" as const,
    borderRadius: 3,
    border: `1px solid ${v("--border-default")}`,
    background: v("--grid-bg"),
    color: v("--text-primary"),
    outline: "none",
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
    gap: 6,
    flexWrap: "wrap" as const,
  },
  footerRight: {
    display: "flex",
    gap: 6,
    flexWrap: "wrap" as const,
  },
  btn: {
    padding: "6px 12px",
    fontSize: 13,
    borderRadius: 4,
    cursor: "pointer",
    minWidth: 56,
    background: v("--grid-bg"),
    color: v("--text-primary"),
    border: `1px solid ${v("--border-default")}`,
  },
  btnPrimary: {
    padding: "6px 12px",
    fontSize: 13,
    borderRadius: 4,
    cursor: "pointer",
    minWidth: 56,
    background: v("--accent-primary"),
    color: "#ffffff",
    border: `1px solid ${v("--accent-primary")}`,
  },
  btnDanger: {
    padding: "6px 12px",
    fontSize: 13,
    borderRadius: 4,
    cursor: "pointer",
    minWidth: 56,
    background: "#c0392b",
    color: "#ffffff",
    border: "1px solid #a93226",
  },
  banner: {
    fontSize: 12,
    textAlign: "center" as const,
    fontStyle: "italic" as const,
    padding: "4px 0",
  },
};

// Disabled-button visual helper.
function disabledStyle(
  base: React.CSSProperties,
  disabled: boolean,
): React.CSSProperties {
  return {
    ...base,
    opacity: disabled ? 0.5 : 1,
    cursor: disabled ? "not-allowed" : "pointer",
  };
}

// ============================================================================
// Types
// ============================================================================

interface RegionData {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

type Mode = "form" | "criteria";

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
  // Search-criteria mode (Excel-style): fields become search terms.
  const [mode, setMode] = useState<Mode>("form");
  const [criteria, setCriteria] = useState<string[]>([]);
  // Editable "jump to record" box (1-based, as text so it can be cleared).
  const [jumpText, setJumpText] = useState("");

  // First data row is right after the header row
  const headerRow = startRow;
  const firstDataRow = startRow + 1;

  // ============================================================================
  // Load headers on mount
  // ============================================================================

  useEffect(() => {
    loadHeaders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadHeaders(): Promise<void> {
    const hdrs: string[] = [];
    for (let c = startCol; c <= endCol; c++) {
      const cell = await getCell(headerRow, c);
      hdrs.push(cell?.display || columnToLetter(c));
    }
    setHeaders(hdrs);
    setCriteria(new Array(colCount).fill(""));

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
      // cell.formula already carries its leading "="; fall back to display text.
      values.push(cell?.formula || cell?.display || "");
    }
    setFieldValues(values);
    setOriginalValues([...values]);
    setCurrentRecordIndex(index);
    setJumpText(String(index + 1));
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

  const goToRecord = useCallback(
    async (index: number) => {
      if (isDirty) await saveCurrentRecord();
      const clamped = Math.max(0, Math.min(totalRecords - 1, index));
      if (totalRecords > 0) await loadRecord(clamped);
    },
    // saveCurrentRecord/loadRecord close over the latest state via re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [totalRecords, isDirty, isNewRecord, fieldValues, currentEndRow, currentRecordIndex],
  );

  const handlePrevious = useCallback(
    () => goToRecord(currentRecordIndex - 1),
    [goToRecord, currentRecordIndex],
  );
  const handleNext = useCallback(
    () => goToRecord(currentRecordIndex + 1),
    [goToRecord, currentRecordIndex],
  );
  const handleFirst = useCallback(() => goToRecord(0), [goToRecord]);
  const handleLast = useCallback(
    () => goToRecord(totalRecords - 1),
    [goToRecord, totalRecords],
  );

  const commitJump = useCallback(async () => {
    const n = parseInt(jumpText, 10);
    if (!isNaN(n)) {
      await goToRecord(n - 1); // jump box is 1-based
    } else {
      setJumpText(String(currentRecordIndex + 1));
    }
  }, [jumpText, goToRecord, currentRecordIndex]);

  // ============================================================================
  // New / Delete / Restore
  // ============================================================================

  const handleNew = useCallback(async () => {
    if (isDirty) await saveCurrentRecord();
    setFieldValues(new Array(colCount).fill(""));
    setOriginalValues(new Array(colCount).fill(""));
    setIsNewRecord(true);
    setIsDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDirty, fieldValues, colCount, isNewRecord, currentEndRow]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentRecordIndex, totalRecords, isNewRecord, currentEndRow, colCount]);

  // Revert unsaved edits to the current record (Excel "Restore").
  const handleRestore = useCallback(() => {
    setFieldValues([...originalValues]);
    setIsDirty(false);
  }, [originalValues]);

  // ============================================================================
  // Close
  // ============================================================================

  const handleClose = useCallback(async () => {
    if (isDirty) await saveCurrentRecord();
    onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDirty, fieldValues, isNewRecord, currentEndRow, onClose]);

  // ============================================================================
  // Criteria search (Excel-style: AND across all non-empty criteria fields)
  // ============================================================================

  const enterCriteria = useCallback(async () => {
    if (isDirty) await saveCurrentRecord();
    setMode("criteria");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDirty, fieldValues, isNewRecord, currentEndRow]);

  const exitCriteria = useCallback(async () => {
    setMode("form");
    if (totalRecords > 0) await loadRecord(Math.min(currentRecordIndex, totalRecords - 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalRecords, currentRecordIndex]);

  const clearCriteria = useCallback(() => {
    setCriteria(new Array(colCount).fill(""));
  }, [colCount]);

  // A record matches when EVERY non-empty criterion is a substring of its field.
  const recordMatchesCriteria = useCallback(
    async (index: number): Promise<boolean> => {
      const active = criteria
        .map((c, i) => ({ i, term: c.trim().toLowerCase() }))
        .filter((x) => x.term.length > 0);
      if (active.length === 0) return true; // no criteria → every record matches
      const row = firstDataRow + index;
      for (const { i, term } of active) {
        const cell = await getCell(row, startCol + i);
        const val = (cell?.display || "").toLowerCase();
        if (!val.includes(term)) return false;
      }
      return true;
    },
    [criteria, startCol, firstDataRow],
  );

  const findFrom = useCallback(
    async (start: number, step: number) => {
      for (let i = start; i >= 0 && i < totalRecords; i += step) {
        if (await recordMatchesCriteria(i)) {
          setMode("form");
          await loadRecord(i);
          return;
        }
      }
      // No match: stay put (Excel beeps); leave criteria mode intact.
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [totalRecords, recordMatchesCriteria],
  );

  const handleFindNext = useCallback(async () => {
    if (mode !== "criteria" && isDirty) await saveCurrentRecord();
    await findFrom(currentRecordIndex + 1, 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, isDirty, findFrom, currentRecordIndex, fieldValues]);

  const handleFindPrev = useCallback(async () => {
    if (mode !== "criteria" && isDirty) await saveCurrentRecord();
    await findFrom(currentRecordIndex - 1, -1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, isDirty, findFrom, currentRecordIndex, fieldValues]);

  // ============================================================================
  // Field change handlers
  // ============================================================================

  function handleFieldChange(index: number, value: string): void {
    if (mode === "criteria") {
      const next = [...criteria];
      next[index] = value;
      setCriteria(next);
      return;
    }
    const newValues = [...fieldValues];
    newValues[index] = value;
    setFieldValues(newValues);
    setIsDirty(true);
  }

  // Enter = next / Find Next; Shift+Enter = previous / Find Prev.
  function handleFieldKeyDown(e: React.KeyboardEvent): void {
    if (e.key === "Enter") {
      e.preventDefault();
      if (mode === "criteria") {
        if (e.shiftKey) handleFindPrev();
        else handleFindNext();
      } else if (e.shiftKey) {
        handlePrevious();
      } else {
        handleNext();
      }
    }
  }

  // ============================================================================
  // Keyboard handlers (dialog-level: Escape, Ctrl+Home/End)
  // ============================================================================

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        if (mode === "criteria") {
          exitCriteria();
        } else if (isDirty && !isNewRecord) {
          // Revert instead of saving.
          setFieldValues([...originalValues]);
          setIsDirty(false);
        } else {
          onClose();
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key === "Home") {
        e.preventDefault();
        e.stopPropagation();
        if (mode === "form") handleFirst();
      } else if ((e.ctrlKey || e.metaKey) && e.key === "End") {
        e.preventDefault();
        e.stopPropagation();
        if (mode === "form") handleLast();
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [
    mode,
    isDirty,
    isNewRecord,
    originalValues,
    onClose,
    exitCriteria,
    handleFirst,
    handleLast,
  ]);

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

  const isCriteria = mode === "criteria";
  const shownValues = isCriteria ? criteria : fieldValues;
  const noRecords = totalRecords === 0;

  return (
    <div style={styles.backdrop} onMouseDown={handleBackdropClick}>
      <div ref={dialogRef} style={styles.dialog}>
        {/* Header */}
        <div style={styles.header}>
          <span style={styles.title}>
            Data Form{isCriteria ? " — Criteria" : ""}
          </span>
          <button style={styles.closeBtn} onClick={handleClose} title="Close">
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
                value={shownValues[i] ?? ""}
                placeholder={isCriteria ? "search…" : undefined}
                onChange={(e) => handleFieldChange(i, e.target.value)}
                onKeyDown={handleFieldKeyDown}
                autoFocus={i === 0}
              />
            </div>
          ))}

          {/* Status / record jump */}
          {isCriteria ? (
            <div style={{ ...styles.banner, color: v("--accent-primary") }}>
              Enter criteria, then Find Next / Find Prev
            </div>
          ) : isNewRecord ? (
            <div style={{ ...styles.banner, color: v("--accent-primary") }}>
              New Record
            </div>
          ) : (
            <div style={styles.recordInfo}>
              {noRecords ? (
                "No records"
              ) : (
                <>
                  <span>Record</span>
                  <input
                    style={styles.jumpInput}
                    value={jumpText}
                    onChange={(e) => setJumpText(e.target.value.replace(/[^0-9]/g, ""))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commitJump();
                      }
                    }}
                    onBlur={commitJump}
                    aria-label="Jump to record"
                  />
                  <span>of {totalRecords}</span>
                </>
              )}
            </div>
          )}
        </div>

        {/* Footer - action buttons */}
        <div style={styles.footer}>
          <div style={styles.footerLeft}>
            {isCriteria ? (
              <>
                <button style={styles.btn} onClick={exitCriteria}>
                  Form
                </button>
                <button style={styles.btn} onClick={clearCriteria}>
                  Clear
                </button>
              </>
            ) : (
              <>
                <button style={styles.btn} onClick={handleNew}>
                  New
                </button>
                <button
                  style={disabledStyle(styles.btnDanger, isNewRecord || noRecords)}
                  onClick={handleDelete}
                  disabled={isNewRecord || noRecords}
                >
                  Delete
                </button>
                <button
                  style={disabledStyle(styles.btn, !isDirty)}
                  onClick={handleRestore}
                  disabled={!isDirty}
                  title="Revert unsaved changes to this record"
                >
                  Restore
                </button>
                <button style={styles.btn} onClick={enterCriteria}>
                  Criteria
                </button>
              </>
            )}
            <button
              style={disabledStyle(styles.btn, noRecords)}
              onClick={handleFindPrev}
              disabled={noRecords}
            >
              Find Prev
            </button>
            <button
              style={disabledStyle(styles.btn, noRecords)}
              onClick={handleFindNext}
              disabled={noRecords}
            >
              Find Next
            </button>
          </div>
          <div style={styles.footerRight}>
            {!isCriteria && (
              <>
                <button
                  style={disabledStyle(styles.btn, currentRecordIndex <= 0 || isNewRecord || noRecords)}
                  onClick={handleFirst}
                  disabled={currentRecordIndex <= 0 || isNewRecord || noRecords}
                  title="First record (Ctrl+Home)"
                >
                  First
                </button>
                <button
                  style={disabledStyle(styles.btn, currentRecordIndex <= 0 || isNewRecord)}
                  onClick={handlePrevious}
                  disabled={currentRecordIndex <= 0 || isNewRecord}
                >
                  Previous
                </button>
                <button
                  style={disabledStyle(styles.btn, currentRecordIndex >= totalRecords - 1 || isNewRecord)}
                  onClick={handleNext}
                  disabled={currentRecordIndex >= totalRecords - 1 || isNewRecord}
                >
                  Next
                </button>
                <button
                  style={disabledStyle(styles.btn, currentRecordIndex >= totalRecords - 1 || isNewRecord || noRecords)}
                  onClick={handleLast}
                  disabled={currentRecordIndex >= totalRecords - 1 || isNewRecord || noRecords}
                  title="Last record (Ctrl+End)"
                >
                  Last
                </button>
              </>
            )}
            <button style={styles.btnPrimary} onClick={handleClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
