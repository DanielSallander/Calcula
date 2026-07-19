// FILENAME: app/extensions/Distribution/components/PublishDialog.tsx
// PURPOSE: Floating window for publishing selected sheets to a registry, with
// a transparency report: preview (dry-run) before publishing, and the actual
// included/excluded report after — no silent drops.
// CONTEXT: Deliberately NOT a modal: there is no backdrop, so the workbook
// stays fully interactive while the window is open (inspect sheets, check
// indices, tweak cells mid-publish). Movable + resizable via the shared
// @api/dialogWindow hook; closes only via its own buttons (dismissOnEscape
// is false in the manifest).

import React, { useState } from "react";
import type { DialogProps } from "@api";
import { publishPackage, publishPreview } from "@api";
import type { PublishReport } from "@api";
import { listPackageKinds } from "@api/packageKinds";
import { useDialogWindow } from "@api/dialogWindow";
import { open as openNativeDialog } from "@tauri-apps/plugin-dialog";
import { PublishReportView } from "./PackageExplorerPanel";

export function PublishDialog({ onClose }: DialogProps) {
  const win = useDialogWindow({ minWidth: 440, minHeight: 360 });

  const [registryPath, setRegistryPath] = useState("");
  const [packageName, setPackageName] = useState("");
  const [version, setVersion] = useState("1.0.0");
  const [kind, setKind] = useState("report");
  const [publishedBy, setPublishedBy] = useState("");
  const [sheetIndices, setSheetIndices] = useState("0");
  const [includeComments, setIncludeComments] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<PublishReport | null>(null);
  const [reportLabel, setReportLabel] = useState<string>("");
  const [warnings, setWarnings] = useState<string[]>([]);

  const parseIndices = () =>
    sheetIndices
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !Number.isNaN(n));

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

  const handlePreview = async () => {
    setError(null);
    setStatus("Analyzing…");
    try {
      const result = await publishPreview(parseIndices(), includeComments);
      setReport(result.report);
      setReportLabel(`Preview — would publish ${result.sheetNames.join(", ")}`);
      setWarnings(result.warnings);
      setStatus(null);
    } catch (err: unknown) {
      setError(String(err));
      setStatus(null);
    }
  };

  const handlePublish = async () => {
    setError(null);
    setStatus("Publishing...");

    try {
      const result = await publishPackage({
        registryPath,
        packageName,
        version,
        kind,
        sheetIndices: parseIndices(),
        publishedBy,
        includeComments,
      });
      setStatus(
        `Published ${result.packageName} v${result.version}: ${result.sheetsPublished} sheet(s)`
      );
      setReport(result.report);
      setReportLabel(`Published ${result.packageName} v${result.version}`);
      setWarnings(result.warnings);
    } catch (err: unknown) {
      setError(String(err));
      setStatus(null);
    }
  };

  const windowStyle: React.CSSProperties = {
    position: "fixed",
    left: "50%",
    top: "10%",
    transform: "translateX(-50%)",
    width: "480px",
    maxHeight: "82vh",
    zIndex: 1050,
    display: "flex",
    flexDirection: "column",
    background: "var(--panel-bg)",
    color: "var(--text-primary)",
    border: "1px solid var(--border-default)",
    borderRadius: "8px",
    boxShadow: "0 12px 40px rgba(0, 0, 0, 0.5)",
    fontFamily: '"Segoe UI", system-ui, sans-serif',
    fontSize: "13px",
  };
  const headerStyle: React.CSSProperties = {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "8px 12px",
    flexShrink: 0,
    cursor: "grab",
    userSelect: "none",
    borderBottom: "1px solid var(--border-default)",
  };
  const closeButtonStyle: React.CSSProperties = {
    background: "transparent",
    border: "none",
    color: "var(--text-secondary)",
    cursor: "pointer",
    padding: "2px 8px",
    borderRadius: "4px",
    fontSize: "14px",
    lineHeight: 1,
  };
  const bodyStyle: React.CSSProperties = {
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
    padding: "12px 16px",
  };
  const footerStyle: React.CSSProperties = {
    display: "flex",
    justifyContent: "flex-end",
    gap: "8px",
    padding: "10px 16px",
    flexShrink: 0,
    borderTop: "1px solid var(--border-default)",
  };
  const fieldStyle: React.CSSProperties = {
    display: "flex", flexDirection: "column", gap: "4px", marginBottom: "8px",
  };
  const inputStyle: React.CSSProperties = {
    padding: "4px 6px",
    border: "1px solid var(--border-default)",
    borderRadius: "3px",
    fontSize: "13px",
    background: "var(--bg-surface)",
    color: "var(--text-primary)",
  };

  return (
    <div ref={win.ref} style={{ ...windowStyle, ...win.style }}>
      <div style={headerStyle} onMouseDown={win.onHeaderMouseDown}>
        <span style={{ fontWeight: 600 }}>Publish Package</span>
        <button style={closeButtonStyle} onClick={onClose} aria-label="Close" title="Close">
          ✕
        </button>
      </div>

      <div style={bodyStyle}>
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
            placeholder="sales-report" />
        </div>
        <div style={fieldStyle}>
          <label>Version</label>
          <input style={inputStyle} value={version} onChange={(e) => setVersion(e.target.value)} />
        </div>
        <div style={fieldStyle}>
          <label>Kind</label>
          <select style={inputStyle} value={kind} onChange={(e) => setKind(e.target.value)}>
            {listPackageKinds().map((k) => (
              <option key={k.id} value={k.id} title={k.description}>
                {k.label}
              </option>
            ))}
          </select>
        </div>
        <div style={fieldStyle}>
          <label>Sheet Indices (comma-separated; empty = all sheets)</label>
          <input style={inputStyle} value={sheetIndices} onChange={(e) => setSheetIndices(e.target.value)}
            placeholder="0, 1 — or leave empty for every sheet" />
        </div>
        <div style={fieldStyle}>
          <label>Published By</label>
          <input style={inputStyle} value={publishedBy} onChange={(e) => setPublishedBy(e.target.value)}
            placeholder="your-name@company.com" />
        </div>
        <div style={{ ...fieldStyle, flexDirection: "row", alignItems: "center", gap: "6px" }}>
          <input
            id="publish-include-comments"
            type="checkbox"
            checked={includeComments}
            onChange={(e) => setIncludeComments(e.target.checked)}
          />
          <label htmlFor="publish-include-comments" style={{ cursor: "pointer" }}>
            Include comments (threaded discussions stay private unless checked)
          </label>
        </div>

        {error && <div style={{ color: "var(--text-error, #d33)", marginBottom: "8px", fontSize: "12px" }}>{error}</div>}
        {status && <div style={{ color: "green", marginBottom: "8px", fontSize: "12px" }}>{status}</div>}

        {warnings.length > 0 && (
          <div style={{
            fontSize: "12px", margin: "8px 0", padding: "6px 8px",
            backgroundColor: "#fff3cd", borderRadius: 4, color: "#664d03",
          }}>
            <strong>Warnings ({warnings.length})</strong> — the package publishes
            as-is; these only degrade for subscribers.
            {warnings.map((w, i) => (
              <div key={i} style={{ marginLeft: 8, marginTop: 4 }}>{w}</div>
            ))}
          </div>
        )}

        {report && (
          <div style={{ margin: "8px 0", padding: "8px", border: "1px solid var(--border-default)",
            borderRadius: "3px", fontSize: "12px" }}>
            <div style={{ fontWeight: 600, marginBottom: "4px" }}>{reportLabel}</div>
            <PublishReportView report={report} />
          </div>
        )}
      </div>

      <div style={footerStyle}>
        <button onClick={onClose}>Cancel</button>
        <button onClick={handlePreview}>Preview</button>
        <button onClick={handlePublish} style={{ fontWeight: 600 }}>Publish</button>
      </div>

      {win.resizeHandles}
    </div>
  );
}
