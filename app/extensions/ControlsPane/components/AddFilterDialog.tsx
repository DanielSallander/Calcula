//! FILENAME: app/extensions/ControlsPane/components/AddFilterDialog.tsx
// PURPOSE: Dialog for adding filters to the Filter Pane. Filters are always
//          sourced from a Calcula model (BI) connection — the dialog lists
//          the workbook's model connections and their model fields.

import React, { useState, useEffect, useCallback } from "react";
import type { DialogProps } from "@api";
import {
  DialogBody,
  DialogPane,
  DialogFieldGrid,
  DialogPaneTitle,
  dialogWidth,
  dialogHeight,
} from "@api/dialogLayout";
import { splitBiFieldKey } from "../../_shared/lib/biFieldKey";
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
  /** The model's table names, so a key can be split on the LONGEST known table
   *  prefix. A first-dot split mis-attributes a schema-qualified table such as
   *  "BI.dim_customer" — see extensions/_shared/lib/biFieldKey.ts. */
  tableNames: string[];
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
          const tableNames: string[] = [];
          const fieldTypes = new Map<string, FieldDataType>();
          for (const table of modelInfo.tables) {
            tableNames.push(table.name);
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
            tableNames,
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

  // Grouping by table is only a win on a BIG model: six uppercase headings plus
  // their spacing cost more height than they save on a 24-column model, so the
  // flat list stays flat until the model is large enough for the headings to
  // earn their keep. Plain consts, not useMemo — this runs after the `!isOpen`
  // early return, so a hook here would change hook order between renders.
  const groupByTable = !!selectedSource && selectedSource.fields.length > GROUP_BY_TABLE_MIN_FIELDS;
  const fieldGroups: Array<[string, string[]]> = [];
  if (groupByTable) {
    const byTable = new Map<string, string[]>();
    for (const f of filteredFields) {
      const { table } = splitBiFieldKey(f, selectedSource?.tableNames);
      const bucket = byTable.get(table);
      if (bucket) bucket.push(f);
      else byTable.set(table, [f]);
    }
    for (const entry of byTable) fieldGroups.push(entry);
  }

  // One row of the field list. `field` is always the full "Table.Column" key —
  // that is what gets stored — while `display` may have the table prefix
  // stripped when the heading above already says it. The title attribute keeps
  // the whole key readable on hover either way.
  const renderField = (field: string, display: string) => (
    <label key={field} style={styles.fieldItem} title={field}>
      <input
        type="checkbox"
        checked={checkedFields.has(field)}
        onChange={() => handleToggleField(field)}
      />
      <span style={styles.fieldName}>{display}</span>
    </label>
  );

  return (
    <div style={styles.overlay} onClick={onClose}>
      {/* The dialog claims its full permitted height ONLY once there is a field
          list to fill it — a 680px box holding the one-sentence "no model
          connections" notice would just look broken. */}
      <div
        style={{
          ...styles.dialog,
          height: selectedSource ? DIALOG_TALL_HEIGHT : undefined,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={styles.header}>
          <span style={styles.title}>Add Filter</span>
          <button style={styles.closeButton} onClick={onClose}>
            x
          </button>
        </div>

        {/* Body — DialogBody/DialogPane carry the `minHeight: 0` chain the
            hand-rolled body never had, which is why the field list can scroll
            on its own instead of pushing the dialog past its maximum height. */}
        <DialogBody stacked>
          <DialogPane scroll={false} padding="12px 16px">
            {/* Model connection picker — stays a <select>: it does the job in
                29px, keeps keyboard nav and a11y for free, and the common case
                is a single connection that is auto-selected anyway. */}
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

            {/* Field list — the label and the search box stay pinned while the
                list below them takes every remaining pixel. The old 300px cap
                showed 12 rows of a 61-column model through a window half the
                size the dialog was already allowed to be. */}
            {selectedSource && (
              <div style={styles.fieldsSection}>
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
                  {/* Short field names flow into two columns, so a full-height
                      list shows ~44 of them at once instead of ~12. */}
                  {groupByTable
                    ? fieldGroups.map(([table, fields]) => (
                        <div key={table}>
                          <DialogPaneTitle style={styles.fieldGroupTitle}>
                            {table}
                          </DialogPaneTitle>
                          <DialogFieldGrid
                            minColumnWidth={240}
                            maxColumns={2}
                            rowGap={0}
                          >
                            {fields.map((f) =>
                              renderField(
                                f,
                                splitBiFieldKey(f, selectedSource?.tableNames)
                                  .column || f,
                              ),
                            )}
                          </DialogFieldGrid>
                        </div>
                      ))
                    : (
                        <DialogFieldGrid
                          minColumnWidth={240}
                          maxColumns={2}
                          rowGap={0}
                        >
                          {filteredFields.map((f) => renderField(f, f))}
                        </DialogFieldGrid>
                      )}
                  {filteredFields.length === 0 && (
                    <div style={styles.noData}>No matching fields</div>
                  )}
                </div>
              </div>
            )}
          </DialogPane>
        </DialogBody>

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

/** Height the dialog claims once a connection is picked. */
const DIALOG_TALL_HEIGHT = dialogHeight(680);

/** Above this many columns, the per-table headings save more than they cost. */
const GROUP_BY_TABLE_MIN_FIELDS = 30;

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
    // Two columns of "Table.Column" keys need ~640px; 420 could only ever show
    // one. `overflow: hidden` keeps the BOX from scrolling, so the title bar
    // and the Add button never slide out of view — only the field list moves.
    width: dialogWidth(640),
    maxHeight: "90vh",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    boxShadow: "0 8px 32px rgba(0,0,0,0.2)",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 16px",
    borderBottom: "1px solid #e0e0e0",
    flexShrink: 0,
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
  field: {
    marginBottom: "12px",
    flexShrink: 0,
  },
  /** The field list's section: it, not the dialog, absorbs the spare height. */
  fieldsSection: {
    display: "flex",
    flexDirection: "column",
    flex: 1,
    minHeight: 0,
  },
  label: {
    display: "block",
    fontSize: "12px",
    fontWeight: 600,
    color: "#555",
    marginBottom: "4px",
    flexShrink: 0,
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
    flexShrink: 0,
  },
  /** The ONLY scroller in the dialog — `maxHeight: 300px` used to be, and that
   *  cap was what made a 61-column model a five-screenful straw. */
  fieldList: {
    flex: 1,
    minHeight: 0,
    overflowY: "auto" as const,
    border: "1px solid #d0d0d0",
    borderRadius: "4px",
    padding: "4px 0",
  },
  fieldGroupTitle: {
    color: "#888",
    padding: "6px 10px 2px",
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
    // A flex item's default `min-width: auto` refuses to shrink, so without
    // this the ellipsis above never fires inside a fixed-width grid column.
    minWidth: 0,
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
    flexShrink: 0,
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
