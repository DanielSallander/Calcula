//! FILENAME: app/extensions/Slicer/components/InsertSlicerDialog.tsx
// PURPOSE: Dialog for inserting slicers. Lists available Tables and PivotTables,
//          shows their fields as checkboxes, and creates one slicer per checked field.

import React, { useState, useEffect, useCallback } from "react";
import type { DialogProps } from "@api";
import { getSheets } from "@api";
import {
  invokeBackend,
  type Table,
  getAllPivotTables,
  updateBiPivotFields,
} from "@api/backend";
import { createSlicerAsync } from "../lib/slicerStore";
import type { SlicerSourceType } from "../lib/slicerTypes";

// ============================================================================
// Types
// ============================================================================

interface BiModelTable {
  name: string;
  columns: Array<{ name: string; dataType: string; isNumeric: boolean }>;
}

interface BiModelInfo {
  tables: BiModelTable[];
  measures: Array<{ name: string }>;
  lookupColumns?: string[];
}

interface DataSource {
  type: SlicerSourceType;
  id: number;
  name: string;
  sheetIndex: number;
  fields: string[];
  /** BI model info for BI-backed pivots (fields organized by table) */
  biModel?: BiModelInfo;
}

// ============================================================================
// BI Pivot Helpers
// ============================================================================

interface BiFieldRef {
  table: string;
  column: string;
  isLookup: boolean;
}

interface BiValueFieldRef {
  measureName: string;
}

interface HierarchiesResult {
  hierarchies: Array<{ index: number; name: string }>;
  rowHierarchies: Array<{ name: string }>;
  columnHierarchies: Array<{ name: string }>;
  dataHierarchies: Array<{ name: string }>;
  filterHierarchies: Array<{ name: string }>;
  biModel?: BiModelInfo;
}

/** Parse "table.column" to BiFieldRef */
function parseBiFieldRef(name: string, lookupColumns: string[]): BiFieldRef {
  const dotIdx = name.indexOf(".");
  const table = dotIdx >= 0 ? name.substring(0, dotIdx) : "";
  const column = dotIdx >= 0 ? name.substring(dotIdx + 1) : name;
  return { table, column, isLookup: lookupColumns.includes(name) };
}

/**
 * Resolve a hierarchy name (which may be just "column" from the Arrow schema)
 * to a full BiFieldRef by looking up the table name in the BI model.
 */
function resolveHierarchyFieldRef(
  name: string,
  lookupColumns: string[],
  biModel: BiModelInfo | undefined,
): BiFieldRef {
  if (name.includes(".")) {
    return parseBiFieldRef(name, lookupColumns);
  }
  // Bare column name from cache — find which table it belongs to in the BI model.
  // Use case-insensitive matching since Arrow schema names may differ in casing.
  if (biModel) {
    const nameLower = name.toLowerCase();
    for (const table of biModel.tables) {
      const col = table.columns.find((c) => c.name.toLowerCase() === nameLower);
      if (col) {
        const fullKey = `${table.name}.${col.name}`;
        return { table: table.name, column: col.name, isLookup: lookupColumns.includes(fullKey) };
      }
    }
  }
  console.warn("[Slicer] resolveHierarchyFieldRef: could not resolve table for bare field name:", name);
  return parseBiFieldRef(name, lookupColumns);
}

/** Parse "[MeasureName]" to BiValueFieldRef */
function parseBiValueFieldRef(name: string): BiValueFieldRef {
  return { measureName: name.replace(/^\[|\]$/g, "") };
}

/**
 * Ensures that the specified BI fields are in the pivot cache so slicer items
 * can be loaded. If any fields are missing, adds them as filter fields
 * by calling update_bi_pivot_fields.
 */
async function ensureBiFieldsInPivot(
  pivotId: number,
  selectedFieldKeys: string[], // "table.column" format
  biModel: BiModelInfo,
): Promise<void> {
  // Get current pivot state
  const result = await invokeBackend<HierarchiesResult>(
    "get_pivot_hierarchies",
    { pivotId },
  );

  // Cache field names (just column names from Arrow schema)
  const cacheFieldNames = new Set(result.hierarchies.map((h) => h.name));

  // Check which selected fields are NOT in the cache
  const missingFields = selectedFieldKeys.filter((key) => {
    const colPart = key.includes(".") ? key.split(".").pop()! : key;
    return !cacheFieldNames.has(colPart) && !cacheFieldNames.has(key);
  });

  if (missingFields.length === 0) return; // All fields already in cache

  // Reconstruct current field configuration as BiFieldRefs.
  // Use the caller-provided biModel (already validated) as primary source for
  // table name resolution; fall back to result.biModel from the hierarchies call.
  const resolveModel = biModel ?? result.biModel;
  const lookupCols = result.biModel?.lookupColumns ?? biModel?.lookupColumns ?? [];

  // Filter out the synthetic "Total" row field (internal BI pivot implementation detail).
  const rowFields: BiFieldRef[] = result.rowHierarchies
    .filter((h) => h.name !== "Total")
    .map((h) => resolveHierarchyFieldRef(h.name, lookupCols, resolveModel));
  const columnFields: BiFieldRef[] = result.columnHierarchies
    .filter((h) => h.name !== "Total")
    .map((h) => resolveHierarchyFieldRef(h.name, lookupCols, resolveModel));
  const valueFields: BiValueFieldRef[] = result.dataHierarchies.map((h) =>
    parseBiValueFieldRef(h.name),
  );
  const filterFields: BiFieldRef[] = result.filterHierarchies.map((h) =>
    resolveHierarchyFieldRef(h.name, lookupCols, resolveModel),
  );

  // Add missing fields as slicer fields — included in the GROUP BY
  // query so they appear in the cache, but NOT shown as visible filter rows.
  const slicerFields: BiFieldRef[] = missingFields.map((fieldKey) =>
    parseBiFieldRef(fieldKey, []),
  );

  // Re-query the BI engine with the updated field configuration
  await updateBiPivotFields({
    pivotId,
    rowFields,
    columnFields,
    valueFields,
    filterFields,
    slicerFields,
    lookupColumns: lookupCols,
  });

  // Wait for pivot refresh event
  window.dispatchEvent(new Event("pivot:refresh"));
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
  const [collapsedTables, setCollapsedTables] = useState<Set<string>>(
    new Set(),
  );

  // Pre-select a specific source if passed via dialog data
  const preselectedSourceType = data?.sourceType as SlicerSourceType | undefined;
  const preselectedSourceId = data?.sourceId as number | undefined;

  // Load available data sources when dialog opens
  useEffect(() => {
    if (isOpen) {
      setError(null);
      setCheckedFields(new Set());
      setSelectedSourceIndex(-1);
      setCollapsedTables(new Set());
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
          try {
            const result = await invokeBackend<{
              hierarchies: Array<{ index: number; name: string }>;
              biModel?: BiModelInfo;
            }>("get_pivot_hierarchies", { pivotId: pv.id });

            if (result.biModel) {
              // BI pivot: use all dimension columns from the model, exclude measures
              const allFields: string[] = [];
              for (const table of result.biModel.tables) {
                for (const col of table.columns) {
                  allFields.push(`${table.name}.${col.name}`);
                }
              }
              allSources.push({
                type: "pivot",
                id: pv.id,
                name: pv.name,
                sheetIndex: currentSheetIndex,
                fields: allFields,
                biModel: result.biModel,
              });
            } else {
              // Range pivot: use all cache fields
              allSources.push({
                type: "pivot",
                id: pv.id,
                name: pv.name,
                sheetIndex: currentSheetIndex,
                fields: result.hierarchies.map((h) => h.name),
              });
            }
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

  const handleTableToggle = (tableName: string) => {
    setCollapsedTables((prev) => {
      const next = new Set(prev);
      if (next.has(tableName)) {
        next.delete(tableName);
      } else {
        next.add(tableName);
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
      const fieldKeys = Array.from(checkedFields);
      const slicerWidth = 180;
      const slicerHeight = 240;
      const gap = 10;
      const isBi = !!selectedSource.biModel;

      // For BI pivots, ensure selected fields are in the pivot cache
      // by adding them as filter fields if needed
      if (isBi) {
        await ensureBiFieldsInPivot(
          selectedSource.id,
          fieldKeys,
          selectedSource.biModel!,
        );
      }

      // Create one slicer per checked field, positioned side by side
      // Start at a reasonable position (100, 100 from sheet origin)
      let offsetX = 100;
      for (const fieldKey of fieldKeys) {
        // For BI pivots, fieldKey is "table.column" - use "table.column" as the
        // slicer fieldName so the backend can match it in the pivot cache
        const fieldName = fieldKey;
        const displayName = isBi && fieldKey.includes(".")
          ? fieldKey.split(".").pop()!
          : fieldKey;

        const slicer = await createSlicerAsync({
          name: displayName,
          sheetIndex: activeSheetIndex,
          x: offsetX,
          y: 100,
          width: slicerWidth,
          height: slicerHeight,
          sourceType: selectedSource.type,
          cacheSourceId: selectedSource.id,
          fieldName,
          connectedSourceIds: [selectedSource.id],
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

  // Render field list for BI pivot (organized by table folders)
  const renderBiFields = (biModel: BiModelInfo) => {
    return (
      <div style={styles.fieldList}>
        {biModel.tables.map((table) => {
          const isCollapsed = collapsedTables.has(table.name);
          return (
            <div key={table.name}>
              <div
                style={styles.tableHeader}
                onClick={() => handleTableToggle(table.name)}
              >
                <span style={styles.collapseIcon}>
                  {isCollapsed ? "\u25B6" : "\u25BC"}
                </span>
                <span style={styles.tableIcon}>
                  {"\u229E"}
                </span>
                <span>{table.name}</span>
                <span style={styles.fieldCount}>{table.columns.length}</span>
              </div>
              {!isCollapsed &&
                table.columns.map((col) => {
                  const fieldKey = `${table.name}.${col.name}`;
                  return (
                    <label key={fieldKey} style={styles.checkboxLabelIndented}>
                      <input
                        type="checkbox"
                        checked={checkedFields.has(fieldKey)}
                        onChange={() => handleFieldToggle(fieldKey)}
                        disabled={isLoading}
                        style={styles.checkbox}
                      />
                      <span style={styles.fieldTypeIcon}>
                        {col.isNumeric ? "#" : "Aa"}
                      </span>
                      <span>{col.name}</span>
                    </label>
                  );
                })}
            </div>
          );
        })}
        {biModel.tables.length === 0 && (
          <div style={styles.emptyText}>No fields available.</div>
        )}
      </div>
    );
  };

  // Render flat field list (for tables and range pivots)
  const renderFlatFields = (fields: string[]) => {
    return (
      <div style={styles.fieldList}>
        {fields.map((field) => (
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
        {fields.length === 0 && (
          <div style={styles.emptyText}>No fields available for this source.</div>
        )}
      </div>
    );
  };

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
                    setCollapsedTables(new Set());
                  }}
                  disabled={isLoading}
                >
                  <option value={-1}>-- Select a source --</option>
                  {sources.map((source, i) => (
                    <option key={`${source.type}-${source.id}`} value={i}>
                      {source.name} ({source.type === "table" ? "Table" : source.biModel ? "Data Model" : "PivotTable"})
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
                  {selectedSource.biModel
                    ? renderBiFields(selectedSource.biModel)
                    : renderFlatFields(selectedSource.fields)}
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
    maxHeight: "300px",
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
  checkboxLabelIndented: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    fontSize: "13px",
    color: "#cccccc",
    cursor: "pointer",
    padding: "4px 0",
    paddingLeft: "24px",
  },
  checkbox: {
    margin: 0,
    cursor: "pointer",
  },
  tableHeader: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    fontSize: "13px",
    fontWeight: 500,
    color: "#cccccc",
    cursor: "pointer",
    padding: "6px 0",
    userSelect: "none" as const,
  },
  collapseIcon: {
    fontSize: "9px",
    width: "12px",
    textAlign: "center" as const,
    color: "#888888",
  },
  tableIcon: {
    fontSize: "13px",
    color: "#888888",
  },
  fieldCount: {
    marginLeft: "auto",
    fontSize: "11px",
    color: "#666666",
  },
  fieldTypeIcon: {
    fontSize: "11px",
    color: "#888888",
    fontWeight: 600,
    minWidth: "16px",
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
