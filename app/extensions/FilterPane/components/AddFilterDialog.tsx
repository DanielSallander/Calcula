//! FILENAME: app/extensions/FilterPane/components/AddFilterDialog.tsx
// PURPOSE: Dialog for adding filters to the Filter Pane. Lists available
//          Tables and PivotTables, shows their fields, creates ribbon filters.

import React, { useState, useEffect, useCallback } from "react";
import type { DialogProps } from "@api";
import { getSheets } from "@api";
import { invokeBackend, type Table, getAllPivotTables } from "@api/backend";
import { createFilterAsync } from "../lib/filterPaneStore";
import {
  getBiConnections,
  getBiModelInfo,
  type BiConnectionInfo,
} from "../lib/filterPaneApi";
import type {
  RibbonFilterScope,
  SlicerSourceType,
  SlicerConnection,
} from "../lib/filterPaneTypes";

// ============================================================================
// Types
// ============================================================================

interface DataSource {
  type: SlicerSourceType;
  id: number;
  name: string;
  sheetIndex: number;
  fields: string[];
  /** For biConnection sources: the connection ID */
  connectionId?: number;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Find all pivot tables backed by the same BI connection.
 * For sheet-scope filters, only pivots on the given sheet are included.
 * For workbook-scope, all pivots with that connection are included.
 */
async function findBiRelatedPivots(
  connectionId: number,
  scope: RibbonFilterScope,
  sheetIndex: number,
): Promise<SlicerConnection[]> {
  const connections: SlicerConnection[] = [];

  try {
    const pivots = await getAllPivotTables<
      Array<{ id: number; name: string; sourceRange: string }>
    >();

    for (const pv of pivots) {
      try {
        // Check if this pivot is backed by the same BI connection
        const biMeta = await invokeBackend<{
          connectionId: number;
          sheetIndex?: number;
        } | null>("get_pivot_bi_metadata", { pivotId: pv.id });

        if (biMeta && biMeta.connectionId === connectionId) {
          // For sheet scope, only include pivots on the target sheet
          if (scope === "workbook" || biMeta.sheetIndex === sheetIndex) {
            connections.push({ sourceType: "pivot", sourceId: pv.id });
          }
        }
      } catch {
        // Pivot might not have BI metadata (range pivot) — skip
      }
    }
  } catch (err) {
    console.warn("[AddFilterDialog] Failed to find BI-related pivots:", err);
  }

  return connections;
}

// ============================================================================
// Component
// ============================================================================

export function AddFilterDialog({
  isOpen,
  onClose,
}: DialogProps): React.ReactElement | null {
  const [sources, setSources] = useState<DataSource[]>([]);
  const [selectedSourceIndex, setSelectedSourceIndex] = useState<number>(-1);
  const [checkedFields, setCheckedFields] = useState<Set<string>>(new Set());
  const [scope, setScope] = useState<RibbonFilterScope>("sheet");
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingSources, setIsLoadingSources] = useState(false);
  const [activeSheetIndex, setActiveSheetIndex] = useState(0);
  const [searchText, setSearchText] = useState("");

  // Load data sources when dialog opens
  useEffect(() => {
    if (isOpen) {
      setCheckedFields(new Set());
      setSelectedSourceIndex(-1);
      setSearchText("");
      loadDataSources();
    }
  }, [isOpen]);

  const loadDataSources = async () => {
    setIsLoadingSources(true);
    try {
      const sheetsResult = await getSheets();
      const currentSheetIndex = sheetsResult.activeIndex;
      setActiveSheetIndex(currentSheetIndex);

      const allSources: DataSource[] = [];

      // Fetch all tables
      try {
        const tables = await invokeBackend<Table[]>("get_all_tables", {});
        for (const table of tables) {
          allSources.push({
            type: "table",
            id: table.id,
            name: table.name,
            sheetIndex: table.sheetIndex,
            fields: table.columns.map((c) => c.name),
          });
        }
      } catch (err) {
        console.warn("[AddFilterDialog] Failed to load tables:", err);
      }

      // Fetch all pivots
      try {
        const pivots = await getAllPivotTables<
          Array<{ id: number; name: string; sourceRange: string }>
        >();
        for (const pv of pivots) {
          try {
            const result = await invokeBackend<{
              hierarchies: Array<{ index: number; name: string }>;
              biModel?: { tables: Array<{ name: string; columns: Array<{ name: string }> }> };
            }>("get_pivot_hierarchies", { pivotId: pv.id });

            if (result.biModel) {
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
                sheetIndex: 0,
                fields: allFields,
              });
            } else {
              allSources.push({
                type: "pivot",
                id: pv.id,
                name: pv.name,
                sheetIndex: 0,
                fields: result.hierarchies.map((h) => h.name),
              });
            }
          } catch (err) {
            console.warn("[AddFilterDialog] Failed to load pivot fields:", err);
          }
        }
      } catch (err) {
        console.warn("[AddFilterDialog] Failed to load pivots:", err);
      }

      // Fetch BI connections (direct model access without pivot)
      try {
        const connections = await getBiConnections();
        for (const conn of connections) {
          if (!conn.modelPath) continue; // No model loaded
          try {
            const modelInfo = await getBiModelInfo(conn.id);
            const allFields: string[] = [];
            for (const table of modelInfo.tables) {
              for (const col of table.columns) {
                allFields.push(`${table.name}.${col.name}`);
              }
            }
            allSources.push({
              type: "biConnection",
              id: conn.id,
              name: `${conn.name} (BI Model)`,
              sheetIndex: 0,
              fields: allFields,
              connectionId: conn.id,
            });
          } catch (err) {
            console.warn("[AddFilterDialog] Failed to load BI model info:", err);
          }
        }
      } catch (err) {
        console.warn("[AddFilterDialog] Failed to load BI connections:", err);
      }

      setSources(allSources);
      if (allSources.length === 1) {
        setSelectedSourceIndex(0);
      }
    } catch (err) {
      console.error("[AddFilterDialog] Failed to load data sources:", err);
    } finally {
      setIsLoadingSources(false);
    }
  };

  const handleToggleField = useCallback(
    (field: string) => {
      setCheckedFields((prev) => {
        const next = new Set(prev);
        if (next.has(field)) {
          next.delete(field);
        } else {
          next.add(field);
        }
        return next;
      });
    },
    [],
  );

  const handleCreate = useCallback(async () => {
    if (selectedSourceIndex < 0 || checkedFields.size === 0) return;
    setIsLoading(true);

    const source = sources[selectedSourceIndex];

    try {
      // Build Report Connections based on source type
      let connectedSources: SlicerConnection[];

      if (source.type === "biConnection") {
        // For BI connections, auto-connect to all pivots backed by the same connection.
        // Scope-based: sheet filters only connect to pivots on that sheet.
        connectedSources = await findBiRelatedPivots(
          source.id,
          scope,
          activeSheetIndex,
        );
      } else {
        // For tables/pivots, connect directly to the source
        connectedSources = [
          { sourceType: source.type, sourceId: source.id },
        ];
      }

      for (const fieldName of checkedFields) {
        await createFilterAsync({
          name: fieldName,
          scope,
          sheetIndex: scope === "sheet" ? activeSheetIndex : undefined,
          sourceType: source.type,
          cacheSourceId: source.id,
          fieldName,
          connectedSources,
        });
      }
      onClose();
    } catch (err) {
      console.error("[AddFilterDialog] Failed to create filters:", err);
    } finally {
      setIsLoading(false);
    }
  }, [selectedSourceIndex, checkedFields, scope, sources, activeSheetIndex, onClose]);

  if (!isOpen) return null;

  const selectedSource = selectedSourceIndex >= 0 ? sources[selectedSourceIndex] : null;
  const filteredFields = selectedSource
    ? selectedSource.fields.filter(
        (f) => !searchText || f.toLowerCase().includes(searchText.toLowerCase()),
      )
    : [];

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.dialog} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div style={styles.header}>
          <span style={styles.title}>Add Filter</span>
          <button style={styles.closeButton} onClick={onClose}>
            x
          </button>
        </div>

        {/* Body */}
        <div style={styles.body}>
          {/* Scope selector */}
          <div style={styles.field}>
            <label style={styles.label}>Scope</label>
            <div style={styles.radioGroup}>
              <label style={styles.radioLabel}>
                <input
                  type="radio"
                  name="scope"
                  checked={scope === "sheet"}
                  onChange={() => setScope("sheet")}
                />
                Sheet
              </label>
              <label style={styles.radioLabel}>
                <input
                  type="radio"
                  name="scope"
                  checked={scope === "workbook"}
                  onChange={() => setScope("workbook")}
                />
                Workbook
              </label>
            </div>
          </div>

          {/* Source picker */}
          <div style={styles.field}>
            <label style={styles.label}>Data Source</label>
            {isLoadingSources ? (
              <div style={styles.loading}>Loading sources...</div>
            ) : sources.length === 0 ? (
              <div style={styles.noData}>
                No tables or pivot tables found. Create a Table or PivotTable
                first.
              </div>
            ) : (
              <select
                style={styles.select}
                value={selectedSourceIndex}
                onChange={(e) => {
                  setSelectedSourceIndex(Number(e.target.value));
                  setCheckedFields(new Set());
                  setSearchText("");
                }}
              >
                <option value={-1}>-- Select a source --</option>
                {sources.map((s, i) => (
                  <option key={`${s.type}-${s.id}`} value={i}>
                    {s.type === "table" ? "[Table]" : s.type === "biConnection" ? "[BI]" : "[Pivot]"} {s.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Field list */}
          {selectedSource && (
            <div style={styles.field}>
              <label style={styles.label}>
                Fields ({checkedFields.size} selected)
              </label>
              {selectedSource.fields.length > 8 && (
                <input
                  type="text"
                  placeholder="Search fields..."
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                  style={styles.searchInput}
                />
              )}
              <div style={styles.fieldList}>
                {filteredFields.map((f) => (
                  <label key={f} style={styles.fieldItem}>
                    <input
                      type="checkbox"
                      checked={checkedFields.has(f)}
                      onChange={() => handleToggleField(f)}
                    />
                    <span style={styles.fieldName}>{f}</span>
                  </label>
                ))}
                {filteredFields.length === 0 && (
                  <div style={styles.noData}>No matching fields</div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={styles.footer}>
          <button style={styles.cancelButton} onClick={onClose}>
            Cancel
          </button>
          <button
            style={{
              ...styles.createButton,
              opacity: checkedFields.size === 0 || isLoading ? 0.5 : 1,
            }}
            disabled={checkedFields.size === 0 || isLoading}
            onClick={handleCreate}
          >
            {isLoading ? "Creating..." : `Add ${checkedFields.size || ""} Filter${checkedFields.size !== 1 ? "s" : ""}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Styles
// ============================================================================

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.3)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 10000,
  },
  dialog: {
    background: "#fff",
    borderRadius: "6px",
    width: "420px",
    maxHeight: "90vh",
    display: "flex",
    flexDirection: "column",
    boxShadow: "0 8px 32px rgba(0,0,0,0.2)",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 16px",
    borderBottom: "1px solid #e0e0e0",
  },
  title: {
    fontSize: "14px",
    fontWeight: 600,
    color: "#333",
  },
  closeButton: {
    border: "none",
    background: "none",
    fontSize: "16px",
    cursor: "pointer",
    color: "#888",
    padding: "0 4px",
  },
  body: {
    padding: "12px 16px",
    overflowY: "auto" as const,
    flex: 1,
  },
  field: {
    marginBottom: "12px",
  },
  label: {
    display: "block",
    fontSize: "12px",
    fontWeight: 600,
    color: "#555",
    marginBottom: "4px",
  },
  radioGroup: {
    display: "flex",
    gap: "16px",
  },
  radioLabel: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    fontSize: "12px",
    cursor: "pointer",
  },
  select: {
    width: "100%",
    padding: "6px 8px",
    fontSize: "12px",
    border: "1px solid #d0d0d0",
    borderRadius: "3px",
  },
  searchInput: {
    width: "100%",
    boxSizing: "border-box" as const,
    padding: "5px 8px",
    fontSize: "11px",
    border: "1px solid #d0d0d0",
    borderRadius: "3px",
    marginBottom: "6px",
  },
  fieldList: {
    maxHeight: "300px",
    overflowY: "auto" as const,
    border: "1px solid #d0d0d0",
    borderRadius: "4px",
    padding: "4px 0",
  },
  fieldItem: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "4px 10px",
    cursor: "pointer",
    fontSize: "12px",
  },
  fieldName: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  loading: {
    fontSize: "12px",
    color: "#888",
    padding: "8px 0",
  },
  noData: {
    fontSize: "11px",
    color: "#aaa",
    padding: "12px 0",
    textAlign: "center" as const,
    fontStyle: "italic",
  },
  footer: {
    display: "flex",
    justifyContent: "flex-end",
    gap: "8px",
    padding: "12px 16px",
    borderTop: "1px solid #e0e0e0",
  },
  cancelButton: {
    padding: "6px 16px",
    fontSize: "12px",
    border: "1px solid #d0d0d0",
    borderRadius: "3px",
    background: "#fff",
    cursor: "pointer",
  },
  createButton: {
    padding: "6px 16px",
    fontSize: "12px",
    border: "none",
    borderRadius: "3px",
    background: "#0078d4",
    color: "#fff",
    cursor: "pointer",
  },
};
