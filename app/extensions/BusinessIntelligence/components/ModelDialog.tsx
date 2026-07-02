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
  addTaskPaneContextKey,
  getPivotStoreService,
} from "@api";
import { pivot } from "@api/pivot";
import type { BiPivotModelInfo } from "@api/pivot";
import { createConnection, connect, getModelInfo } from "../../_shared/lib/bi-api";
import { CONNECTIONS_PANE_ID } from "../manifest";
import type { BiModelInfo, ConnectionInfo } from "../types";

/** Convert BiModelInfo to BiPivotModelInfo (for pivot field list). */
function toBiPivotModelInfo(
  info: BiModelInfo,
  connectionId: string,
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
      aggregation: "sum" as const,
    })),
    hierarchies: info.hierarchies,
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
  // "file": browse to a .json (interchange). "paste": inline model JSON — the
  // model is embedded from the start; no file identity (models live in the
  // workbook / in packages, files are import/export).
  const [modelSource, setModelSource] = useState<"file" | "paste">("file");
  const [modelJsonText, setModelJsonText] = useState("");
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
    if (modelSource === "file" && !modelPath) return;
    if (modelSource === "paste" && !modelJsonText.trim()) return;

    try {
      setLoading(true);
      setError("");

      let modelJson: unknown;
      if (modelSource === "paste") {
        try {
          modelJson = JSON.parse(modelJsonText);
        } catch (err) {
          setError(`Model JSON does not parse: ${err}`);
          setLoading(false);
          return;
        }
      }

      const conn = await createConnection(
        modelSource === "paste"
          ? { name: connectionName, connectionString, modelJson }
          : { name: connectionName, connectionString, modelPath },
      );

      // Establish the database connection immediately so it shows as "Connected"
      const connectedConn = await connect(conn.id);
      setCreatedConnection(connectedConn);

      // Fetch model info for display
      const info = await getModelInfo(conn.id);
      setModelInfo(info);
    } catch (err) {
      setError(`Failed to create connection: ${err}`);
    } finally {
      setLoading(false);
    }
  }, [connectionName, connectionString, modelPath, modelSource, modelJsonText]);

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
        destinationSheet: gridState.sheetContext?.activeSheetIndex,
        connectionId: createdConnection.id,
      });

      const pivotId = response.pivotId;
      window.dispatchEvent(new Event("grid:refresh"));

      const biModel = toBiPivotModelInfo(modelInfo, createdConnection.id);

      // Open the Pivot editor pane via the IoC service registered by the
      // Pivot extension (extensions must not import each other directly).
      getPivotStoreService()?.openBiPivotEditor(pivotId, biModel);

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
  // One predicate for BOTH the Create button's style and disabled prop —
  // per-source: file mode needs a path, paste mode needs non-empty JSON.
  const createDisabled =
    (modelSource === "file" ? !modelPath : !modelJsonText.trim()) ||
    !connectionName ||
    loading;

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

          {/* Model source: file (interchange) or pasted JSON (embedded) */}
          <div style={dialogStyles.section}>
            <span style={dialogStyles.label}>Data Model</span>
            <div style={{ display: "flex", gap: "12px", fontSize: "12px", marginBottom: "4px" }}>
              <label>
                <input
                  type="radio"
                  checked={modelSource === "file"}
                  onChange={() => setModelSource("file")}
                  disabled={hasConnection}
                />{" "}
                From file
              </label>
              <label>
                <input
                  type="radio"
                  checked={modelSource === "paste"}
                  onChange={() => setModelSource("paste")}
                  disabled={hasConnection}
                />{" "}
                Paste model JSON
              </label>
            </div>
            {modelSource === "file" ? (
              <>
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
              </>
            ) : (
              <textarea
                style={{
                  ...dialogStyles.input,
                  minHeight: "96px",
                  fontFamily: "monospace",
                  fontSize: "11px",
                }}
                placeholder='{"formatVersion": "1", "model": { ... }} or a raw DataModel'
                value={modelJsonText}
                onChange={(e) => setModelJsonText(e.target.value)}
                disabled={hasConnection}
              />
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
                createDisabled ? dialogStyles.buttonDisabled : dialogStyles.buttonPrimary
              }
              onClick={handleCreateConnection}
              disabled={createDisabled}
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
