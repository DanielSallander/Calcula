//! FILENAME: app/extensions/DefinedNames/components/NewNameDialog.tsx
// PURPOSE: Dialog for creating or editing a named range definition.
// CONTEXT: Opened from Name Manager or Formulas > Define Name menu item.

import React, { useState, useEffect, useCallback, useRef } from "react";
import type { DialogProps } from "../../../src/api/uiTypes";
import {
  createNamedRange,
  updateNamedRange,
  getSheets,
  useGridState,
  AppEvents,
  emitAppEvent,
  columnToLetter,
} from "../../../src/api";
import { isValidName, formatRefersTo } from "../lib/nameUtils";

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
  field: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 4,
  },
  label: {
    fontSize: 12,
    fontWeight: 600,
    color: v("--text-secondary"),
  },
  input: {
    padding: "6px 8px",
    fontSize: 13,
    border: `1px solid ${v("--border-default")}`,
    borderRadius: 4,
    background: v("--grid-bg"),
    color: v("--text-primary"),
    outline: "none",
    fontFamily: '"Segoe UI", system-ui, sans-serif',
  },
  select: {
    padding: "6px 8px",
    fontSize: 13,
    border: `1px solid ${v("--border-default")}`,
    borderRadius: 4,
    background: v("--grid-bg"),
    color: v("--text-primary"),
    outline: "none",
    fontFamily: '"Segoe UI", system-ui, sans-serif',
  },
  textarea: {
    padding: "6px 8px",
    fontSize: 13,
    border: `1px solid ${v("--border-default")}`,
    borderRadius: 4,
    background: v("--grid-bg"),
    color: v("--text-primary"),
    outline: "none",
    fontFamily: '"Segoe UI", system-ui, sans-serif',
    resize: "vertical" as const,
    minHeight: 40,
  },
  error: {
    color: "#e74c3c",
    fontSize: 11,
    marginTop: 2,
  },
  footer: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 8,
    padding: "12px 16px",
    borderTop: `1px solid ${v("--border-default")}`,
  },
  btn: {
    padding: "6px 16px",
    fontSize: 13,
    borderRadius: 4,
    cursor: "pointer",
    minWidth: 70,
    background: v("--grid-bg"),
    color: v("--text-primary"),
    border: `1px solid ${v("--border-default")}`,
  },
  btnPrimary: {
    padding: "6px 16px",
    fontSize: 13,
    borderRadius: 4,
    cursor: "pointer",
    minWidth: 70,
    background: v("--accent-primary"),
    color: "#ffffff",
    border: `1px solid ${v("--accent-primary")}`,
  },
  btnDisabled: {
    opacity: 0.45,
    cursor: "not-allowed" as const,
  },
};

export function NewNameDialog(props: DialogProps): React.ReactElement | null {
  const { isOpen, onClose, data } = props;
  const dialogRef = useRef<HTMLDivElement>(null);
  const gridState = useGridState();

  const mode = (data?.mode as string) ?? "new";
  const editName = data?.editName as string | undefined;
  const editRefersTo = data?.editRefersTo as string | undefined;
  const editSheetIndex = data?.editSheetIndex as number | null | undefined;
  const editComment = data?.editComment as string | undefined;

  const [name, setName] = useState("");
  const [scopeIndex, setScopeIndex] = useState<number | null>(null);
  const [refersTo, setRefersTo] = useState("");
  const [comment, setComment] = useState("");
  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!isOpen) return;

    // Load sheet names
    getSheets().then((result) => {
      setSheetNames(result.sheets.map((s) => s.name));
    });

    // Populate fields based on mode
    if (mode === "edit" && editName) {
      setName(editName);
      setScopeIndex(editSheetIndex ?? null);
      setRefersTo(editRefersTo ?? "");
      setComment(editComment ?? "");
    } else {
      setName("");
      setScopeIndex(null);
      setComment("");
      // Auto-populate refersTo from current selection
      if (gridState.selection) {
        const sel = gridState.selection;
        const sheetName = gridState.sheetContext.activeSheetName;
        setRefersTo(
          formatRefersTo(
            sheetName,
            sel.startRow,
            sel.startCol,
            sel.endRow,
            sel.endCol
          )
        );
      } else {
        setRefersTo("=$A$1");
      }
    }
    setValidationError(null);
    setIsSubmitting(false);
  }, [isOpen, mode, editName, editRefersTo, editSheetIndex, editComment]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) {
        onClose();
      }
    },
    [onClose]
  );

  useEffect(() => {
    if (!isOpen) return;

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [isOpen, onClose]);

  const handleOk = useCallback(async () => {
    // Validate name
    if (!isValidName(name)) {
      setValidationError(
        "Invalid name. Names must start with a letter or underscore, contain only letters, numbers, underscores, and periods, and cannot be cell references."
      );
      return;
    }

    // Validate refersTo
    if (!refersTo.trim()) {
      setValidationError("Refers To cannot be empty.");
      return;
    }

    setIsSubmitting(true);
    setValidationError(null);

    try {
      if (mode === "edit" && editName) {
        const result = await updateNamedRange(
          editName,
          scopeIndex,
          refersTo.trim(),
          comment || undefined
        );
        if (!result.success) {
          setValidationError(result.error ?? "Failed to update named range.");
          setIsSubmitting(false);
          return;
        }
      } else {
        const result = await createNamedRange(
          name,
          scopeIndex,
          refersTo.trim(),
          comment || undefined
        );
        if (!result.success) {
          setValidationError(result.error ?? "Failed to create named range.");
          setIsSubmitting(false);
          return;
        }
      }

      emitAppEvent(AppEvents.NAMED_RANGES_CHANGED);
      onClose();
    } catch (error) {
      setValidationError(`Error: ${error}`);
      setIsSubmitting(false);
    }
  }, [name, scopeIndex, refersTo, comment, mode, editName, onClose]);

  if (!isOpen) return null;

  const title = mode === "edit" ? "Edit Name" : "New Name";
  const okDisabled = isSubmitting || !name.trim() || !refersTo.trim();

  return (
    <div style={styles.backdrop} onMouseDown={handleBackdropClick}>
      <div ref={dialogRef} style={styles.dialog}>
        <div style={styles.header}>
          <span style={styles.title}>{title}</span>
          <button style={styles.closeBtn} onClick={onClose}>
            X
          </button>
        </div>

        <div style={styles.body}>
          <div style={styles.field}>
            <label style={styles.label}>Name:</label>
            <input
              style={styles.input}
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setValidationError(null);
              }}
              disabled={mode === "edit"}
              autoFocus
              onKeyDown={(e) => e.stopPropagation()}
            />
          </div>

          <div style={styles.field}>
            <label style={styles.label}>Scope:</label>
            <select
              style={styles.select}
              value={scopeIndex === null ? "__workbook__" : String(scopeIndex)}
              onChange={(e) => {
                const val = e.target.value;
                setScopeIndex(val === "__workbook__" ? null : parseInt(val, 10));
              }}
              onKeyDown={(e) => e.stopPropagation()}
            >
              <option value="__workbook__">Workbook</option>
              {sheetNames.map((sn, i) => (
                <option key={i} value={String(i)}>
                  {sn}
                </option>
              ))}
            </select>
          </div>

          <div style={styles.field}>
            <label style={styles.label}>Comment:</label>
            <textarea
              style={styles.textarea}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={2}
              onKeyDown={(e) => e.stopPropagation()}
            />
          </div>

          <div style={styles.field}>
            <label style={styles.label}>Refers to:</label>
            <input
              style={styles.input}
              type="text"
              value={refersTo}
              onChange={(e) => {
                setRefersTo(e.target.value);
                setValidationError(null);
              }}
              onKeyDown={(e) => e.stopPropagation()}
            />
          </div>

          {validationError && (
            <div style={styles.error}>{validationError}</div>
          )}
        </div>

        <div style={styles.footer}>
          <button style={styles.btn} onClick={onClose}>
            Cancel
          </button>
          <button
            style={
              okDisabled
                ? { ...styles.btnPrimary, ...styles.btnDisabled }
                : styles.btnPrimary
            }
            onClick={handleOk}
            disabled={okDisabled}
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
