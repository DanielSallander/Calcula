// FILENAME: app/extensions/Distribution/components/PublishDialog.tsx
// PURPOSE: Dialog for publishing selected sheets to a registry.

import React, { useState } from "react";
import type { DialogProps } from "@api";
import { publishPackage } from "@api";

export function PublishDialog({ onClose }: DialogProps) {
  const [registryPath, setRegistryPath] = useState("");
  const [packageName, setPackageName] = useState("");
  const [version, setVersion] = useState("1.0.0");
  const [kind, setKind] = useState("report");
  const [publishedBy, setPublishedBy] = useState("");
  const [sheetIndices, setSheetIndices] = useState("0");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handlePublish = async () => {
    setError(null);
    setStatus("Publishing...");

    try {
      const indices = sheetIndices.split(",").map((s) => parseInt(s.trim(), 10));
      const result = await publishPackage({
        registryPath,
        packageName,
        version,
        kind,
        sheetIndices: indices,
        publishedBy,
      });
      setStatus(
        `Published ${result.packageName} v${result.version}: ${result.sheetsPublished} sheet(s)`
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
    <div style={{ padding: "16px", width: "400px" }}>
      <h3 style={{ margin: "0 0 12px 0" }}>Publish Package</h3>

      <div style={fieldStyle}>
        <label>Registry Path</label>
        <input style={inputStyle} value={registryPath} onChange={(e) => setRegistryPath(e.target.value)}
          placeholder="C:\shared\registry" />
      </div>
      <div style={fieldStyle}>
        <label>Package Name</label>
        <input style={inputStyle} value={packageName} onChange={(e) => setPackageName(e.target.value)}
          placeholder="sales-report" />
      </div>
      <div style={fieldStyle}>
        <label>Version</label>
        <input style={inputStyle} value={version} onChange={(e) => setVersion(e.target.value)} />
      </div>
      <div style={fieldStyle}>
        <label>Kind</label>
        <select style={inputStyle} value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="report">Report</option>
          <option value="template">Template</option>
          <option value="dataset">Dataset</option>
        </select>
      </div>
      <div style={fieldStyle}>
        <label>Sheet Indices (comma-separated)</label>
        <input style={inputStyle} value={sheetIndices} onChange={(e) => setSheetIndices(e.target.value)}
          placeholder="0, 1" />
      </div>
      <div style={fieldStyle}>
        <label>Published By</label>
        <input style={inputStyle} value={publishedBy} onChange={(e) => setPublishedBy(e.target.value)}
          placeholder="your-name@company.com" />
      </div>

      {error && <div style={{ color: "red", marginBottom: "8px", fontSize: "12px" }}>{error}</div>}
      {status && <div style={{ color: "green", marginBottom: "8px", fontSize: "12px" }}>{status}</div>}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
        <button onClick={onClose}>Cancel</button>
        <button onClick={handlePublish} style={{ fontWeight: 600 }}>Publish</button>
      </div>
    </div>
  );
}
