//! FILENAME: app/extensions/Table/components/RemoveDuplicatesDialog.tsx
// PURPOSE: Dialog for removing duplicate rows from a table.
// CONTEXT: Shows column checkboxes so users pick which columns to compare.

import React, { useState, useCallback } from "react";
import { css } from "@emotion/css";
import type { DialogProps } from "@api";
import { removeDuplicates } from "@api/backend";
import { emitAppEvent, AppEvents } from "@api";
import { refreshCache } from "../lib/tableStore";
import { TableEvents } from "../lib/tableEvents";
import type { Table } from "@api/backend";

// ============================================================================
// Styles
// ============================================================================

const styles = {
  overlay: css`
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 2000;
  `,
  dialog: css`
    background: #fff;
    border-radius: 6px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
    width: 340px;
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    font-family: "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
    font-size: 12px;
    color: #1a1a1a;
  `,
  header: css`
    padding: 14px 16px 10px;
    font-size: 14px;
    font-weight: 600;
    border-bottom: 1px solid #e0e0e0;
  `,
  body: css`
    padding: 12px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    overflow-y: auto;
  `,
  sectionLabel: css`
    font-weight: 600;
    font-size: 11px;
    color: #555;
    text-transform: uppercase;
    letter-spacing: 0.3px;
  `,
  columnList: css`
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 200px;
    overflow-y: auto;
    border: 1px solid #e0e0e0;
    border-radius: 4px;
    padding: 6px 8px;
  `,
  checkboxLabel: css`
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    padding: 2px 0;
    font-size: 12px;

    input {
      cursor: pointer;
    }
  `,
  selectButtons: css`
    display: flex;
    gap: 8px;
  `,
  linkButton: css`
    background: none;
    border: none;
    color: #005fb8;
    cursor: pointer;
    font-size: 11px;
    font-family: inherit;
    padding: 0;
    text-decoration: underline;

    &:hover {
      color: #004080;
    }
  `,
  footer: css`
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 10px 16px 14px;
    border-top: 1px solid #e0e0e0;
  `,
  button: css`
    padding: 6px 16px;
    border: 1px solid #d0d0d0;
    border-radius: 4px;
    background: #fff;
    font-size: 12px;
    font-family: inherit;
    cursor: pointer;
    color: #333;

    &:hover {
      background: #f0f0f0;
    }
  `,
  primaryButton: css`
    padding: 6px 16px;
    border: 1px solid #005fb8;
    border-radius: 4px;
    background: #005fb8;
    color: #fff;
    font-size: 12px;
    font-family: inherit;
    cursor: pointer;

    &:hover {
      background: #004c99;
    }

    &:disabled {
      opacity: 0.5;
      cursor: default;
    }
  `,
  resultMessage: css`
    padding: 10px 12px;
    background: #f0f8f0;
    border: 1px solid #c0dcc0;
    border-radius: 4px;
    font-size: 12px;
    color: #1a5c1a;
    line-height: 1.5;
  `,
  errorMessage: css`
    padding: 10px 12px;
    background: #fdf0f0;
    border: 1px solid #dcc0c0;
    border-radius: 4px;
    font-size: 12px;
    color: #c42b1c;
    line-height: 1.5;
  `,
};

// ============================================================================
// Component
// ============================================================================

export function RemoveDuplicatesDialog(props: DialogProps): React.ReactElement | null {
  const { isOpen, onClose, data } = props;
  const table = data?.table as Table | undefined;

  const columns = table?.columns ?? [];
  const [selected, setSelected] = useState<boolean[]>(() => columns.map(() => true));
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ removed: number; remaining: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggleColumn = useCallback((index: number) => {
    setSelected((prev) => {
      const next = [...prev];
      next[index] = !next[index];
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelected(columns.map(() => true));
  }, [columns]);

  const unselectAll = useCallback(() => {
    setSelected(columns.map(() => false));
  }, [columns]);

  const hasSelection = selected.some(Boolean);

  const handleRemove = useCallback(async () => {
    if (!table || !hasSelection) return;

    const keyColumns = selected
      .map((checked, i) => (checked ? table.startCol + i : -1))
      .filter((c) => c >= 0);

    setRunning(true);
    setResult(null);
    setError(null);

    try {
      const res = await removeDuplicates(
        table.startRow,
        table.startCol,
        table.endRow,
        table.endCol,
        keyColumns,
        table.styleOptions.headerRow,
      );

      if (res.success) {
        setResult({ removed: res.duplicatesRemoved, remaining: res.uniqueRemaining });
        // Refresh table cache and grid
        await refreshCache();
        emitAppEvent(TableEvents.TABLE_DEFINITIONS_UPDATED);
        emitAppEvent(AppEvents.GRID_DATA_REFRESH);
      } else {
        setError(res.error ?? "Failed to remove duplicates.");
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setRunning(false);
    }
  }, [table, selected, hasSelection]);

  if (!isOpen || !table) return null;

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>Remove Duplicates</div>
        <div className={styles.body}>
          {result ? (
            <div className={styles.resultMessage}>
              {result.removed === 0
                ? "No duplicate values were found."
                : `${result.removed} duplicate row${result.removed !== 1 ? "s" : ""} removed. ${result.remaining} unique row${result.remaining !== 1 ? "s" : ""} remaining.`}
            </div>
          ) : error ? (
            <div className={styles.errorMessage}>{error}</div>
          ) : (
            <>
              <div>
                Select the columns that contain duplicates:
              </div>
              <div className={styles.selectButtons}>
                <button className={styles.linkButton} onClick={selectAll}>Select All</button>
                <button className={styles.linkButton} onClick={unselectAll}>Unselect All</button>
              </div>
              <div className={styles.columnList}>
                {columns.map((col, i) => (
                  <label key={col.id} className={styles.checkboxLabel}>
                    <input
                      type="checkbox"
                      checked={selected[i] ?? false}
                      onChange={() => toggleColumn(i)}
                    />
                    {col.name}
                  </label>
                ))}
              </div>
            </>
          )}
        </div>
        <div className={styles.footer}>
          {result || error ? (
            <button className={styles.primaryButton} onClick={onClose}>
              OK
            </button>
          ) : (
            <>
              <button className={styles.button} onClick={onClose}>
                Cancel
              </button>
              <button
                className={styles.primaryButton}
                onClick={handleRemove}
                disabled={!hasSelection || running}
              >
                {running ? "Removing..." : "Remove Duplicates"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
