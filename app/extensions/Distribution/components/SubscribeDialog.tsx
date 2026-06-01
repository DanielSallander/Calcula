// FILENAME: app/extensions/Distribution/components/SubscribeDialog.tsx
// PURPOSE: Dialog for subscribing to (pulling) a .calp package.

import React, { useState } from "react";
import type { DialogProps } from "@api";
import { pullPackage, emitAppEvent, AppEvents } from "@api";
import { open } from "@tauri-apps/plugin-dialog";

export function SubscribeDialog({ onClose }: DialogProps) {
  const [registryPath, setRegistryPath] = useState("");
  const [packageName, setPackageName] = useState("");
  const [versionPin, setVersionPin] = useState("latest");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleBrowse = async () => {
    try {
      const selected = await open({
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

  const handlePull = async () => {
    setError(null);
    setStatus("Pulling...");

    try {
      const result = await pullPackage({
        registryPath,
        packageName,
        versionPin,
      });

      // Notify the app that sheets have changed so UI refreshes
      emitAppEvent(AppEvents.SHEET_CHANGED, {});

      // Close the dialog after a brief moment so the user sees the result
      setTimeout(() => onClose(), 600);

      setStatus(
        `Pulled ${result.packageName} v${result.resolvedVersion}: ${result.sheetsPulled} sheet(s)`
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
      <h3 style={{ margin: "0 0 12px 0" }}>Subscribe to Package</h3>

      <div style={fieldStyle}>
        <label>Registry Path</label>
        <div style={{ display: "flex", gap: "4px" }}>
          <input style={{ ...inputStyle, flex: 1 }} value={registryPath} onChange={(e) => setRegistryPath(e.target.value)}
            placeholder="C:\shared\registry" />
          <button onClick={handleBrowse} style={{ whiteSpace: "nowrap" }}>Browse...</button>
        </div>
      </div>
      <div style={fieldStyle}>
        <label>Package Name</label>
        <input style={inputStyle} value={packageName} onChange={(e) => setPackageName(e.target.value)}
          placeholder="sales-report" />
      </div>
      <div style={fieldStyle}>
        <label>Version Pin</label>
        <input style={inputStyle} value={versionPin} onChange={(e) => setVersionPin(e.target.value)} />
        <span style={{ fontSize: "11px", color: "#888" }}>
          Examples: =1.2.3, ^1.0, ~1.2, latest
        </span>
      </div>

      {error && <div style={{ color: "red", marginBottom: "8px", fontSize: "12px" }}>{error}</div>}
      {status && <div style={{ color: "green", marginBottom: "8px", fontSize: "12px" }}>{status}</div>}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
        <button onClick={onClose}>Cancel</button>
        <button onClick={handlePull} style={{ fontWeight: 600 }}>Subscribe</button>
      </div>
    </div>
  );
}
