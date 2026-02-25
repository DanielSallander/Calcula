//! FILENAME: app/extensions/Pivot/components/FieldSettingsDialog.tsx
// PURPOSE: Dialog for configuring row/column field settings (custom name, subtotals).
// CONTEXT: Opened from the pivot context menu "Field Settings..." action.

import React, { useState, useEffect, useCallback, useRef } from "react";
import { css } from "@emotion/css";
import {
  getPivotFieldInfo,
  updatePivotFields,
  type PivotFieldInfoResponse,
  type Subtotals,
} from "../lib/pivot-api";

// ============================================================================
// Types
// ============================================================================

export interface FieldSettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  data?: Record<string, unknown>;
}

type SubtotalMode = "automatic" | "custom" | "none";

interface SubtotalOption {
  key: keyof Subtotals;
  label: string;
}

const SUBTOTAL_OPTIONS: SubtotalOption[] = [
  { key: "sum", label: "Sum" },
  { key: "count", label: "Count" },
  { key: "average", label: "Average" },
  { key: "max", label: "Max" },
  { key: "min", label: "Min" },
  { key: "product", label: "Product" },
  { key: "countNumbers", label: "Count Numbers" },
  { key: "standardDeviation", label: "StdDev" },
  { key: "standardDeviationP", label: "StdDevp" },
  { key: "variance", label: "Var" },
  { key: "varianceP", label: "Varp" },
];

// ============================================================================
// Styles
// ============================================================================

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
    min-width: 380px;
    max-width: 460px;
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
    &:hover {
      color: #333;
    }
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
    box-sizing: border-box;
    &:focus {
      outline: none;
      border-color: #0078d4;
      box-shadow: 0 0 0 2px rgba(0, 120, 212, 0.2);
    }
  `,
  sourceInfo: css`
    color: #888;
    font-size: 11px;
    margin-top: 4px;
  `,
  radioGroup: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 4px 0;
  `,
  radioItem: css`
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    & input {
      margin: 0;
    }
    & span {
      color: #333;
      font-size: 13px;
    }
  `,
  checkboxList: css`
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
    padding: 8px 0 4px 20px;
  `,
  checkboxItem: css`
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    & input {
      margin: 0;
    }
    & span {
      color: #333;
      font-size: 12px;
    }
  `,
  footer: css`
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 20px;
    border-top: 1px solid #e0e0e0;
    background: #f9f9f9;
    border-radius: 0 0 8px 8px;
  `,
  button: css`
    padding: 6px 20px;
    border-radius: 4px;
    font-size: 13px;
    cursor: pointer;
    border: 1px solid #ccc;
    background: #fff;
    color: #333;
    &:hover {
      background: #f5f5f5;
    }
  `,
  primaryButton: css`
    padding: 6px 20px;
    border-radius: 4px;
    font-size: 13px;
    cursor: pointer;
    border: 1px solid #0078d4;
    background: #0078d4;
    color: #fff;
    &:hover {
      background: #006cbd;
    }
    &:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  `,
};

// ============================================================================
// Component
// ============================================================================

export function FieldSettingsDialog({
  isOpen,
  onClose,
  data,
}: FieldSettingsDialogProps): React.ReactElement | null {
  const pivotId = data?.pivotId as number | undefined;
  const fieldIndex = data?.fieldIndex as number | undefined;
  const axis = data?.axis as "row" | "column" | "filter" | undefined;

  const inputRef = useRef<HTMLInputElement>(null);

  const [customName, setCustomName] = useState("");
  const [sourceName, setSourceName] = useState("");
  const [subtotalMode, setSubtotalMode] = useState<SubtotalMode>("automatic");
  const [customSubtotals, setCustomSubtotals] = useState<Set<keyof Subtotals>>(new Set());
  const [loading, setLoading] = useState(false);

  // Load field info when dialog opens
  useEffect(() => {
    if (!isOpen || pivotId === undefined || fieldIndex === undefined) return;

    setLoading(true);
    getPivotFieldInfo(pivotId, fieldIndex)
      .then((info: PivotFieldInfoResponse) => {
        setSourceName(info.name);
        setCustomName(info.name);

        // Determine subtotal mode from current config
        const subs = info.subtotals;
        if (subs.automatic !== false) {
          setSubtotalMode("automatic");
        } else {
          // Check if any specific subtotal is enabled
          const hasCustom = SUBTOTAL_OPTIONS.some(
            (opt) => subs[opt.key] === true,
          );
          if (hasCustom) {
            setSubtotalMode("custom");
            const enabled = new Set<keyof Subtotals>();
            for (const opt of SUBTOTAL_OPTIONS) {
              if (subs[opt.key] === true) enabled.add(opt.key);
            }
            setCustomSubtotals(enabled);
          } else {
            setSubtotalMode("none");
          }
        }
        setLoading(false);
      })
      .catch((err) => {
        console.error("[FieldSettingsDialog] Failed to load field info:", err);
        setLoading(false);
      });
  }, [isOpen, pivotId, fieldIndex]);

  // Focus input when dialog opens
  useEffect(() => {
    if (isOpen && !loading) {
      setTimeout(() => inputRef.current?.select(), 50);
    }
  }, [isOpen, loading]);

  const handleToggleCustomSubtotal = useCallback((key: keyof Subtotals) => {
    setCustomSubtotals((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const handleSave = useCallback(async () => {
    if (pivotId === undefined || fieldIndex === undefined || !axis) return;

    try {
      // Build field config for the update
      const showSubtotals = subtotalMode !== "none";

      const fieldConfig = {
        sourceIndex: fieldIndex,
        name: customName || sourceName,
        showSubtotals,
      };

      const updateRequest =
        axis === "row"
          ? { pivotId, rowFields: [fieldConfig] }
          : axis === "column"
            ? { pivotId, columnFields: [fieldConfig] }
            : { pivotId, filterFields: [fieldConfig] };

      await updatePivotFields(updateRequest);
      window.dispatchEvent(new Event("pivot:refresh"));
      onClose();
    } catch (err) {
      console.error("[FieldSettingsDialog] Failed to save field settings:", err);
    }
  }, [pivotId, fieldIndex, axis, customName, sourceName, subtotalMode, onClose]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "Enter" && !e.shiftKey) {
        handleSave();
      }
    },
    [onClose, handleSave],
  );

  if (!isOpen) return null;

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div
        className={styles.modal}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className={styles.header}>
          <h3 className={styles.title}>Field Settings</h3>
          <button className={styles.closeButton} onClick={onClose}>
            x
          </button>
        </div>

        {/* Content */}
        <div className={styles.content}>
          {loading ? (
            <div style={{ padding: "20px 0", textAlign: "center", color: "#888" }}>
              Loading...
            </div>
          ) : (
            <>
              {/* Source Name */}
              <div className={styles.field}>
                <label className={styles.label}>Source Name</label>
                <div className={styles.sourceInfo}>{sourceName}</div>
              </div>

              {/* Custom Name */}
              <div className={styles.field}>
                <label className={styles.label}>Custom Name</label>
                <input
                  ref={inputRef}
                  type="text"
                  className={styles.input}
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  placeholder={sourceName}
                />
              </div>

              {/* Subtotals */}
              <div className={styles.field}>
                <label className={styles.label}>Subtotals</label>
                <div className={styles.radioGroup}>
                  <label className={styles.radioItem}>
                    <input
                      type="radio"
                      name="subtotalMode"
                      checked={subtotalMode === "automatic"}
                      onChange={() => setSubtotalMode("automatic")}
                    />
                    <span>Automatic</span>
                  </label>
                  <label className={styles.radioItem}>
                    <input
                      type="radio"
                      name="subtotalMode"
                      checked={subtotalMode === "none"}
                      onChange={() => setSubtotalMode("none")}
                    />
                    <span>None</span>
                  </label>
                  <label className={styles.radioItem}>
                    <input
                      type="radio"
                      name="subtotalMode"
                      checked={subtotalMode === "custom"}
                      onChange={() => setSubtotalMode("custom")}
                    />
                    <span>Custom</span>
                  </label>
                </div>

                {subtotalMode === "custom" && (
                  <div className={styles.checkboxList}>
                    {SUBTOTAL_OPTIONS.map(({ key, label }) => (
                      <label key={key} className={styles.checkboxItem}>
                        <input
                          type="checkbox"
                          checked={customSubtotals.has(key)}
                          onChange={() => handleToggleCustomSubtotal(key)}
                        />
                        <span>{label}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className={styles.footer}>
          <button className={styles.button} onClick={onClose}>
            Cancel
          </button>
          <button
            className={styles.primaryButton}
            onClick={handleSave}
            disabled={loading}
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
