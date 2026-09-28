//! FILENAME: app/extensions/Slicer/components/InsertSlicerDialog.tsx
// PURPOSE: Dialog for inserting slicers. Lists the workbook's Calcula models,
//          Tables and PivotTables, shows their fields as checkboxes, and creates
//          one slicer per checked field.
// CONTEXT: Offers every loaded MODEL first ("Sales (Model)" -- a model slicer
//          filters every PivotTable of that model on the sheet or canvas it is
//          placed on), then the tables of EVERY sheet (each labelled with its
//          sheet), then the pivots, and places the slicers on the ACTIVE sheet —
//          at `data.placement` when the caller passed one (a canvas sheet's
//          snapped rectangle), else at the historical (100, 100) cascade. The
//          list and the layout are pure functions in ../lib/insertSlicerPlan.ts.
//
//          The dialog never rebuilds a pivot. A slicer on a BI pivot whose
//          column the pivot does not carry yet has the Pivot owner add it on
//          the server (the store's item repair), and the whole insert is ONE
//          undo step.

import React, { useState, useEffect, useCallback, useMemo } from "react";
import type { DialogProps } from "@api";
import { useDialogWindow } from "@api/dialogWindow";
import { getSheets } from "@api";
import {
  getAllPivotTables,
  getPivotHierarchies,
  getAllTables,
  biGetConnections,
  biGetModelInfo,
} from "@api/backend";
import { runInUndoTransaction } from "@api/objectGeometry";
import { splitBiFieldKey } from "../../_shared/lib/biFieldKey";
import { createSlicerAsync } from "../lib/slicerStore";
import type { SlicerSourceType, CreateSlicerParams } from "../lib/slicerTypes";
import {
  type BiModelInfo,
  type ModelInfoListing,
  type SlicerDataSource,
  MODEL_SLICER_REACH,
  modelSources,
  pivotSource,
  readSlicerPlacement,
  slicerRects,
  sourceLabel,
  tableSources,
} from "../lib/insertSlicerPlan";

// ============================================================================
// Types
// ============================================================================

/** One entry of the "Data source" list (see insertSlicerPlan). */
type DataSource = SlicerDataSource;

/** The empty-state text: nothing in the workbook a slicer could filter. */
export const NO_SLICER_SOURCES_TEXT =
  "No Tables, PivotTables or models found in this workbook. Create a Table, a " +
  "PivotTable or a model connection first, then insert a Slicer.";

/**
 * Where the created slicer reads its items and what it connects to: a model
 * source makes a MODEL slicer (items from the model; page scope), a table or
 * pivot source what it always made.
 */
export function slicerParamsFor(
  source: SlicerDataSource,
  fieldKey: string,
): Pick<CreateSlicerParams, "name" | "sourceType" | "cacheSourceId" | "fieldName" | "connectedSources"> {
  // A BI key's display name is its COLUMN, split against the model's own
  // table names -- a table name may contain a dot ("BI.dim_customer.Name").
  const tableNames = source.biModel?.tables.map((t) => t.name);
  const name = source.biModel ? splitBiFieldKey(fieldKey, tableNames).column : fieldKey;
  return {
    name,
    sourceType: source.type,
    cacheSourceId: source.id,
    // For BI sources the field is the full "Table.Column" key.
    fieldName: fieldKey,
    // A model slicer's one connection means "every BI pivot of this model on
    // the slicer's own sheet" (the backend normalises it to exactly this).
    connectedSources: [{ sourceType: source.type, sourceId: source.id }],
  };
}

// ============================================================================
// Component
// ============================================================================

export function InsertSlicerDialog({
  isOpen,
  onClose,
  data,
}: DialogProps): React.ReactElement | null {
  // Movable + resizable dialog window (shared @api hook)
  const win = useDialogWindow({ minWidth: 320, minHeight: 300 });

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
  const preselectedSourceId = data?.sourceId as string | undefined;
  // Where the caller wants the slicers (sheet pixels, active sheet), if it said.
  const placement = useMemo(() => readSlicerPlacement(data), [data]);

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
      const sheetNames = sheetsResult.sheets.map((s) => ({ index: s.index, name: s.name }));

      const allSources: DataSource[] = [];

      // Every loaded MODEL first: a workbook that holds only a model (a canvas
      // report page, typically) has no table and no pivot, and used to be
      // told there was nothing to slice. A connection whose model is not
      // loaded has no columns to offer and is skipped.
      try {
        const connections = await biGetConnections();
        const infoById: Record<string, ModelInfoListing | null> = {};
        for (const conn of connections) {
          try {
            infoById[conn.id] = await biGetModelInfo(conn.id);
          } catch (err) {
            console.warn("[InsertSlicerDialog] Failed to load model info for", conn.name, err);
          }
        }
        allSources.push(...modelSources(connections, infoById));
      } catch (err) {
        console.warn("[InsertSlicerDialog] Failed to load model connections:", err);
      }

      // Fetch the tables of EVERY sheet. A slicer addresses its source by id,
      // so a table on another sheet is as good a source as one here — and on a
      // canvas sheet, which can hold no table, it is the only kind there is.
      try {
        const tables = await getAllTables();
        allSources.push(...tableSources(tables, sheetNames, currentSheetIndex));
      } catch (err) {
        console.warn("[InsertSlicerDialog] Failed to load tables:", err);
      }

      // Fetch pivot tables
      try {
        const pivots = await getAllPivotTables<
          Array<{
            id: string;
            name: string;
            sourceRange: string;
            sheetIndex?: number;
          }>
        >();
        for (const pv of pivots) {
          try {
            const result = await getPivotHierarchies<{
              hierarchies: Array<{ index: number; name: string }>;
              biModel?: BiModelInfo;
            }>(pv.id);

            if (result.biModel) {
              // BI pivot: use all dimension columns from the model, exclude measures
              const allFields: string[] = [];
              for (const table of result.biModel.tables) {
                for (const col of table.columns) {
                  allFields.push(`${table.name}.${col.name}`);
                }
              }
              allSources.push(pivotSource(pv, allFields, sheetNames, result.biModel));
            } else {
              // Range pivot: use all cache fields
              allSources.push(
                pivotSource(pv, result.hierarchies.map((h) => h.name), sheetNames),
              );
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

      // Create one slicer per checked field, positioned side by side on the
      // ACTIVE sheet: from the caller's placement when it gave one, else from
      // (100, 100) as always. ONE undo step for the whole insert: each
      // create_slicer -- and a BI pivot's server-side column add, run by the
      // store when the slicer's items name a column the pivot lacks -- joins
      // it.
      const rects = slicerRects(fieldKeys.length, placement);
      await runInUndoTransaction(fieldKeys.length > 1 ? "Insert Slicers" : "Insert Slicer", async () => {
        for (let i = 0; i < fieldKeys.length; i++) {
          const rect = rects[i];
          const params = slicerParamsFor(selectedSource, fieldKeys[i]);
          const slicer = await createSlicerAsync({
            ...params,
            sheetIndex: activeSheetIndex,
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          });

          if (!slicer) {
            throw new Error(`Failed to create slicer for field "${params.fieldName}".`);
          }
        }
      });

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
        ref={win.ref}
        style={{ ...styles.dialog, position: "relative", ...win.style }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Header — drag handle */}
        <div style={styles.header} onMouseDown={win.onHeaderMouseDown}>
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
            <div style={styles.emptyText}>{NO_SLICER_SOURCES_TEXT}</div>
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
                    <option
                      key={`${source.type}-${source.id}`}
                      value={i}
                      title={source.type === "biConnection" ? MODEL_SLICER_REACH : undefined}
                    >
                      {sourceLabel(source)}
                    </option>
                  ))}
                </select>
                {selectedSource?.type === "biConnection" && (
                  <div style={styles.reachNote} data-testid="model-slicer-reach">
                    {MODEL_SLICER_REACH}
                  </div>
                )}
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
        {win.resizeHandles}
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
  reachNote: {
    fontSize: "12px",
    color: "#aaaaaa",
    marginTop: "8px",
    lineHeight: 1.4,
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
