//! FILENAME: app/extensions/TimelineSlicer/components/InsertTimelineDialog.tsx
// PURPOSE: Dialog for inserting timeline slicers. Lists available PivotTables
//          and their date fields, and creates one timeline per checked field.

import React, { useState, useEffect } from "react";
import { css } from "@emotion/css";
import type { DialogProps } from "../../../src/api";
import { getSheets } from "../../../src/api";
import { getAllPivotTables } from "../../../src/api/backend";
import { getPivotDateFields } from "../lib/timeline-slicer-api";
import { createTimelineAsync } from "../lib/timelineSlicerStore";

// ============================================================================
// Types
// ============================================================================

interface PivotSource {
  id: number;
  name: string;
  sheetIndex: number;
  dateFields: string[];
}

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
    z-index: 10000;
  `,
  dialog: css`
    background: #fff;
    border-radius: 8px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.18);
    width: 420px;
    max-height: 500px;
    display: flex;
    flex-direction: column;
    font-family: "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
    font-size: 13px;
  `,
  header: css`
    padding: 16px 20px 12px;
    font-size: 15px;
    font-weight: 600;
    border-bottom: 1px solid #e8e8e8;
  `,
  body: css`
    flex: 1;
    overflow-y: auto;
    padding: 12px 20px;
  `,
  sourceLabel: css`
    font-weight: 600;
    margin-bottom: 6px;
    color: #333;
  `,
  sourceSelect: css`
    width: 100%;
    padding: 6px 8px;
    border: 1px solid #ccc;
    border-radius: 4px;
    font-size: 13px;
    margin-bottom: 12px;
  `,
  fieldList: css`
    display: flex;
    flex-direction: column;
    gap: 6px;
  `,
  fieldItem: css`
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 0;

    label {
      cursor: pointer;
      user-select: none;
    }
  `,
  noFields: css`
    color: #999;
    font-style: italic;
    padding: 12px 0;
  `,
  footer: css`
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 20px;
    border-top: 1px solid #e8e8e8;
  `,
  button: css`
    padding: 6px 20px;
    border: 1px solid #ccc;
    border-radius: 4px;
    background: #f5f5f5;
    font-size: 13px;
    cursor: pointer;

    &:hover {
      background: #e8e8e8;
    }
  `,
  buttonPrimary: css`
    padding: 6px 20px;
    border: 1px solid #4472c4;
    border-radius: 4px;
    background: #4472c4;
    color: #fff;
    font-size: 13px;
    cursor: pointer;

    &:hover {
      background: #3a63a8;
    }

    &:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  `,
  error: css`
    color: #c42b1c;
    font-size: 12px;
    margin-top: 8px;
  `,
  loading: css`
    color: #666;
    font-style: italic;
    padding: 12px 0;
  `,
};

// ============================================================================
// Component
// ============================================================================

export function InsertTimelineDialog({
  isOpen,
  onClose,
  data,
}: DialogProps): React.ReactElement | null {
  const [sources, setSources] = useState<PivotSource[]>([]);
  const [selectedSourceIndex, setSelectedSourceIndex] = useState<number>(-1);
  const [checkedFields, setCheckedFields] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingSources, setIsLoadingSources] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeSheetIndex, setActiveSheetIndex] = useState(0);

  const preselectedSourceId = data?.sourceId as number | undefined;

  useEffect(() => {
    if (isOpen) {
      setError(null);
      setCheckedFields(new Set());
      setSelectedSourceIndex(-1);
      loadDataSources();
    }
  }, [isOpen]);

  // Auto-select preselected source
  useEffect(() => {
    if (sources.length > 0 && preselectedSourceId !== undefined) {
      const idx = sources.findIndex((s) => s.id === preselectedSourceId);
      if (idx >= 0) {
        setSelectedSourceIndex(idx);
      }
    }
  }, [sources, preselectedSourceId]);

  const loadDataSources = async () => {
    setIsLoadingSources(true);
    try {
      const sheetsResult = await getSheets();
      setActiveSheetIndex(sheetsResult.activeIndex);

      const pivots = await getAllPivotTables();
      const pivotSources: PivotSource[] = [];

      for (const p of pivots) {
        try {
          const dateFields = await getPivotDateFields(p.id);
          if (dateFields.length > 0) {
            pivotSources.push({
              id: p.id,
              name: p.name || `PivotTable${p.id}`,
              sheetIndex: p.sheetIndex,
              dateFields,
            });
          }
        } catch {
          // Skip pivots without date fields
        }
      }

      setSources(pivotSources);

      if (pivotSources.length === 0) {
        setError("No PivotTables with date fields found.");
      }
    } catch (err) {
      setError("Failed to load data sources.");
      console.error("[TimelineSlicer] Load sources error:", err);
    } finally {
      setIsLoadingSources(false);
    }
  };

  const handleFieldToggle = (fieldName: string) => {
    setCheckedFields((prev) => {
      const next = new Set(prev);
      if (next.has(fieldName)) {
        next.delete(fieldName);
      } else {
        next.add(fieldName);
      }
      return next;
    });
  };

  const handleInsert = async () => {
    if (selectedSourceIndex < 0 || checkedFields.size === 0) return;

    const source = sources[selectedSourceIndex];
    setIsLoading(true);
    setError(null);

    try {
      let offsetY = 0;
      for (const fieldName of checkedFields) {
        await createTimelineAsync({
          name: fieldName,
          sheetIndex: activeSheetIndex,
          x: 20,
          y: 20 + offsetY,
          sourceId: source.id,
          fieldName,
        });
        offsetY += 120;
      }
      onClose();
    } catch (err) {
      setError("Failed to create timeline slicer.");
      console.error("[TimelineSlicer] Insert error:", err);
    } finally {
      setIsLoading(false);
    }
  };

  if (!isOpen) return null;

  const selectedSource =
    selectedSourceIndex >= 0 ? sources[selectedSourceIndex] : null;

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>Insert Timeline</div>

        <div className={styles.body}>
          {isLoadingSources ? (
            <div className={styles.loading}>Loading data sources...</div>
          ) : sources.length === 0 ? (
            <div className={styles.noFields}>
              {error || "No PivotTables with date fields found."}
            </div>
          ) : (
            <>
              <div className={styles.sourceLabel}>PivotTable:</div>
              <select
                className={styles.sourceSelect}
                value={selectedSourceIndex}
                onChange={(e) => {
                  setSelectedSourceIndex(Number(e.target.value));
                  setCheckedFields(new Set());
                }}
              >
                <option value={-1}>-- Select --</option>
                {sources.map((s, i) => (
                  <option key={s.id} value={i}>
                    {s.name}
                  </option>
                ))}
              </select>

              {selectedSource && (
                <>
                  <div className={styles.sourceLabel}>Date Fields:</div>
                  <div className={styles.fieldList}>
                    {selectedSource.dateFields.map((field) => (
                      <div key={field} className={styles.fieldItem}>
                        <input
                          type="checkbox"
                          id={`timeline-field-${field}`}
                          checked={checkedFields.has(field)}
                          onChange={() => handleFieldToggle(field)}
                        />
                        <label htmlFor={`timeline-field-${field}`}>
                          {field}
                        </label>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )}

          {error && <div className={styles.error}>{error}</div>}
        </div>

        <div className={styles.footer}>
          <button className={styles.button} onClick={onClose}>
            Cancel
          </button>
          <button
            className={styles.buttonPrimary}
            disabled={
              isLoading || selectedSourceIndex < 0 || checkedFields.size === 0
            }
            onClick={handleInsert}
          >
            {isLoading ? "Inserting..." : "OK"}
          </button>
        </div>
      </div>
    </div>
  );
}
