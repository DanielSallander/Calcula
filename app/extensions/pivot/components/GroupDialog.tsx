//! FILENAME: app/extensions/Pivot/components/GroupDialog.tsx
// PURPOSE: Dialog for configuring date grouping or number binning on a pivot field.
// CONTEXT: Opened from the pivot context menu "Group..." action.

import React, { useState, useEffect, useCallback } from "react";
import { css } from "@emotion/css";
import {
  groupPivotField,
  getPivotFieldUniqueValues,
  type DateGroupLevel,
  type FieldGroupingConfig,
} from "../lib/pivot-api";

// ============================================================================
// Types
// ============================================================================

export interface GroupDialogProps {
  isOpen: boolean;
  onClose: () => void;
  data?: Record<string, unknown>;
}

type GroupMode = "date" | "number";

const DATE_LEVELS: { value: DateGroupLevel; label: string }[] = [
  { value: "year", label: "Years" },
  { value: "quarter", label: "Quarters" },
  { value: "month", label: "Months" },
  { value: "week", label: "Weeks" },
  { value: "day", label: "Days" },
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
    min-width: 340px;
    max-width: 420px;
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
  tabs: css`
    display: flex;
    gap: 0;
    margin-bottom: 16px;
    border-bottom: 1px solid #e0e0e0;
  `,
  tab: css`
    padding: 8px 16px;
    border: none;
    background: none;
    cursor: pointer;
    font-size: 13px;
    color: #666;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    &:hover {
      color: #333;
    }
  `,
  tabActive: css`
    color: #0078d4;
    border-bottom-color: #0078d4;
    font-weight: 500;
  `,
  section: css`
    margin-bottom: 16px;
  `,
  label: css`
    display: block;
    font-weight: 500;
    color: #555;
    margin-bottom: 6px;
  `,
  checkboxList: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px 0;
  `,
  checkboxItem: css`
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    & input {
      margin: 0;
    }
    & span {
      color: #333;
    }
  `,
  input: css`
    width: 100%;
    padding: 6px 8px;
    border: 1px solid #ccc;
    border-radius: 4px;
    font-size: 13px;
    &:focus {
      outline: none;
      border-color: #0078d4;
    }
  `,
  row: css`
    display: flex;
    gap: 12px;
    align-items: center;
    margin-bottom: 8px;
    & label {
      min-width: 60px;
      color: #555;
      font-weight: 500;
    }
  `,
  footer: css`
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 20px;
    border-top: 1px solid #e0e0e0;
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

export function GroupDialog({ isOpen, onClose, data }: GroupDialogProps): React.ReactElement | null {
  const pivotId = data?.pivotId as number | undefined;
  const fieldIndex = data?.fieldIndex as number | undefined;

  const [mode, setMode] = useState<GroupMode>("date");
  const [fieldName, setFieldName] = useState("");

  // Date grouping state
  const [selectedLevels, setSelectedLevels] = useState<Set<DateGroupLevel>>(
    new Set(["month", "year"]),
  );

  // Number binning state
  const [binStart, setBinStart] = useState("0");
  const [binEnd, setBinEnd] = useState("100");
  const [binInterval, setBinInterval] = useState("10");

  // Detect field type on open
  useEffect(() => {
    if (!isOpen || pivotId === undefined || fieldIndex === undefined) return;

    getPivotFieldUniqueValues(pivotId, fieldIndex)
      .then((resp) => {
        setFieldName(resp.fieldName);
        // Heuristic: if most values look like dates, default to date mode
        const datePattern = /^\d{4}[-/]\d{1,2}[-/]\d{1,2}/;
        const dateCount = resp.uniqueValues.filter((v) => datePattern.test(v)).length;
        if (dateCount > resp.uniqueValues.length * 0.5) {
          setMode("date");
        } else {
          setMode("number");
          // Try to auto-detect range from values
          const nums = resp.uniqueValues
            .map((v) => parseFloat(v))
            .filter((n) => !isNaN(n));
          if (nums.length > 0) {
            const min = Math.floor(Math.min(...nums));
            const max = Math.ceil(Math.max(...nums));
            setBinStart(String(min));
            setBinEnd(String(max));
            const range = max - min;
            if (range > 0) {
              // Pick a reasonable interval (roughly 10 bins)
              const interval = Math.max(1, Math.round(range / 10));
              setBinInterval(String(interval));
            }
          }
        }
      })
      .catch((err) => {
        console.error("[GroupDialog] Failed to fetch field values:", err);
      });
  }, [isOpen, pivotId, fieldIndex]);

  const handleToggleLevel = useCallback((level: DateGroupLevel) => {
    setSelectedLevels((prev) => {
      const next = new Set(prev);
      if (next.has(level)) {
        // Don't allow removing the last level
        if (next.size > 1) next.delete(level);
      } else {
        next.add(level);
      }
      return next;
    });
  }, []);

  const handleApply = useCallback(async () => {
    if (pivotId === undefined || fieldIndex === undefined) return;

    let grouping: FieldGroupingConfig;
    if (mode === "date") {
      grouping = {
        type: "dateGrouping",
        levels: Array.from(selectedLevels),
      };
    } else {
      grouping = {
        type: "numberBinning",
        start: parseFloat(binStart) || 0,
        end: parseFloat(binEnd) || 100,
        interval: parseFloat(binInterval) || 10,
      };
    }

    try {
      await groupPivotField({ pivotId, fieldIndex, grouping });
      window.dispatchEvent(new Event("pivot:refresh"));
      onClose();
    } catch (err) {
      console.error("[GroupDialog] Failed to apply grouping:", err);
    }
  }, [pivotId, fieldIndex, mode, selectedLevels, binStart, binEnd, binInterval, onClose]);

  if (!isOpen) return null;

  const isValid =
    mode === "date"
      ? selectedLevels.size > 0
      : !isNaN(parseFloat(binStart)) &&
        !isNaN(parseFloat(binEnd)) &&
        !isNaN(parseFloat(binInterval)) &&
        parseFloat(binInterval) > 0;

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className={styles.header}>
          <h3 className={styles.title}>
            Grouping{fieldName ? ` - ${fieldName}` : ""}
          </h3>
          <button className={styles.closeButton} onClick={onClose}>
            x
          </button>
        </div>

        {/* Tabs */}
        <div className={styles.content}>
          <div className={styles.tabs}>
            <button
              className={`${styles.tab} ${mode === "date" ? styles.tabActive : ""}`}
              onClick={() => setMode("date")}
            >
              Date
            </button>
            <button
              className={`${styles.tab} ${mode === "number" ? styles.tabActive : ""}`}
              onClick={() => setMode("number")}
            >
              Number
            </button>
          </div>

          {/* Date Grouping */}
          {mode === "date" && (
            <div className={styles.section}>
              <span className={styles.label}>Group by:</span>
              <div className={styles.checkboxList}>
                {DATE_LEVELS.map(({ value, label }) => (
                  <label key={value} className={styles.checkboxItem}>
                    <input
                      type="checkbox"
                      checked={selectedLevels.has(value)}
                      onChange={() => handleToggleLevel(value)}
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* Number Binning */}
          {mode === "number" && (
            <div className={styles.section}>
              <div className={styles.row}>
                <label>Starting at:</label>
                <input
                  className={styles.input}
                  type="number"
                  value={binStart}
                  onChange={(e) => setBinStart(e.target.value)}
                />
              </div>
              <div className={styles.row}>
                <label>Ending at:</label>
                <input
                  className={styles.input}
                  type="number"
                  value={binEnd}
                  onChange={(e) => setBinEnd(e.target.value)}
                />
              </div>
              <div className={styles.row}>
                <label>By:</label>
                <input
                  className={styles.input}
                  type="number"
                  value={binInterval}
                  onChange={(e) => setBinInterval(e.target.value)}
                  min="1"
                />
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className={styles.footer}>
          <button className={styles.button} onClick={onClose}>
            Cancel
          </button>
          <button
            className={styles.primaryButton}
            onClick={handleApply}
            disabled={!isValid}
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
