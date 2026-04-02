//! FILENAME: app/extensions/Pivot/components/CalculatedFieldDialog.tsx
// PURPOSE: Dialog for creating/editing calculated fields in pivot tables
// CONTEXT: User enters a name and formula that references other field names

import React, { useState, useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { css } from "@emotion/css";

export interface CalculatedFieldDialogProps {
  isOpen: boolean;
  /** Available source field names for formula autocomplete */
  fieldNames: string[];
  /** If editing, the initial values */
  initialName?: string;
  initialFormula?: string;
  initialNumberFormat?: string;
  /** Called when the user saves */
  onSave: (name: string, formula: string, numberFormat?: string) => void;
  onCancel: () => void;
  /** Title override (defaults to "Insert Calculated Field") */
  title?: string;
}

const styles = {
  overlay: css`
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
  `,
  modal: css`
    background: #fff;
    border-radius: 8px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
    min-width: 440px;
    max-width: 540px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 13px;
  `,
  header: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid #e0e0e0;
  `,
  title: css`
    font-size: 16px;
    font-weight: 600;
    color: #333;
    margin: 0;
  `,
  closeButton: css`
    background: none;
    border: none;
    font-size: 20px;
    color: #666;
    cursor: pointer;
    padding: 4px;
    line-height: 1;
    &:hover { color: #333; }
  `,
  content: css`
    padding: 20px;
  `,
  field: css`
    margin-bottom: 16px;
  `,
  label: css`
    display: block;
    font-weight: 500;
    color: #555;
    margin-bottom: 6px;
    font-size: 12px;
  `,
  input: css`
    width: 100%;
    padding: 8px 12px;
    border: 1px solid #d0d0d0;
    border-radius: 4px;
    font-size: 13px;
    color: #333;
    background: #fff;
    box-sizing: border-box;
    &:focus {
      outline: none;
      border-color: #0078d4;
      box-shadow: 0 0 0 2px rgba(0, 120, 212, 0.2);
    }
  `,
  formulaInput: css`
    width: 100%;
    padding: 8px 12px;
    border: 1px solid #d0d0d0;
    border-radius: 4px;
    font-size: 13px;
    font-family: "SF Mono", Consolas, monospace;
    color: #333;
    background: #fff;
    box-sizing: border-box;
    min-height: 60px;
    resize: vertical;
    &:focus {
      outline: none;
      border-color: #0078d4;
      box-shadow: 0 0 0 2px rgba(0, 120, 212, 0.2);
    }
  `,
  fieldList: css`
    border: 1px solid #e0e0e0;
    border-radius: 4px;
    max-height: 120px;
    overflow-y: auto;
    background: #fafafa;
  `,
  fieldItem: css`
    padding: 4px 10px;
    cursor: pointer;
    font-size: 12px;
    &:hover {
      background: #e8f0fe;
    }
  `,
  hint: css`
    color: #888;
    font-size: 11px;
    margin-top: 4px;
  `,
  error: css`
    color: #d32f2f;
    font-size: 11px;
    margin-top: 4px;
  `,
  footer: css`
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 16px 20px;
    border-top: 1px solid #e0e0e0;
    background: #f9f9f9;
    border-radius: 0 0 8px 8px;
  `,
  button: css`
    padding: 8px 16px;
    border-radius: 4px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
  `,
  cancelButton: css`
    background: #fff;
    border: 1px solid #d0d0d0;
    color: #333;
    &:hover { background: #f5f5f5; }
  `,
  saveButton: css`
    background: #0078d4;
    border: 1px solid #0078d4;
    color: #fff;
    &:hover { background: #106ebe; }
    &:disabled {
      background: #ccc;
      border-color: #ccc;
      cursor: default;
    }
  `,
};

export function CalculatedFieldDialog({
  isOpen,
  fieldNames,
  initialName = "",
  initialFormula = "",
  initialNumberFormat,
  onSave,
  onCancel,
  title = "Insert Calculated Field",
}: CalculatedFieldDialogProps): React.ReactElement | null {
  const nameRef = useRef<HTMLInputElement>(null);
  const formulaRef = useRef<HTMLTextAreaElement>(null);

  const [name, setName] = useState(initialName);
  const [formula, setFormula] = useState(initialFormula);
  const [error, setError] = useState("");

  useEffect(() => {
    if (isOpen) {
      setName(initialName);
      setFormula(initialFormula);
      setError("");
      setTimeout(() => nameRef.current?.focus(), 50);
    }
  }, [isOpen, initialName, initialFormula]);

  const handleInsertField = useCallback((fieldName: string) => {
    const textarea = formulaRef.current;
    if (!textarea) return;

    // Quote field names containing spaces
    const ref = fieldName.includes(" ") ? `'${fieldName}'` : fieldName;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const newFormula = formula.substring(0, start) + ref + formula.substring(end);
    setFormula(newFormula);

    // Restore cursor position after the inserted text
    setTimeout(() => {
      textarea.focus();
      const newPos = start + ref.length;
      textarea.setSelectionRange(newPos, newPos);
    }, 0);
  }, [formula]);

  const handleSave = useCallback(() => {
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    if (!formula.trim()) {
      setError("Formula is required");
      return;
    }
    setError("");
    onSave(name.trim(), formula.trim(), initialNumberFormat);
  }, [name, formula, initialNumberFormat, onSave]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "Escape") {
        onCancel();
      } else if (event.key === "Enter" && event.ctrlKey) {
        handleSave();
      }
    },
    [onCancel, handleSave]
  );

  if (!isOpen) return null;

  return createPortal(
    <div className={styles.overlay} onClick={onCancel}>
      <div
        className={styles.modal}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className={styles.header}>
          <h2 className={styles.title}>{title}</h2>
          <button className={styles.closeButton} onClick={onCancel}>
            &times;
          </button>
        </div>

        <div className={styles.content}>
          <div className={styles.field}>
            <label className={styles.label}>Name</label>
            <input
              ref={nameRef}
              type="text"
              className={styles.input}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Profit"
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label}>Formula</label>
            <textarea
              ref={formulaRef}
              className={styles.formulaInput}
              value={formula}
              onChange={(e) => setFormula(e.target.value)}
              placeholder="e.g., Revenue - Cost"
            />
            <div className={styles.hint}>
              Use field names in your formula. Click a field below to insert it.
              Use single quotes for names with spaces: 'Total Sales'.
            </div>
            {error && <div className={styles.error}>{error}</div>}
          </div>

          <div className={styles.field}>
            <label className={styles.label}>Fields</label>
            <div className={styles.fieldList}>
              {fieldNames.map((fn) => (
                <div
                  key={fn}
                  className={styles.fieldItem}
                  onClick={() => handleInsertField(fn)}
                >
                  {fn}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className={styles.footer}>
          <button
            className={`${styles.button} ${styles.cancelButton}`}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            className={`${styles.button} ${styles.saveButton}`}
            onClick={handleSave}
            disabled={!name.trim() || !formula.trim()}
          >
            OK
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
