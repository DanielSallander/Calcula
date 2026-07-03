//! FILENAME: app/extensions/FilterPane/components/AddFilterDialog.tsx
// PURPOSE: Dialog for adding filters to the Filter Pane. Filters are always
//          sourced from a Calcula model (BI) connection — the dialog lists
//          the workbook's model connections and their model fields.

import React, { useState, useEffect, useCallback } from "react";
import type { DialogProps } from "@api";
import { createFilterAsync } from "../lib/filterPaneStore";
import {
  getBiConnections,
  getBiModelInfo,
} from "../lib/filterPaneApi";
import type { FieldDataType } from "../lib/filterPaneTypes";

// ============================================================================
// Types
// ============================================================================

interface ModelSource {
  /** The BI connection id. */
  connectionId: string;
  name: string;
  description: string;
  /** "Table.Column" keys of all model columns. */
  fields: string[];
  /** Map of field name -> data type category. */
  fieldTypes: Map<string, FieldDataType>;
}

// ============================================================================
// Component
// ============================================================================

export function AddFilterDialog({
  isOpen,
  onClose,
}: DialogProps): React.ReactElement | null {
  const [sources, setSources] = useState<ModelSource[]>([]);
  const [selectedSourceIndex, setSelectedSourceIndex] = useState<number>(-1);
  const [checkedFields, setCheckedFields] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingSources, setIsLoadingSources] = useState(false);
  const [searchText, setSearchText] = useState("");

  // Load model connections when dialog opens
  useEffect(() => {
    if (isOpen) {
      setCheckedFields(new Set());
      setSelectedSourceIndex(-1);
      setSearchText("");
      loadModelSources();
    }
  }, [isOpen]);

  const loadModelSources = async () => {
    setIsLoadingSources(true);
    try {
      const allSources: ModelSource[] = [];

      const connections = await getBiConnections();
      for (const conn of connections) {
        // NOTE: no modelPath check — connections created from an embedded
        // model (packages, inline JSON) have no path but a loaded model;
        // the try below already handles a connection without one.
        try {
          const modelInfo = await getBiModelInfo(conn.id);
          const allFields: string[] = [];
          const fieldTypes = new Map<string, FieldDataType>();
          for (const table of modelInfo.tables) {
            for (const col of table.columns) {
              const key = `${table.name}.${col.name}`;
              allFields.push(key);
              // Map BI data types to our categories
              const dt = (col.dataType || "").toLowerCase();
              if (dt.includes("int") || dt.includes("float") || dt.includes("decimal") || dt.includes("numeric") || dt.includes("double") || dt.includes("real")) {
                fieldTypes.set(key, "number");
              } else if (dt.includes("date") || dt.includes("time") || dt.includes("timestamp")) {
                fieldTypes.set(key, "date");
              } else {
                fieldTypes.set(key, "text");
              }
            }
          }
          allSources.push({
            connectionId: conn.id,
            name: conn.name,
            description: conn.description,
            fields: allFields,
            fieldTypes,
          });
        } catch (err) {
          console.warn("[AddFilterDialog] Failed to load BI model info:", err);
        }
      }

      setSources(allSources);
      if (allSources.length === 1) {
        setSelectedSourceIndex(0);
      }
    } catch (err) {
      console.error("[AddFilterDialog] Failed to load model connections:", err);
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
      // Default to "workbook" mode: auto-connect all of this connection's pivots
      for (const fieldName of checkedFields) {
        await createFilterAsync({
          name: fieldName,
          connectionId: source.connectionId,
          fieldName,
          fieldDataType: source.fieldTypes.get(fieldName) ?? "unknown",
          connectionMode: "workbook",
        });
      }
      onClose();
    } catch (err) {
      console.error("[AddFilterDialog] Failed to create filters:", err);
    } finally {
      setIsLoading(false);
    }
  }, [selectedSourceIndex, checkedFields, sources, onClose]);

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
          {/* Model connection picker */}
          <div style={styles.field}>
            <label style={styles.label}>Model Connection</label>
            {isLoadingSources ? (
              <div style={styles.loading}>Loading model connections...</div>
            ) : sources.length === 0 ? (
              <div style={styles.noData}>
                No Calcula model connections found. Filters are sourced from
                model connections — add one via Data &#9656; Business
                Intelligence... first.
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
                <option value={-1}>-- Select a model connection --</option>
                {sources.map((s, i) => (
                  <option key={s.connectionId} value={i}>
                    {s.name}
                    {s.description ? ` — ${s.description}` : ""}
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
