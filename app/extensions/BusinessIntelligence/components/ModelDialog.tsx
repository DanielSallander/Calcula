//! FILENAME: app/extensions/BusinessIntelligence/components/ModelDialog.tsx
// PURPOSE: Dialog for creating a BI connection and optionally a pivot table.
// CONTEXT: Opened from Data > Get Data > Calcula Model menu item.
//          Creates a named Connection, then offers to create a pivot from it.

import React, { useState, useCallback } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { DialogProps } from "@api";
import {
  useGridState,
  columnToLetter,
  openTaskPane,
  clearTaskPaneManuallyClosed,
  addTaskPaneContextKey,
} from "@api";
import { pivot } from "@api/pivot";
import { createConnection, getModelInfo } from "../lib/bi-api";
import { PIVOT_PANE_ID } from "../../Pivot/manifest";
import { CONNECTIONS_PANE_ID } from "../manifest";
import {
  ensureDesignTabRegistered,
  setJustCreatedPivot,
} from "../../Pivot/handlers/selectionHandler";
import type { BiModelInfo, ConnectionInfo } from "../types";
import type { PivotEditorViewData } from "../../Pivot/types";
import type { BiPivotModelInfo } from "../../Pivot/lib/pivot-api";

/** Convert BiModelInfo to BiPivotModelInfo (for pivot field list). */
function toBiPivotModelInfo(
  info: BiModelInfo,
  connectionId: number,
): BiPivotModelInfo {
  const numericTypes = new Set([
    "integer",
    "int",
    "bigint",
    "float",
    "double",
    "decimal",
    "numeric",
    "real",
    "smallint",
  ]);
  return {
    connectionId,
    tables: info.tables.map((t) => ({
      name: t.name,
      columns: t.columns.map((c) => ({
        name: c.name,
        dataType: c.dataType,
        isNumeric: numericTypes.has(c.dataType.toLowerCase()),
      })),
    })),
    measures: info.measures.map((m) => ({
      name: m.name,
      table: m.table,
      sourceColumn: "",
      aggregation: "",
    })),
  };
}

// ============================================================================
// Styles
// ============================================================================

const dialogStyles = {
  overlay: {
    position: "fixed" as const,
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
    boxShadow: "0 8px 32px rgba(0,0,0,0.2)",
    width: "420px",
    maxHeight: "80vh",
    overflow: "auto",
    fontFamily: "Segoe UI, sans-serif",
    fontSize: "13px",
  },
  header: {
    padding: "16px 20px 12px",
    borderBottom: "1px solid #e0e0e0",
    fontWeight: 600 as const,
    fontSize: "15px",
    color: "#333",
  },
  body: {
    padding: "16px 20px",
    display: "flex",
    flexDirection: "column" as const,
    gap: "14px",
  },
  section: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "6px",
  },
  label: {
    fontSize: "12px",
    fontWeight: 500 as const,
    color: "#555",
  },
  input: {
    padding: "6px 10px",
    fontSize: "12px",
    border: "1px solid #ccc",
    borderRadius: "3px",
    width: "100%",
    boxSizing: "border-box" as const,
  },
  modelSummary: {
    padding: "8px 12px",
    background: "#f0f7ff",
    borderRadius: "4px",
    fontSize: "12px",
    color: "#333",
    lineHeight: "1.5",
  },
  button: {
    padding: "6px 16px",
    fontSize: "12px",
    border: "1px solid #8a8a8a",
    borderRadius: "3px",
    background: "#f0f0f0",
    color: "#333",
    cursor: "pointer",
  },
  buttonPrimary: {
    padding: "8px 20px",
    fontSize: "13px",
    border: "1px solid #0078d4",
    borderRadius: "3px",
    background: "#0078d4",
    color: "#fff",
    cursor: "pointer",
    fontWeight: 500 as const,
  },
  buttonDisabled: {
    padding: "8px 20px",
    fontSize: "13px",
    border: "1px solid #ccc",
    borderRadius: "3px",
    background: "#e0e0e0",
    color: "#999",
    cursor: "not-allowed" as const,
  },
  footer: {
    padding: "12px 20px",
    borderTop: "1px solid #e0e0e0",
    display: "flex",
    justifyContent: "flex-end",
    gap: "8px",
  },
  statusError: {
    fontSize: "11px",
    color: "#d32f2f",
  },
  statusSuccess: {
    fontSize: "11px",
    color: "#2e7d32",
  },
  filePath: {
    fontSize: "11px",
    color: "#666",
    wordBreak: "break-all" as const,
  },
};

// ============================================================================
// Component
// ============================================================================

export function ModelDialog({
  isOpen,
  onClose,
}: DialogProps): React.ReactElement | null {
  const gridState = useGridState();

  const [connectionName, setConnectionName] = useState("My Connection");
  const [connectionString, setConnectionString] = useState(
    "postgresql://postgres:postgres@localhost:5432/Adventureworks",
  );
  const [modelPath, setModelPath] = useState("");
  const [modelInfo, setModelInfo] = useState<BiModelInfo | null>(null);
  const [createdConnection, setCreatedConnection] =
    useState<ConnectionInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleBrowseModel = useCallback(async () => {
    try {
      const path = await open({
        filters: [{ name: "Data Model", extensions: ["json"] }],
        multiple: false,
        directory: false,
      });
      if (!path || typeof path !== "string") return;

      setModelPath(path);
      setError("");

      // Extract name from filename for connection name suggestion
      const fileName = path.split(/[\\/]/).pop()?.replace(/\.json$/i, "") ?? "";
      if (fileName && connectionName === "My Connection") {
        setConnectionName(fileName);
      }
    } catch (err) {
      setError(`Failed to browse: ${err}`);
    }
  }, [connectionName]);

  const handleCreateConnection = useCallback(async () => {
    if (!modelPath) return;

    try {
      setLoading(true);
      setError("");

      const conn = await createConnection({
        name: connectionName,
        connectionString,
        modelPath,
      });

      setCreatedConnection(conn);

      // Fetch model info for display
      const info = await getModelInfo(conn.id);
      setModelInfo(info);
    } catch (err) {
      setError(`Failed to create connection: ${err}`);
    } finally {
      setLoading(false);
    }
  }, [connectionName, connectionString, modelPath]);

  const handleInsertPivot = useCallback(async () => {
    if (!createdConnection || !modelInfo) return;

    try {
      setLoading(true);
      setError("");

      const sel = gridState.selection;
      const row = sel ? sel.startRow : 0;
      const col = sel ? sel.startCol : 0;
      const cellAddress = `${columnToLetter(col)}${row + 1}`;

      const response = await pivot.createFromBiModel({
        destinationCell: cellAddress,
        destinationSheet: gridState.sheetContext?.activeSheet,
        connectionId: createdConnection.id,
      });

      const pivotId = response.pivotId;
      window.dispatchEvent(new Event("grid:refresh"));

      const biModel = toBiPivotModelInfo(modelInfo, createdConnection.id);

      clearTaskPaneManuallyClosed(PIVOT_PANE_ID);
      addTaskPaneContextKey("pivot");
      ensureDesignTabRegistered();

      const paneData: PivotEditorViewData = {
        pivotId,
        sourceFields: [],
        initialRows: [],
        initialColumns: [],
        initialValues: [],
        initialFilters: [],
        initialLayout: {},
        biModel,
      };
      openTaskPane(
        PIVOT_PANE_ID,
        paneData as unknown as Record<string, unknown>,
      );
      setJustCreatedPivot(true);

      onClose();
    } catch (err) {
      setError(`Failed to create pivot: ${err}`);
    } finally {
      setLoading(false);
    }
  }, [createdConnection, modelInfo, gridState, onClose]);

  const handleOpenConnections = useCallback(() => {
    addTaskPaneContextKey("connections");
    openTaskPane(CONNECTIONS_PANE_ID);
    onClose();
  }, [onClose]);

  if (!isOpen) return null;

  const sel = gridState.selection;
  const destRow = sel ? sel.startRow : 0;
  const destCol = sel ? sel.startCol : 0;
  const destCell = `${columnToLetter(destCol)}${destRow + 1}`;

  const hasConnection = createdConnection !== null;

  return (
    <div style={dialogStyles.overlay} onClick={onClose}>
      <div style={dialogStyles.dialog} onClick={(e) => e.stopPropagation()}>
        <div style={dialogStyles.header}>Get Data - Calcula Model</div>

        <div style={dialogStyles.body}>
          {/* Connection Name */}
          <div style={dialogStyles.section}>
            <span style={dialogStyles.label}>Connection Name</span>
            <input
              style={dialogStyles.input}
              type="text"
              placeholder="My Connection"
              value={connectionName}
              onChange={(e) => setConnectionName(e.target.value)}
              disabled={hasConnection}
            />
          </div>

          {/* Model File */}
          <div style={dialogStyles.section}>
            <span style={dialogStyles.label}>Data Model</span>
            <button
              style={
                loading || hasConnection
                  ? dialogStyles.buttonDisabled
                  : dialogStyles.button
              }
              onClick={handleBrowseModel}
              disabled={loading || hasConnection}
            >
              {modelPath ? "Change Model..." : "Browse..."}
            </button>
            {modelPath && (
              <div style={dialogStyles.filePath}>{modelPath}</div>
            )}
          </div>

          {/* Connection String */}
          <div style={dialogStyles.section}>
            <span style={dialogStyles.label}>Connection String</span>
            <input
              style={dialogStyles.input}
              type="text"
              placeholder="postgresql://user:pass@host:5432/db"
              value={connectionString}
              onChange={(e) => setConnectionString(e.target.value)}
              disabled={hasConnection}
            />
          </div>

          {/* Connection Created Summary */}
          {hasConnection && modelInfo && (
            <div style={dialogStyles.modelSummary}>
              <div style={dialogStyles.statusSuccess}>
                Connection "{createdConnection.name}" created
              </div>
              <div>
                <strong>Tables:</strong>{" "}
                {modelInfo.tables.map((t) => t.name).join(", ")}
              </div>
              <div>
                <strong>Measures:</strong>{" "}
                {modelInfo.measures.map((m) => m.name).join(", ")}
              </div>
              <div>
                <strong>Relationships:</strong>{" "}
                {modelInfo.relationships.length}
              </div>
            </div>
          )}

          {/* Destination */}
          {hasConnection && (
            <div style={dialogStyles.section}>
              <span style={dialogStyles.label}>
                Destination: Cell {destCell}
              </span>
            </div>
          )}

          {/* Error */}
          {error && <div style={dialogStyles.statusError}>{error}</div>}
        </div>

        <div style={dialogStyles.footer}>
          <button style={dialogStyles.button} onClick={onClose}>
            Cancel
          </button>

          {!hasConnection ? (
            <button
              style={
                !modelPath || !connectionName || loading
                  ? dialogStyles.buttonDisabled
                  : dialogStyles.buttonPrimary
              }
              onClick={handleCreateConnection}
              disabled={!modelPath || !connectionName || loading}
            >
              {loading ? "Creating..." : "Create Connection"}
            </button>
          ) : (
            <>
              <button
                style={dialogStyles.button}
                onClick={handleOpenConnections}
              >
                Open Connections
              </button>
              <button
                style={
                  loading
                    ? dialogStyles.buttonDisabled
                    : dialogStyles.buttonPrimary
                }
                onClick={handleInsertPivot}
                disabled={loading}
              >
                {loading ? "Creating..." : "Insert PivotTable"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
