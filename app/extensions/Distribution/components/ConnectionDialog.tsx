// FILENAME: app/extensions/Distribution/components/ConnectionDialog.tsx
// PURPOSE: Dialog for configuring database connection credentials for a
//          .calp package data source. Shown when SSPI auto-connect fails.

import React, { useState } from "react";
import type { DialogProps } from "@api";
import { saveDataSourceConfig, refreshData, emitAppEvent, AppEvents } from "@api";
import type { DataSourceNeedsConfig } from "@api";

export interface ConnectionDialogData {
  dataSources: DataSourceNeedsConfig[];
}

export function ConnectionDialog({ onClose, data }: DialogProps & { data?: ConnectionDialogData }) {
  const sources = data?.dataSources ?? [];
  const first = sources[0];

  const [server, setServer] = useState(first?.server ?? "");
  const [database, setDatabase] = useState(first?.database ?? "");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleConnect = async () => {
    if (!first) return;

    setError(null);
    setStatus("Connecting...");

    const connectionString = `host=${server} dbname=${database} user=${username} password=${password} sslmode=prefer`;

    try {
      await saveDataSourceConfig(first.dataSourceId, connectionString);
      setStatus("Saved. Refreshing data...");

      const result = await refreshData();

      if (result.needsConfiguration.length > 0) {
        setError("Connection saved but refresh failed. Check credentials.");
        setStatus(null);
      } else {
        emitAppEvent(AppEvents.SHEET_CHANGED, {});
        setStatus(
          `${result.sourcesRefreshed} data source(s) connected and verified`
        );
        setTimeout(() => onClose(), 1000);
      }
    } catch (err: unknown) {
      setError(String(err));
      setStatus(null);
    }
  };

  const fieldStyle: React.CSSProperties = {
    display: "flex", flexDirection: "column", gap: "4px", marginBottom: "8px",
  };
  const inputStyle: React.CSSProperties = {
    padding: "4px 6px", border: "1px solid #ccc", borderRadius: "3px", fontSize: "13px",
  };

  if (!first) {
    return (
      <div style={{ padding: "16px", width: "400px" }}>
        <h3 style={{ margin: "0 0 12px 0" }}>Configure Connection</h3>
        <p>No data sources need configuration.</p>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: "16px", width: "420px" }}>
      <h3 style={{ margin: "0 0 8px 0" }}>Configure Connection</h3>
      <p style={{ fontSize: "12px", color: "#666", margin: "0 0 12px 0" }}>
        Data source: <strong>{first.name}</strong> ({first.connectionType})
      </p>

      <div style={fieldStyle}>
        <label>Server</label>
        <input style={inputStyle} value={server} onChange={(e) => setServer(e.target.value)} />
      </div>
      <div style={fieldStyle}>
        <label>Database</label>
        <input style={inputStyle} value={database} onChange={(e) => setDatabase(e.target.value)} />
      </div>
      <div style={fieldStyle}>
        <label>Username</label>
        <input style={inputStyle} value={username} onChange={(e) => setUsername(e.target.value)}
          placeholder="Leave empty for Windows Auth" />
      </div>
      <div style={fieldStyle}>
        <label>Password</label>
        <input style={inputStyle} type="password" value={password}
          onChange={(e) => setPassword(e.target.value)} />
      </div>

      {error && <div style={{ color: "red", marginBottom: "8px", fontSize: "12px" }}>{error}</div>}
      {status && <div style={{ color: "green", marginBottom: "8px", fontSize: "12px" }}>{status}</div>}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
        <button onClick={onClose}>Cancel</button>
        <button onClick={handleConnect} style={{ fontWeight: 600 }}>Save & Connect</button>
      </div>
    </div>
  );
}
