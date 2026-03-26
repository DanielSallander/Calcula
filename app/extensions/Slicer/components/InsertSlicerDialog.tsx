//! FILENAME: app/extensions/Slicer/components/InsertSlicerDialog.tsx
// PURPOSE: Dialog for inserting slicers. Lists available Tables and PivotTables,
//          shows their fields as checkboxes, and creates one slicer per checked field.

import React, { useState, useEffect, useCallback } from "react";
import type { DialogProps } from "../../../src/api";
import { getSheets } from "../../../src/api";
import { invokeBackend, type Table, getAllPivotTables } from "../../../src/api/backend";
import { createSlicerAsync } from "../lib/slicerStore";
import type { SlicerSourceType } from "../lib/slicerTypes";

// ============================================================================
// Types
// ============================================================================

interface DataSource {
  type: SlicerSourceType;
  id: number;
  name: string;
  sheetIndex: number;
  fields: string[];
}

// ============================================================================
// Component
// ============================================================================

export function InsertSlicerDialog({
  isOpen,
  onClose,
  data,
}: DialogProps): React.ReactElement | null {
  // State
  const [sources, setSources] = useState<DataSource[]>([]);
  const [selectedSourceIndex, setSelectedSourceIndex] = useState<number>(-1);
  const [checkedFields, setCheckedFields] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingSources, setIsLoadingSources] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeSheetIndex, setActiveSheetIndex] = useState(0);

  // Pre-select a specific source if passed via dialog data
  const preselectedSourceType = data?.sourceType as SlicerSourceType | undefined;
  const preselectedSourceId = data?.sourceId as number | undefined;

  // Load available data sources when dialog opens
  useEffect(() => {
    if (isOpen) {
      setError(null);
      setCheckedFields(new Set());
      setSelectedSourceIndex(-1);
      loadDataSources();
    }
  }, [isOpen]);

  // Auto-select preselected source once sources are loaded
  useEffect(() => {
    if (
      sources.length > 0 &&
      preselectedSourceType &&
      preselectedSourceId !== undefined
    ) {
      const idx = sources.findIndex(
        (s) => s.type === preselectedSourceType && s.id === preselectedSourceId,
      );
      if (idx >= 0) {
        setSelectedSourceIndex(idx);
      }
    }
  }, [sources, preselectedSourceType, preselectedSourceId]);

  const loadDataSources = async () => {
    setIsLoadingSources(true);
    try {
      const sheetsResult = await getSheets();
      const currentSheetIndex = sheetsResult.activeIndex;
      setActiveSheetIndex(currentSheetIndex);

      const allSources: DataSource[] = [];

      // Fetch tables for the current sheet
      try {
        const tables = await invokeBackend<Table[]>("get_all_tables", {});
        for (const table of tables) {
          if (table.sheetIndex === currentSheetIndex) {
            allSources.push({
              type: "table",
              id: table.id,
              name: table.name,
              sheetIndex: table.sheetIndex,
              fields: table.columns.map((c) => c.name),
            });
          }
        }
      } catch (err) {
        console.warn("[InsertSlicerDialog] Failed to load tables:", err);
      }

      // Fetch pivot tables
      try {
        const pivots = await getAllPivotTables<
          Array<{
            id: number;
            name: string;
            sourceRange: string;
          }>
        >();
        for (const pv of pivots) {
          // Get pivot source fields via hierarchies
          try {
            const hierarchies = await invokeBackend<{
              hierarchies: Array<{ index: number; name: string }>;
            }>("get_pivot_hierarchies", { pivotId: pv.id });
            allSources.push({
              type: "pivot",
              id: pv.id,
              name: pv.name,
              sheetIndex: currentSheetIndex,
              fields: hierarchies.hierarchies.map((h) => h.name),
            });
          } catch (err) {
            console.warn(
              "[InsertSlicerDialog] Failed to load pivot fields for",
              pv.name,
              err,
            );
          }
        }
      } catch (err) {
        console.warn("[InsertSlicerDialog] Failed to load pivots:", err);
      }

      setSources(allSources);

      // If only one source, auto-select it
      if (allSources.length === 1) {
        setSelectedSourceIndex(0);
      }
    } catch (err) {
      console.error("[InsertSlicerDialog] Failed to load data sources:", err);
      setError("Failed to load data sources.");
    } finally {
      setIsLoadingSources(false);
    }
  };

  const selectedSource =
    selectedSourceIndex >= 0 ? sources[selectedSourceIndex] : null;

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

  const handleClose = useCallback(() => {
    setError(null);
    setIsLoading(false);
    onClose();
  }, [onClose]);

  const handleCreate = async () => {
    if (!selectedSource) {
      setError("Please select a data source.");
      return;
    }
    if (checkedFields.size === 0) {
      setError("Please select at least one field.");
      return;
    }

    setError(null);
    setIsLoading(true);

    try {
      const fieldNames = Array.from(checkedFields);
      const slicerWidth = 180;
      const slicerHeight = 240;
      const gap = 10;

      // Create one slicer per checked field, positioned side by side
      // Start at a reasonable position (100, 100 from sheet origin)
      let offsetX = 100;
      for (const fieldName of fieldNames) {
        const slicer = await createSlicerAsync({
          name: fieldName,
          sheetIndex: activeSheetIndex,
          x: offsetX,
          y: 100,
          width: slicerWidth,
          height: slicerHeight,
          sourceType: selectedSource.type,
          sourceId: selectedSource.id,
          fieldName,
        });

        if (!slicer) {
          throw new Error(`Failed to create slicer for field "${fieldName}".`);
        }

        offsetX += slicerWidth + gap;
      }

      handleClose();
    } catch (err) {
      console.error("[InsertSlicerDialog] Error creating slicers:", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      handleClose();
    } else if (e.key === "Enter" && !isLoading) {
      handleCreate();
    }
  };

  if (!isOpen) {
    return null;
  }

  return (
    <div style={styles.overlay} onClick={handleClose}>
      <div
        style={styles.dialog}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div style={styles.header}>
          <h2 style={styles.title}>Insert Slicers</h2>
          <button
            style={styles.closeButton}
            onClick={handleClose}
            aria-label="Close"
          >
            x
          </button>
        </div>

        {/* Content */}
        <div style={styles.content}>
          {isLoadingSources ? (
            <div style={styles.loadingText}>Loading data sources...</div>
          ) : sources.length === 0 ? (
            <div style={styles.emptyText}>
              No Tables or PivotTables found on the active sheet. Create a Table
              or PivotTable first, then insert a Slicer.
            </div>
          ) : (
            <>
              {/* Source selection */}
              <div style={styles.fieldGroup}>
                <label style={styles.label}>Data source:</label>
                <select
                  style={styles.select}
                  value={selectedSourceIndex}
                  onChange={(e) => {
                    setSelectedSourceIndex(Number(e.target.value));
                    setCheckedFields(new Set());
                  }}
                  disabled={isLoading}
                >
                  <option value={-1}>-- Select a source --</option>
                  {sources.map((source, i) => (
                    <option key={`${source.type}-${source.id}`} value={i}>
                      {source.name} ({source.type === "table" ? "Table" : "PivotTable"})
                    </option>
                  ))}
                </select>
              </div>

              {/* Field checkboxes */}
              {selectedSource && (
                <div style={styles.fieldGroup}>
                  <label style={styles.label}>
                    Select fields to create slicers for:
                  </label>
                  <div style={styles.fieldList}>
                    {selectedSource.fields.map((field) => (
                      <label key={field} style={styles.checkboxLabel}>
                        <input
                          type="checkbox"
                          checked={checkedFields.has(field)}
                          onChange={() => handleFieldToggle(field)}
                          disabled={isLoading}
                          style={styles.checkbox}
                        />
                        <span>{field}</span>
                      </label>
                    ))}
                    {selectedSource.fields.length === 0 && (
                      <div style={styles.emptyText}>
                        No fields available for this source.
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          )}

          {/* Error Message */}
          {error && <div style={styles.error}>{error}</div>}
        </div>

        {/* Footer */}
        <div style={styles.footer}>
          <button
            style={styles.cancelButton}
            onClick={handleClose}
            disabled={isLoading}
          >
            Cancel
          </button>
          <button
            style={{
              ...styles.okButton,
              ...(isLoading || !selectedSource || checkedFields.size === 0
                ? styles.buttonDisabled
                : {}),
            }}
            onClick={handleCreate}
            disabled={isLoading || !selectedSource || checkedFields.size === 0}
          >
            {isLoading ? "Creating..." : "OK"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Styles (matches existing dark theme dialogs)
// ============================================================================

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 10000,
  },
  dialog: {
    backgroundColor: "#2d2d2d",
    borderRadius: "8px",
    border: "1px solid #454545",
    boxShadow: "0 8px 32px rgba(0, 0, 0, 0.4)",
    width: "420px",
    maxWidth: "90vw",
    maxHeight: "90vh",
    display: "flex",
    flexDirection: "column",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "16px 20px",
    borderBottom: "1px solid #454545",
  },
  title: {
    margin: 0,
    fontSize: "16px",
    fontWeight: 600,
    color: "#ffffff",
  },
  closeButton: {
    background: "transparent",
    border: "none",
    color: "#888888",
    fontSize: "18px",
    cursor: "pointer",
    padding: "4px 8px",
    borderRadius: "4px",
    lineHeight: 1,
  },
  content: {
    padding: "20px",
    overflowY: "auto",
  },
  fieldGroup: {
    marginBottom: "20px",
  },
  label: {
    display: "block",
    fontSize: "13px",
    fontWeight: 500,
    color: "#cccccc",
    marginBottom: "8px",
  },
  select: {
    width: "100%",
    padding: "8px 12px",
    fontSize: "13px",
    backgroundColor: "#1e1e1e",
    border: "1px solid #454545",
    borderRadius: "4px",
    color: "#ffffff",
    outline: "none",
    boxSizing: "border-box" as const,
  },
  fieldList: {
    maxHeight: "240px",
    overflowY: "auto",
    border: "1px solid #454545",
    borderRadius: "4px",
    padding: "8px",
    backgroundColor: "#1e1e1e",
  },
  checkboxLabel: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    fontSize: "13px",
    color: "#cccccc",
    cursor: "pointer",
    padding: "4px 0",
  },
  checkbox: {
    margin: 0,
    cursor: "pointer",
  },
  loadingText: {
    fontSize: "13px",
    color: "#888888",
    textAlign: "center" as const,
    padding: "20px 0",
  },
  emptyText: {
    fontSize: "13px",
    color: "#888888",
    padding: "12px 0",
  },
  error: {
    padding: "10px 12px",
    backgroundColor: "rgba(220, 53, 69, 0.15)",
    border: "1px solid #dc3545",
    borderRadius: "4px",
    color: "#ff6b6b",
    fontSize: "13px",
  },
  footer: {
    display: "flex",
    justifyContent: "flex-end",
    gap: "8px",
    padding: "16px 20px",
    borderTop: "1px solid #454545",
  },
  cancelButton: {
    padding: "8px 16px",
    fontSize: "13px",
    backgroundColor: "transparent",
    border: "1px solid #454545",
    borderRadius: "4px",
    color: "#cccccc",
    cursor: "pointer",
  },
  okButton: {
    padding: "8px 20px",
    fontSize: "13px",
    backgroundColor: "#0e639c",
    border: "1px solid #0e639c",
    borderRadius: "4px",
    color: "#ffffff",
    cursor: "pointer",
    fontWeight: 500,
  },
  buttonDisabled: {
    opacity: 0.6,
    cursor: "not-allowed",
  },
};

export default InsertSlicerDialog;
