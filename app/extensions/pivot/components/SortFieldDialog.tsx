//! FILENAME: app/extensions/Pivot/components/SortFieldDialog.tsx
// PURPOSE: Excel's "Sort (<field>)" dialog -- a row or column field's More
//          Sort Options (BUG-0733): Ascending (A to Z) or Descending (Z to A)
//          by the field's own labels or by one of the PivotTable's value
//          fields, along the other axis's Grand Total (Excel's default "Sort
//          by: Grand Total"). A value sort is Excel's
//          `PivotField.AutoSort(order, "Sum of Amount")`; a grouped field's
//          item sorts the field it was grouped from (the backend maps it).
// CONTEXT: Opened from the pivot context menu Sort > More Sort Options... on a
//          row or column item, on the field's CURRENT sort (its direction and
//          by-field, as Excel's dialog opens on AutoSortOrder / AutoSortField).
//          Excel's Manual option keeps the order the items have now; they are
//          then moved with the item menu's Move (the backend stores the order).
//          Excel's More Options ("Sort automatically every time the report is
//          updated") is not offered: Calcula always re-sorts, Excel's default.

import React, { useState, useCallback } from "react";
import { css } from "@emotion/css";
import { useDialogWindow } from "@api/dialogWindow";
import { sortPivotField } from "../lib/pivot-api";

export interface SortFieldDialogProps {
  isOpen: boolean;
  onClose: () => void;
  data?: Record<string, unknown>;
}

/** What the dialog is opened with (the menu reads it from the clicked item). */
export interface SortFieldDialogData {
  pivotId: string;
  /** The clicked item's field (a grouped field's virtual index is fine). */
  fieldIndex: number;
  fieldName: string;
  /** The PivotTable's value fields, by name (`valueFieldNames`). */
  valueFieldNames: string[];
  /** The field's current sort, which the dialog opens on. */
  currentOrder?: SortDirection | "manual";
  /** The value field the field is sorted by now, when sorted by value. */
  currentBy?: string;
}

export type SortDirection = "ascending" | "descending";

/**
 * The sort request the dialog sends: `by` is the field's own name (a label
 * sort, which also clears a value sort) or a value field's name (a value
 * sort along the other axis's Grand Total).
 */
export function sortRequestOf(
  data: SortFieldDialogData,
  direction: SortDirection | "manual",
  by: string,
): { pivotId: string; fieldIndex: number; sortBy: SortDirection | "manual"; valuesHierarchy?: string; pivotItemScope?: string[] } {
  const base = { pivotId: data.pivotId, fieldIndex: data.fieldIndex, sortBy: direction };
  if (direction === "manual" || by === data.fieldName || !data.valueFieldNames.includes(by)) return base;
  return { ...base, valuesHierarchy: by, pivotItemScope: [] };
}

/** Excel's summary line under the options. */
export function sortSummary(fieldName: string, direction: SortDirection | "manual", by: string): string {
  if (direction === "manual") return `Drag items of the ${fieldName} field to show them in any order`;
  const order = direction === "ascending" ? "ascending" : "descending";
  return `Sort ${fieldName} by ${by} in ${order} order`;
}

const styles = {
  overlay: css`
    position: fixed;
    inset: 0;
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
    max-width: 440px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 13px;
  `,
  header: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 20px;
    border-bottom: 1px solid #e0e0e0;
    cursor: move;
  `,
  title: css`
    font-size: 15px;
    font-weight: 600;
    color: #333;
    margin: 0;
  `,
  closeButton: css`
    background: none;
    border: none;
    font-size: 18px;
    color: #666;
    cursor: pointer;
    padding: 4px;
    line-height: 1;
  `,
  content: css`
    padding: 16px 20px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  `,
  groupLabel: css`
    font-weight: 600;
    color: #444;
  `,
  option: css`
    display: flex;
    align-items: center;
    gap: 8px;
    color: #333;
    & input {
      margin: 0;
    }
  `,
  disabled: css`
    color: #999;
  `,
  byRow: css`
    padding-left: 24px;
  `,
  select: css`
    width: 100%;
    padding: 4px 6px;
    border: 1px solid #ccc;
    border-radius: 4px;
    font-size: 13px;
  `,
  summary: css`
    border: 1px solid #e0e0e0;
    border-radius: 4px;
    padding: 8px 10px;
    color: #444;
    background: #fafafa;
  `,
  error: css`
    color: #b00020;
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
  `,
  primaryButton: css`
    padding: 6px 20px;
    border-radius: 4px;
    font-size: 13px;
    cursor: pointer;
    border: 1px solid #0078d4;
    background: #0078d4;
    color: #fff;
    &:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  `,
};

function readData(data: Record<string, unknown> | undefined): SortFieldDialogData | null {
  const pivotId = data?.pivotId;
  const fieldIndex = data?.fieldIndex;
  if (typeof pivotId !== "string" || typeof fieldIndex !== "number") return null;
  const fieldName = typeof data?.fieldName === "string" && data.fieldName !== "" ? data.fieldName : "Field";
  const names = Array.isArray(data?.valueFieldNames)
    ? (data!.valueFieldNames as unknown[]).filter((n): n is string => typeof n === "string" && n !== "")
    : [];
  const order = data?.currentOrder;
  const currentOrder = order === "ascending" || order === "descending" || order === "manual" ? order : undefined;
  const currentBy = typeof data?.currentBy === "string" && names.includes(data.currentBy) ? data.currentBy : undefined;
  return { pivotId, fieldIndex, fieldName, valueFieldNames: names, currentOrder, currentBy };
}

export function SortFieldDialog({ isOpen, onClose, data }: SortFieldDialogProps): React.ReactElement | null {
  const target = readData(data);
  const win = useDialogWindow({ minWidth: 320, minHeight: 280 });
  // Opened on the field's current sort (Excel's AutoSortOrder / Field).
  const [direction, setDirection] = useState<SortDirection | "manual">(target?.currentOrder ?? "ascending");
  const [ascendingBy, setAscendingBy] = useState<string | null>(
    target?.currentOrder === "ascending" ? (target.currentBy ?? null) : null,
  );
  const [descendingBy, setDescendingBy] = useState<string | null>(
    target?.currentOrder === "descending" ? (target.currentBy ?? null) : null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fieldName = target?.fieldName ?? "Field";
  const byChoices = target ? [target.fieldName, ...target.valueFieldNames.filter((n) => n !== target.fieldName)] : [];
  const ascBy = ascendingBy ?? fieldName;
  const descBy = descendingBy ?? fieldName;
  const by = direction === "ascending" ? ascBy : descBy;

  const handleOk = useCallback(async () => {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      await sortPivotField(sortRequestOf(target, direction, by));
      window.dispatchEvent(new Event("pivot:refresh"));
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [target, direction, by, onClose]);

  if (!isOpen || !target) return null;

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div
        ref={win.ref}
        className={styles.modal}
        onClick={(e) => e.stopPropagation()}
        style={{ position: "relative", ...win.style }}
        role="dialog"
        aria-label={`Sort (${fieldName})`}
      >
        <div className={styles.header} onMouseDown={win.onHeaderMouseDown}>
          <h3 className={styles.title}>Sort ({fieldName})</h3>
          <button className={styles.closeButton} onClick={onClose} aria-label="Close">
            x
          </button>
        </div>
        <div className={styles.content}>
          <span className={styles.groupLabel}>Sort options</span>
          <label className={styles.option}>
            <input
              type="radio"
              name="pivot-sort-direction"
              checked={direction === "manual"}
              onChange={() => setDirection("manual")}
            />
            <span>Manual (you can drag items to rearrange them)</span>
          </label>
          <label className={styles.option}>
            <input
              type="radio"
              name="pivot-sort-direction"
              checked={direction === "ascending"}
              onChange={() => setDirection("ascending")}
            />
            <span>Ascending (A to Z) by:</span>
          </label>
          <div className={styles.byRow}>
            <select
              className={styles.select}
              aria-label="Ascending by"
              value={ascBy}
              disabled={direction !== "ascending"}
              onChange={(e) => setAscendingBy(e.target.value)}
            >
              {byChoices.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <label className={styles.option}>
            <input
              type="radio"
              name="pivot-sort-direction"
              checked={direction === "descending"}
              onChange={() => setDirection("descending")}
            />
            <span>Descending (Z to A) by:</span>
          </label>
          <div className={styles.byRow}>
            <select
              className={styles.select}
              aria-label="Descending by"
              value={descBy}
              disabled={direction !== "descending"}
              onChange={(e) => setDescendingBy(e.target.value)}
            >
              {byChoices.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <span className={styles.groupLabel}>Summary</span>
          <div className={styles.summary}>{sortSummary(fieldName, direction, by)}</div>
          {error ? <div className={styles.error}>{error}</div> : null}
        </div>
        <div className={styles.footer}>
          <button className={styles.button} onClick={onClose}>
            Cancel
          </button>
          <button className={styles.primaryButton} onClick={() => void handleOk()} disabled={busy}>
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
