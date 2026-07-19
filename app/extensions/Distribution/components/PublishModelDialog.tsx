// FILENAME: app/extensions/Distribution/components/PublishModelDialog.tsx
// PURPOSE: Publish a single BI model as a model-only .calp package (kind
// "dataset", zero sheets) — the signed, versioned distribution unit for
// models, replacing hand-carried .json files.

import React, { useEffect, useState } from "react";
import type { DialogProps, ConnectionInfo } from "@api";
import { biGetConnections, publishModel } from "@api";
import { open as openNativeDialog } from "@tauri-apps/plugin-dialog";

export function PublishModelDialog({ onClose }: DialogProps) {
  const [connections, setConnections] = useState<ConnectionInfo[]>([]);
  const [connectionId, setConnectionId] = useState("");
  const [registryPath, setRegistryPath] = useState("");
  const [packageName, setPackageName] = useState("");
  const [version, setVersion] = useState("1.0.0");
  const [publishedBy, setPublishedBy] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const conns = await biGetConnections();
        setConnections(conns);
        if (conns.length > 0) setConnectionId(conns[0].id);
      } catch (err: unknown) {
        setError(String(err));
      }
    })();
  }, []);

  // Native folder picker for the registry destination.
  const handleBrowse = async () => {
    try {
      const selected = await openNativeDialog({
        directory: true,
        multiple: false,
        title: "Select Registry Folder",
      });
      if (selected && typeof selected === "string") {
        setRegistryPath(selected);
      }
    } catch {
      // user cancelled
    }
  };

  const handlePublish = async () => {
    setError(null);
    setStatus("Publishing model...");
    try {
      const result = await publishModel({
        registryPath,
        packageName,
        version,
        publishedBy,
        connectionId,
      });
      setStatus(
        `Published ${result.packageName} v${result.version} (dataset package — model schema only)`
      );
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

  return (
    <div style={{ padding: "16px", width: "420px" }}>
      <h3 style={{ margin: "0 0 4px 0" }}>Publish Model as Package</h3>
      <div style={{ fontSize: "12px", opacity: 0.7, marginBottom: "12px" }}>
        Publishes the model schema only — no data and no credentials leave this
        machine. Subscribers connect with their own credentials, so row-level
        security still applies.
      </div>

      <div style={fieldStyle}>
        <label>Model (BI connection)</label>
        <select
          style={inputStyle}
          value={connectionId}
          onChange={(e) => setConnectionId(e.target.value)}
        >
          {connections.length === 0 && <option value="">No BI connections loaded</option>}
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.tableCount} tables, {c.measureCount} measures)
            </option>
          ))}
        </select>
      </div>
      <div style={fieldStyle}>
        <label>Registry Path</label>
        <div style={{ display: "flex", gap: "4px" }}>
          <input style={{ ...inputStyle, flex: 1 }} value={registryPath}
            onChange={(e) => setRegistryPath(e.target.value)}
            placeholder="C:\shared\registry" />
          <button onClick={handleBrowse} style={{ whiteSpace: "nowrap" }}>Browse...</button>
        </div>
      </div>
      <div style={fieldStyle}>
        <label>Package Name</label>
        <input style={inputStyle} value={packageName} onChange={(e) => setPackageName(e.target.value)}
          placeholder="sales-model" />
      </div>
      <div style={fieldStyle}>
        <label>Version</label>
        <input style={inputStyle} value={version} onChange={(e) => setVersion(e.target.value)} />
      </div>
      <div style={fieldStyle}>
        <label>Published By</label>
        <input style={inputStyle} value={publishedBy} onChange={(e) => setPublishedBy(e.target.value)}
          placeholder="your-name@company.com" />
      </div>

      {error && <div style={{ color: "red", marginBottom: "8px", fontSize: "12px" }}>{error}</div>}
      {status && <div style={{ color: "green", marginBottom: "8px", fontSize: "12px" }}>{status}</div>}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
        <button onClick={onClose}>Close</button>
        <button
          onClick={handlePublish}
          style={{ fontWeight: 600 }}
          disabled={!connectionId || !registryPath || !packageName}
        >
          Publish Model
        </button>
      </div>
    </div>
  );
}
