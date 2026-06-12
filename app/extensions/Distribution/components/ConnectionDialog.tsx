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
  const [sourceIndex, setSourceIndex] = useState(0);
  const current = sources[sourceIndex];

  const [server, setServer] = useState(current?.server ?? "");
  const [database, setDatabase] = useState(current?.database ?? "");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const advanceTo = (index: number) => {
    const next = sources[index];
    setSourceIndex(index);
    setServer(next?.server ?? "");
    setDatabase(next?.database ?? "");
    setUsername("");
    setPassword("");
  };

  const handleConnect = async () => {
    if (!current) return;

    setError(null);
    setStatus("Connecting...");

    const connectionString = `host=${server} dbname=${database} user=${username} password=${password} sslmode=prefer`;

    try {
      await saveDataSourceConfig(current.dataSourceId, connectionString);
      setStatus("Saved. Refreshing data...");

      const result = await refreshData();
      const needsConfig = (id: string) =>
        result.needsConfiguration.some((s) => s.dataSourceId === id);

      if (needsConfig(current.dataSourceId)) {
        // The credentials for THIS source did not work — other sources still
        // pending configuration are not a credentials failure.
        setError("Connection saved but refresh failed. Check credentials.");
        setStatus(null);
        return;
      }

      const nextIndex = sources.findIndex(
        (s, i) => i > sourceIndex && needsConfig(s.dataSourceId)
      );
      if (nextIndex !== -1) {
        advanceTo(nextIndex);
        setStatus(`"${current.name}" connected. Configure the next data source.`);
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

  if (!current) {
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
        Data source: <strong>{current.name}</strong> ({current.connectionType})
        {sources.length > 1 ? ` — ${sourceIndex + 1} of ${sources.length}` : ""}
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
