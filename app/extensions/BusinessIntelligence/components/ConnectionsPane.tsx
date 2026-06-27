//! FILENAME: app/extensions/BusinessIntelligence/components/ConnectionsPane.tsx
// PURPOSE: Workbook Connections task pane — lists all BI connections with
//          status, actions, and ability to create pivot tables from them.
// CONTEXT: Opened from Data > Connections menu item. Excel-style connection manager.

import React, { useState, useCallback, useEffect } from "react";
import type { TaskPaneViewProps } from "@api";
import {
  useGridState,
  columnToLetter,
  getPivotStoreService,
  DialogExtensions,
} from "@api";
import { pivot } from "@api/pivot";
import type { BiPivotModelInfo } from "@api/pivot";
import {
  getConnections,
  connect,
  disconnect,
  deleteConnection,
  refreshConnection,
  getModelInfo,
  updateConnection,
} from "../../_shared/lib/bi-api";
import type { ConnectionInfo, BiModelInfo } from "../types";

const MODEL_DIALOG_ID = "bi:modelDialog";

// ============================================================================
// Helpers
// ============================================================================

/** Convert BiModelInfo (from BI connection) to BiPivotModelInfo (for pivot field list). */
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

const styles = {
  container: {
    display: "flex",
    flexDirection: "column" as const,
    height: "100%",
    overflow: "auto",
    padding: "12px",
    fontSize: "13px",
    fontFamily: "Segoe UI, sans-serif",
    gap: "12px",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    paddingBottom: "8px",
    borderBottom: "1px solid #e0e0e0",
  },
  headerTitle: {
    fontWeight: 600 as const,
    fontSize: "14px",
    color: "#333",
    margin: 0,
  },
  addButton: {
    padding: "4px 12px",
    fontSize: "12px",
    border: "1px solid #0078d4",
    borderRadius: "3px",
    background: "#0078d4",
    color: "#fff",
    cursor: "pointer",
  },
  emptyState: {
    textAlign: "center" as const,
    color: "#888",
    padding: "32px 16px",
    fontSize: "13px",
    lineHeight: "1.6",
  },
  connectionCard: {
    border: "1px solid #e0e0e0",
    borderRadius: "4px",
    padding: "10px 12px",
    background: "#fff",
  },
  connectionCardHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "6px",
  },
  connectionName: {
    fontWeight: 600 as const,
    fontSize: "13px",
    color: "#333",
  },
  statusBadge: {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    fontSize: "11px",
    padding: "2px 8px",
    borderRadius: "10px",
  },
  statusConnected: {
    background: "#e8f5e9",
    color: "#2e7d32",
  },
  statusDisconnected: {
    background: "#f5f5f5",
    color: "#888",
  },
  statusDot: {
    width: "6px",
    height: "6px",
    borderRadius: "50%",
    display: "inline-block",
  },
  connectionMeta: {
    fontSize: "11px",
    color: "#666",
    lineHeight: "1.5",
  },
  connectionActions: {
    display: "flex",
    gap: "6px",
    marginTop: "8px",
    flexWrap: "wrap" as const,
  },
  actionButton: {
    padding: "4px 12px",
    fontSize: "11px",
    border: "1px solid #8a8a8a",
    borderRadius: "3px",
    background: "#f0f0f0",
    color: "#333",
    cursor: "pointer",
    whiteSpace: "nowrap" as const,
    fontWeight: 500 as const,
  },
  actionButtonPrimary: {
    padding: "3px 10px",
    fontSize: "11px",
    border: "1px solid #0078d4",
    borderRadius: "3px",
    background: "#0078d4",
    color: "#fff",
    cursor: "pointer",
    whiteSpace: "nowrap" as const,
  },
  actionButtonDanger: {
    padding: "3px 10px",
    fontSize: "11px",
    border: "1px solid #d32f2f",
    borderRadius: "3px",
    background: "#fff",
    color: "#d32f2f",
    cursor: "pointer",
    whiteSpace: "nowrap" as const,
  },
  actionButtonDisabled: {
    padding: "3px 10px",
    fontSize: "11px",
    border: "1px solid #ddd",
    borderRadius: "3px",
    background: "#f5f5f5",
    color: "#999",
    cursor: "not-allowed" as const,
    whiteSpace: "nowrap" as const,
  },
  statusMessage: {
    fontSize: "11px",
    padding: "4px 0",
  },
  statusError: {
    color: "#d32f2f",
  },
  statusSuccess: {
    color: "#2e7d32",
  },
  statusInfo: {
    color: "#666",
  },
};

// ============================================================================
// Component
// ============================================================================

export function ConnectionsPane(
  _props: TaskPaneViewProps,
): React.ReactElement {
  const gridState = useGridState();
  const [connections, setConnections] = useState<ConnectionInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState("");
  const [statusType, setStatusType] = useState<"info" | "error" | "success">(
    "info",
  );

  const setStatus = useCallback(
    (msg: string, type: "info" | "error" | "success" = "info") => {
      setStatusMessage(msg);
      setStatusType(type);
    },
    [],
  );

  const loadConnections = useCallback(async () => {
    try {
      const conns = await getConnections();
      setConnections(conns);
    } catch (err) {
      setStatus(`Failed to load connections: ${err}`, "error");
    }
  }, [setStatus]);

  // Load connections on mount
  useEffect(() => {
    loadConnections();
  }, [loadConnections]);

  const handleAddConnection = useCallback(() => {
    DialogExtensions.openDialog(MODEL_DIALOG_ID);
  }, []);

  const handleConnect = useCallback(
    async (connectionId: string) => {
      try {
        // If the connection has no database URL (e.g., embedded from a package),
        // either auto-connect (Integrated) or prompt for credentials.
        const conn = connections.find((c) => c.id === connectionId);
        if (conn && !conn.connectionString && conn.preferredAuth !== "Integrated") {
          const server = conn.server || "localhost";
          const db = conn.database || "mydb";
          // Backend will resolve the OS username as default;
          // user only provides the password
          const password = window.prompt(
            `Connect to ${conn.name}\n` +
            `Server: ${server}\n` +
            `Database: ${db}\n\n` +
            `Enter password:`,
          );
          if (password === null) return; // cancelled
          await updateConnection({ id: connectionId, connectionString: `__PASSWORD_ONLY__:${password}` });
          await loadConnections();
        }
        // For Integrated auth with no connection string, bi_connect handles it
        // using server/database from the model + AuthMethod::Integrated

        setLoadingId(connectionId);
        setStatus("Connecting...");
        await connect(connectionId);
        setStatus("Connected", "success");
        await loadConnections();
      } catch (err) {
        setStatus(`Connection failed: ${err}`, "error");
      } finally {
        setLoadingId(null);
      }
    },
    [connections, loadConnections, setStatus],
  );

  const handleDisconnect = useCallback(
    async (connectionId: string) => {
      try {
        setLoadingId(connectionId);
        await disconnect(connectionId);
        setStatus("Disconnected", "info");
        await loadConnections();
      } catch (err) {
        setStatus(`Disconnect failed: ${err}`, "error");
      } finally {
        setLoadingId(null);
      }
    },
    [loadConnections, setStatus],
  );

  const handleRefresh = useCallback(
    async (connectionId: string) => {
      try {
        setLoadingId(connectionId);
        setStatus("Refreshing...");

        // Try refreshing active queries (BI grid queries)
        let queryCount = 0;
        let totalRows = 0;
        try {
          const results = await refreshConnection(connectionId);
          queryCount = results.length;
          totalRows = results.reduce((sum, r) => sum + r.rowCount, 0);
        } catch {
          // No active queries — that's OK if there are pivots
        }

        // Also refresh any BI pivots connected to this connection
        let pivotCount = 0;
        try {
          const allPivots = await pivot.getAll();
          for (const p of allPivots) {
            try {
              await pivot.refreshCache(p.id);
              pivotCount++;
            } catch {
              // Individual pivot refresh failure is non-fatal
            }
          }
        } catch {
          // Pivot refresh errors are non-fatal
        }

        if (queryCount > 0 || pivotCount > 0) {
          const parts = [];
          if (queryCount > 0) parts.push(`${queryCount} queries (${totalRows} rows)`);
          if (pivotCount > 0) parts.push(`${pivotCount} pivot table(s)`);
          setStatus(`Refreshed ${parts.join(" + ")}`, "success");
        } else {
          setStatus("No queries or pivot tables to refresh.", "info");
        }

        window.dispatchEvent(new Event("grid:refresh"));
        await loadConnections();
      } catch (err) {
        setStatus(`Refresh failed: ${err}`, "error");
      } finally {
        setLoadingId(null);
      }
    },
    [loadConnections, setStatus],
  );

  const handleDelete = useCallback(
    async (connectionId: string, connectionName: string) => {
      if (
        !window.confirm(
          `Delete connection "${connectionName}"? This will also remove any associated BI regions.`,
        )
      ) {
        return;
      }
      try {
        setLoadingId(connectionId);
        await deleteConnection(connectionId);
        setStatus(`Connection "${connectionName}" deleted`, "info");
        await loadConnections();
      } catch (err) {
        setStatus(`Delete failed: ${err}`, "error");
      } finally {
        setLoadingId(null);
      }
    },
    [loadConnections, setStatus],
  );

  const handleNewPivot = useCallback(
    async (connectionId: string) => {
      try {
        setLoadingId(connectionId);
        setStatus("Creating pivot table...");

        const modelInfo = await getModelInfo(connectionId);
        if (!modelInfo) {
          setStatus("No model loaded for this connection.", "error");
          return;
        }

        const sel = gridState.selection;
        const row = sel ? sel.startRow : 0;
        const col = sel ? sel.startCol : 0;
        const cellAddress = `${columnToLetter(col)}${row + 1}`;

        const response = await pivot.createFromBiModel({
          destinationCell: cellAddress,
          destinationSheet: gridState.sheetContext?.activeSheetIndex,
          connectionId,
        });

        const pivotId = response.pivotId;
        window.dispatchEvent(new Event("grid:refresh"));

        const biModel = toBiPivotModelInfo(modelInfo, connectionId);

        // Open the Pivot editor pane via the IoC service registered by the
        // Pivot extension (extensions must not import each other directly).
        getPivotStoreService()?.openBiPivotEditor(pivotId, biModel);

        setStatus(`Pivot table created from connection`, "success");
      } catch (err) {
        setStatus(`Failed to create pivot: ${err}`, "error");
      } finally {
        setLoadingId(null);
      }
    },
    [gridState, setStatus],
  );

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <h4 style={styles.headerTitle}>Workbook Connections</h4>
        <button style={styles.addButton} onClick={handleAddConnection}>
          Add Connection
        </button>
      </div>

      {/* Status */}
      {statusMessage && (
        <div
          style={{
            ...styles.statusMessage,
            ...(statusType === "error"
              ? styles.statusError
              : statusType === "success"
                ? styles.statusSuccess
                : styles.statusInfo),
          }}
        >
          {statusMessage}
        </div>
      )}

      {/* Connection List */}
      {connections.length === 0 ? (
        <div style={styles.emptyState}>
          No connections.
          <br />
          Click "Add Connection" or use
          <br />
          Data &gt; Get Data to add one.
        </div>
      ) : (
        connections.map((conn) => {
          const isLoading = loadingId === conn.id;
          const statusStyle = conn.isConnected
            ? styles.statusConnected
            : styles.statusDisconnected;

          return (
            <div key={conn.id} style={styles.connectionCard}>
              {/* Card Header */}
              <div style={styles.connectionCardHeader}>
                <span style={styles.connectionName}>{conn.name}</span>
                <span style={{ ...styles.statusBadge, ...statusStyle }}>
                  <span
                    style={{
                      ...styles.statusDot,
                      background: conn.isConnected ? "#4caf50" : "#bbb",
                    }}
                  />
                  {conn.isConnected ? "Connected" : "Disconnected"}
                </span>
              </div>

              {/* Metadata */}
              <div style={styles.connectionMeta}>
                <div>
                  <strong>Type:</strong> {conn.connectionType}
                </div>
                {(conn.server || conn.database) && (
                  <div>
                    {conn.server && <><strong>Server:</strong> {conn.server} </>}
                    {conn.database && <><strong>Database:</strong> {conn.database}</>}
                  </div>
                )}
                {conn.tableCount > 0 && (
                  <div>
                    <strong>Tables:</strong> {conn.tableCount} |{" "}
                    <strong>Measures:</strong> {conn.measureCount}
                  </div>
                )}
                {conn.description && (
                  <div>
                    <strong>Description:</strong> {conn.description}
                  </div>
                )}
                {conn.lastRefreshed && (
                  <div>
                    <strong>Last refreshed:</strong>{" "}
                    {new Date(conn.lastRefreshed).toLocaleString()}
                  </div>
                )}
              </div>

              {/* Actions */}
              <div style={styles.connectionActions}>
                {conn.isConnected ? (
                  <button
                    style={
                      isLoading
                        ? styles.actionButtonDisabled
                        : styles.actionButton
                    }
                    onClick={() => handleDisconnect(conn.id)}
                    disabled={isLoading}
                  >
                    Disconnect
                  </button>
                ) : (
                  <button
                    style={
                      isLoading
                        ? styles.actionButtonDisabled
                        : styles.actionButton
                    }
                    onClick={() => handleConnect(conn.id)}
                    disabled={isLoading}
                  >
                    Connect
                  </button>
                )}
                <button
                  style={
                    isLoading
                      ? styles.actionButtonDisabled
                      : styles.actionButton
                  }
                  onClick={() => handleRefresh(conn.id)}
                  disabled={isLoading}
                >
                  Refresh
                </button>
                <button
                  style={
                    isLoading
                      ? styles.actionButtonDisabled
                      : styles.actionButtonPrimary
                  }
                  onClick={() => handleNewPivot(conn.id)}
                  disabled={isLoading}
                >
                  New PivotTable
                </button>
                <button
                  style={
                    isLoading
                      ? styles.actionButtonDisabled
                      : styles.actionButtonDanger
                  }
                  onClick={() => handleDelete(conn.id, conn.name)}
                  disabled={isLoading}
                >
                  Delete
                </button>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
