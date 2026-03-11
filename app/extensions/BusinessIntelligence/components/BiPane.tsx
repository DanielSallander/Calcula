//! FILENAME: app/extensions/BusinessIntelligence/components/BiPane.tsx
// PURPOSE: Task pane for the BI extension — load model, connect, bind, query, insert.
// CONTEXT: Multi-step wizard UI following the Pivot task pane pattern.

import React, { useState, useCallback } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { TaskPaneViewProps } from "../../../src/api";
import { useGridState, restoreFocusToGrid } from "../../../src/api";
import {
  loadModel,
  connect,
  bindTable,
  query,
  insertResult,
  refresh,
  getCachedQueryResult,
} from "../lib/bi-api";
import type {
  BiModelInfo,
  BiTableInfo,
  BiQueryResult,
  BiColumnRef,
} from "../types";

// ============================================================================
// Styles
// ============================================================================

const styles = {
  container: {
    display: "flex",
    flexDirection: "column" as const,
    height: "100%",
    overflow: "auto",
    padding: "12px",
    fontSize: "13px",
    fontFamily: "Segoe UI, sans-serif",
    gap: "16px",
  },
  section: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "8px",
    borderBottom: "1px solid #e0e0e0",
    paddingBottom: "12px",
  },
  sectionTitle: {
    fontWeight: 600 as const,
    fontSize: "13px",
    color: "#333",
    margin: 0,
  },
  button: {
    padding: "6px 14px",
    fontSize: "12px",
    border: "1px solid #ccc",
    borderRadius: "3px",
    background: "#fff",
    cursor: "pointer",
    whiteSpace: "nowrap" as const,
  },
  buttonPrimary: {
    padding: "6px 14px",
    fontSize: "12px",
    border: "1px solid #0078d4",
    borderRadius: "3px",
    background: "#0078d4",
    color: "#fff",
    cursor: "pointer",
    whiteSpace: "nowrap" as const,
  },
  buttonDisabled: {
    padding: "6px 14px",
    fontSize: "12px",
    border: "1px solid #ddd",
    borderRadius: "3px",
    background: "#f5f5f5",
    color: "#999",
    cursor: "not-allowed" as const,
    whiteSpace: "nowrap" as const,
  },
  input: {
    padding: "5px 8px",
    fontSize: "12px",
    border: "1px solid #ccc",
    borderRadius: "3px",
    width: "100%",
    boxSizing: "border-box" as const,
  },
  status: {
    fontSize: "11px",
    color: "#666",
    padding: "4px 0",
  },
  statusError: {
    fontSize: "11px",
    color: "#d32f2f",
    padding: "4px 0",
  },
  statusSuccess: {
    fontSize: "11px",
    color: "#2e7d32",
    padding: "4px 0",
  },
  label: {
    fontSize: "12px",
    color: "#555",
  },
  checkbox: {
    marginRight: "6px",
  },
  checkboxLabel: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    fontSize: "12px",
    cursor: "pointer",
  },
  table: {
    width: "100%",
    borderCollapse: "collapse" as const,
    fontSize: "11px",
  },
  th: {
    textAlign: "left" as const,
    padding: "4px 6px",
    borderBottom: "1px solid #ddd",
    fontWeight: 600 as const,
    background: "#f9f9f9",
  },
  td: {
    padding: "3px 6px",
    borderBottom: "1px solid #eee",
  },
  row: {
    display: "flex",
    gap: "8px",
    alignItems: "center",
  },
  bindRow: {
    display: "flex",
    gap: "6px",
    alignItems: "center",
    fontSize: "12px",
  },
  smallInput: {
    padding: "4px 6px",
    fontSize: "11px",
    border: "1px solid #ccc",
    borderRadius: "3px",
    width: "80px",
  },
  previewContainer: {
    maxHeight: "200px",
    overflow: "auto",
    border: "1px solid #ddd",
    borderRadius: "3px",
  },
};

// ============================================================================
// Component
// ============================================================================

interface TableBinding {
  modelTable: string;
  schema: string;
  sourceTable: string;
}

export function BiPane(_props: TaskPaneViewProps): React.ReactElement {
  const gridState = useGridState();

  // ----- Step State -----
  const [modelInfo, setModelInfo] = useState<BiModelInfo | null>(null);
  const [connected, setConnected] = useState(false);
  const [tablesBound, setTablesBound] = useState(false);
  const [inserted, setInserted] = useState(false);

  // ----- Form State -----
  const [connectionString, setConnectionString] = useState(
    "postgresql://postgres:postgres@localhost:5432/Adventureworks",
  );
  const [bindings, setBindings] = useState<TableBinding[]>([]);
  const [selectedMeasures, setSelectedMeasures] = useState<Set<string>>(
    new Set(),
  );
  const [selectedGroupBy, setSelectedGroupBy] = useState<BiColumnRef[]>([]);
  const [queryResult, setQueryResult] = useState<BiQueryResult | null>(null);

  // ----- Status -----
  const [loading, setLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [statusType, setStatusType] = useState<"info" | "error" | "success">(
    "info",
  );

  // ----- Helpers -----
  const setStatus = useCallback(
    (msg: string, type: "info" | "error" | "success" = "info") => {
      setStatusMessage(msg);
      setStatusType(type);
    },
    [],
  );

  // ----- Handlers -----

  const handleLoadModel = useCallback(async () => {
    try {
      const path = await open({
        filters: [{ name: "Data Model", extensions: ["json"] }],
        multiple: false,
        directory: false,
      });
      if (!path || typeof path !== "string") return;

      setLoading(true);
      setStatus("Loading model...");

      const info = await loadModel(path);
      setModelInfo(info);

      // Initialize bindings with model table names
      const initialBindings: TableBinding[] = info.tables.map((t) => ({
        modelTable: t.name,
        schema: "BI",
        sourceTable: t.name.toLowerCase(),
      }));
      setBindings(initialBindings);

      // Select all measures by default
      setSelectedMeasures(new Set(info.measures.map((m) => m.name)));

      // Reset downstream state
      setConnected(false);
      setTablesBound(false);
      setInserted(false);
      setQueryResult(null);

      setStatus(
        `Model loaded: ${info.tables.length} tables, ${info.measures.length} measures`,
        "success",
      );
    } catch (error) {
      setStatus(`Failed to load model: ${error}`, "error");
    } finally {
      setLoading(false);
    }
  }, [setStatus]);

  const handleConnect = useCallback(async () => {
    try {
      setLoading(true);
      setStatus("Connecting...");

      const result = await connect({ connectionString });
      setConnected(true);
      setTablesBound(false);
      setInserted(false);
      setQueryResult(null);
      setStatus(result, "success");
    } catch (error) {
      setStatus(`Connection failed: ${error}`, "error");
    } finally {
      setLoading(false);
    }
  }, [connectionString, setStatus]);

  const handleBindTables = useCallback(async () => {
    try {
      setLoading(true);
      setStatus("Binding tables...");

      for (const binding of bindings) {
        await bindTable({
          modelTable: binding.modelTable,
          schema: binding.schema,
          sourceTable: binding.sourceTable,
        });
      }

      setTablesBound(true);
      setInserted(false);
      setQueryResult(null);
      setStatus(`Bound ${bindings.length} tables`, "success");
    } catch (error) {
      setStatus(`Bind failed: ${error}`, "error");
    } finally {
      setLoading(false);
    }
  }, [bindings, setStatus]);

  const handleQuery = useCallback(async () => {
    try {
      setLoading(true);
      setStatus("Executing query...");

      const result = await query({
        measures: Array.from(selectedMeasures),
        groupBy: selectedGroupBy,
        filters: [],
      });

      setQueryResult(result);
      setStatus(
        `Query returned ${result.rowCount} rows, ${result.columns.length} columns`,
        "success",
      );
    } catch (error) {
      setStatus(`Query failed: ${error}`, "error");
    } finally {
      setLoading(false);
    }
  }, [selectedMeasures, selectedGroupBy, setStatus]);

  const handleInsert = useCallback(async () => {
    try {
      if (!queryResult) return;

      setLoading(true);
      setStatus("Inserting into sheet...");

      const selection = gridState.selection;
      const startRow = selection ? selection.startRow : 0;
      const startCol = selection ? selection.startCol : 0;

      const response = await insertResult({
        sheetIndex: gridState.sheetContext?.activeSheet ?? 0,
        startRow,
        startCol,
      });

      setInserted(true);
      setStatus(
        `Inserted at (${response.startRow},${response.startCol}) to (${response.endRow},${response.endCol})`,
        "success",
      );

      // Restore focus so user can see the result
      restoreFocusToGrid();
    } catch (error) {
      setStatus(`Insert failed: ${error}`, "error");
    } finally {
      setLoading(false);
    }
  }, [queryResult, gridState, setStatus]);

  const handleRefresh = useCallback(async () => {
    try {
      setLoading(true);
      setStatus("Refreshing...");

      const result = await refresh();
      setQueryResult(result);
      setStatus(`Refreshed: ${result.rowCount} rows`, "success");

      restoreFocusToGrid();
    } catch (error) {
      setStatus(`Refresh failed: ${error}`, "error");
    } finally {
      setLoading(false);
    }
  }, [setStatus]);

  const handleBindingChange = useCallback(
    (idx: number, field: "schema" | "sourceTable", value: string) => {
      setBindings((prev) => {
        const next = [...prev];
        next[idx] = { ...next[idx], [field]: value };
        return next;
      });
    },
    [],
  );

  const toggleMeasure = useCallback((name: string) => {
    setSelectedMeasures((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  }, []);

  const toggleGroupBy = useCallback(
    (table: string, column: string) => {
      setSelectedGroupBy((prev) => {
        const exists = prev.some(
          (g) => g.table === table && g.column === column,
        );
        if (exists) {
          return prev.filter(
            (g) => !(g.table === table && g.column === column),
          );
        }
        return [...prev, { table, column }];
      });
    },
    [],
  );

  // ----- Render -----

  return (
    <div style={styles.container}>
      {/* Status Bar */}
      {statusMessage && (
        <div
          style={
            statusType === "error"
              ? styles.statusError
              : statusType === "success"
                ? styles.statusSuccess
                : styles.status
          }
        >
          {statusMessage}
        </div>
      )}

      {/* Step 1: Load Model */}
      <div style={styles.section}>
        <h4 style={styles.sectionTitle}>1. Data Model</h4>
        <button
          style={loading ? styles.buttonDisabled : styles.button}
          onClick={handleLoadModel}
          disabled={loading}
        >
          Load Model JSON...
        </button>
        {modelInfo && (
          <div style={{ fontSize: "11px", color: "#555" }}>
            <div>
              <strong>Tables:</strong>{" "}
              {modelInfo.tables.map((t) => t.name).join(", ")}
            </div>
            <div>
              <strong>Measures:</strong>{" "}
              {modelInfo.measures.map((m) => m.name).join(", ")}
            </div>
            <div>
              <strong>Relationships:</strong> {modelInfo.relationships.length}
            </div>
          </div>
        )}
      </div>

      {/* Step 2: Connect */}
      <div style={styles.section}>
        <h4 style={styles.sectionTitle}>2. Database Connection</h4>
        <input
          style={styles.input}
          type="text"
          placeholder="Connection string..."
          value={connectionString}
          onChange={(e) => setConnectionString(e.target.value)}
          disabled={!modelInfo || loading}
        />
        <button
          style={
            !modelInfo || loading ? styles.buttonDisabled : styles.button
          }
          onClick={handleConnect}
          disabled={!modelInfo || loading}
        >
          {connected ? "Reconnect" : "Connect"}
        </button>
        {connected && (
          <div style={styles.statusSuccess}>Connected</div>
        )}
      </div>

      {/* Step 3: Bind Tables */}
      <div style={styles.section}>
        <h4 style={styles.sectionTitle}>3. Bind Tables</h4>
        {bindings.map((b, idx) => (
          <div key={b.modelTable} style={styles.bindRow}>
            <span style={{ minWidth: "80px", fontWeight: 500 }}>
              {b.modelTable}
            </span>
            <input
              style={styles.smallInput}
              value={b.schema}
              onChange={(e) =>
                handleBindingChange(idx, "schema", e.target.value)
              }
              placeholder="Schema"
              disabled={!connected || loading}
            />
            <span style={{ color: "#999" }}>.</span>
            <input
              style={styles.smallInput}
              value={b.sourceTable}
              onChange={(e) =>
                handleBindingChange(idx, "sourceTable", e.target.value)
              }
              placeholder="Table"
              disabled={!connected || loading}
            />
          </div>
        ))}
        <button
          style={
            !connected || loading || bindings.length === 0
              ? styles.buttonDisabled
              : styles.button
          }
          onClick={handleBindTables}
          disabled={!connected || loading || bindings.length === 0}
        >
          Bind All Tables
        </button>
        {tablesBound && (
          <div style={styles.statusSuccess}>All tables bound</div>
        )}
      </div>

      {/* Step 4: Query */}
      <div style={styles.section}>
        <h4 style={styles.sectionTitle}>4. Query</h4>

        {/* Measures */}
        <div style={styles.label}>Measures:</div>
        {modelInfo?.measures.map((m) => (
          <label key={m.name} style={styles.checkboxLabel}>
            <input
              type="checkbox"
              style={styles.checkbox}
              checked={selectedMeasures.has(m.name)}
              onChange={() => toggleMeasure(m.name)}
              disabled={!tablesBound || loading}
            />
            {m.name}
            <span style={{ color: "#999", fontSize: "10px" }}>
              ({m.table})
            </span>
          </label>
        ))}

        {/* Group By */}
        <div style={{ ...styles.label, marginTop: "8px" }}>Group By:</div>
        {modelInfo?.tables.map((t: BiTableInfo) =>
          t.columns.map((c) => (
            <label
              key={`${t.name}.${c.name}`}
              style={styles.checkboxLabel}
            >
              <input
                type="checkbox"
                style={styles.checkbox}
                checked={selectedGroupBy.some(
                  (g) => g.table === t.name && g.column === c.name,
                )}
                onChange={() => toggleGroupBy(t.name, c.name)}
                disabled={!tablesBound || loading}
              />
              {t.name}.{c.name}
              <span style={{ color: "#999", fontSize: "10px" }}>
                ({c.dataType})
              </span>
            </label>
          )),
        )}

        <div style={styles.row}>
          <button
            style={
              !tablesBound || loading || selectedMeasures.size === 0
                ? styles.buttonDisabled
                : styles.buttonPrimary
            }
            onClick={handleQuery}
            disabled={!tablesBound || loading || selectedMeasures.size === 0}
          >
            Execute Query
          </button>
        </div>

        {/* Preview */}
        {queryResult && queryResult.rowCount > 0 && (
          <div>
            <div style={styles.label}>
              Preview ({queryResult.rowCount} rows):
            </div>
            <div style={styles.previewContainer}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    {queryResult.columns.map((col) => (
                      <th key={col} style={styles.th}>
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {queryResult.rows.slice(0, 20).map((row, rowIdx) => (
                    <tr key={rowIdx}>
                      {row.map((val, colIdx) => (
                        <td key={colIdx} style={styles.td}>
                          {val ?? ""}
                        </td>
                      ))}
                    </tr>
                  ))}
                  {queryResult.rowCount > 20 && (
                    <tr>
                      <td
                        colSpan={queryResult.columns.length}
                        style={{ ...styles.td, color: "#999", fontStyle: "italic" }}
                      >
                        ... and {queryResult.rowCount - 20} more rows
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Step 5: Insert & Refresh */}
      <div style={styles.section}>
        <h4 style={styles.sectionTitle}>5. Insert & Refresh</h4>
        <div style={styles.row}>
          <button
            style={
              !queryResult || loading
                ? styles.buttonDisabled
                : styles.buttonPrimary
            }
            onClick={handleInsert}
            disabled={!queryResult || loading}
          >
            Insert into Sheet
          </button>
          <button
            style={
              !inserted || loading ? styles.buttonDisabled : styles.button
            }
            onClick={handleRefresh}
            disabled={!inserted || loading}
          >
            Refresh Data
          </button>
        </div>
        {inserted && (
          <div style={{ fontSize: "11px", color: "#555" }}>
            Result is locked. Use Refresh to update. Formulas referencing
            these cells will recalculate automatically.
          </div>
        )}
      </div>
    </div>
  );
}
