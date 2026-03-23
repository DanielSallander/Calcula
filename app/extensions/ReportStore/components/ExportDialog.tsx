//! FILENAME: app/extensions/ReportStore/components/ExportDialog.tsx
// PURPOSE: Dialog for exporting selected objects as a .calp package, with optional publish to registry.

import React, { useState, useCallback, useEffect } from "react";
import type { DialogProps } from "../../../src/api/uiTypes";
import {
  exportAsPackage,
  publishPackage,
  getRegistryProviders,
} from "../../../src/api/distribution";
import { getSheets } from "../../../src/api";
import { getAllTables, type Table } from "../../../src/api/backend";
import { save } from "@tauri-apps/plugin-dialog";

// ─── Shared styles ──────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  padding: "6px 10px",
  marginTop: 4,
  borderRadius: 4,
  border: "1px solid #bbb",
  backgroundColor: "#fff",
  color: "#222",
  fontSize: 13,
  boxSizing: "border-box",
};

const labelStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
  color: "#444",
  display: "block",
};

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  textTransform: "uppercase" as const,
  letterSpacing: "0.5px",
  color: "#666",
  marginBottom: 8,
};

const checkboxRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "5px 0",
  fontSize: 13,
  color: "#222",
  cursor: "pointer",
};

// ─── Types for content selection ────────────────────────────────────────────

interface SheetEntry {
  index: number;
  name: string;
  selected: boolean;
}

interface TableEntry {
  id: number;
  name: string;
  sheetIndex: number;
  sheetName: string;
  selected: boolean;
}

// ─── Component ──────────────────────────────────────────────────────────────

export const ExportDialog: React.FC<DialogProps> = ({ isOpen, onClose, data }) => {
  // Package metadata
  const [packageId, setPackageId] = useState("");
  const [packageName, setPackageName] = useState("");
  const [version, setVersion] = useState("1.0.0");
  const [description, setDescription] = useState("");
  const [author, setAuthor] = useState("");
  const [tags, setTags] = useState("");
  const [outputPath, setOutputPath] = useState("");

  // Content selection
  const [sheets, setSheets] = useState<SheetEntry[]>([]);
  const [tables, setTables] = useState<TableEntry[]>([]);
  const [loadingContent, setLoadingContent] = useState(true);

  // State
  const [exporting, setExporting] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [exportedFilePath, setExportedFilePath] = useState<string | null>(null);

  // Publish options
  const [publishAfterExport, setPublishAfterExport] = useState(false);
  const [selectedRegistryUrl, setSelectedRegistryUrl] = useState("");
  const [customRegistryUrl, setCustomRegistryUrl] = useState("");
  const [authToken, setAuthToken] = useState("");

  const providers = getRegistryProviders();

  // Pre-selected sheet index from menu action
  const initialSheetIndex = ((data?.sheetIndices as number[]) ?? [0])[0];

  // Load sheets and tables on open
  useEffect(() => {
    if (!isOpen) return;
    setLoadingContent(true);
    setError(null);
    setSuccessMessage(null);
    setExportedFilePath(null);

    Promise.all([getSheets(), getAllTables()])
      .then(([sheetsResult, tablesResult]) => {
        const sheetEntries: SheetEntry[] = sheetsResult.sheets
          .filter((s) => !s.hidden)
          .map((s) => ({
            index: s.index,
            name: s.name,
            selected: s.index === initialSheetIndex,
          }));
        setSheets(sheetEntries);

        const sheetNameMap = new Map(sheetsResult.sheets.map((s) => [s.index, s.name]));
        const tableEntries: TableEntry[] = tablesResult.map((t: Table) => ({
          id: t.id,
          name: t.name,
          sheetIndex: t.sheetIndex,
          sheetName: sheetNameMap.get(t.sheetIndex) ?? `Sheet ${t.sheetIndex + 1}`,
          selected: false,
        }));
        setTables(tableEntries);
      })
      .catch((err) => setError(`Failed to load workbook contents: ${String(err)}`))
      .finally(() => setLoadingContent(false));
  }, [isOpen, initialSheetIndex]);

  const toggleSheet = useCallback((index: number) => {
    setSheets((prev) =>
      prev.map((s) => (s.index === index ? { ...s, selected: !s.selected } : s))
    );
  }, []);

  const toggleTable = useCallback((id: number) => {
    setTables((prev) =>
      prev.map((t) => (t.id === id ? { ...t, selected: !t.selected } : t))
    );
  }, []);

  const selectedSheetCount = sheets.filter((s) => s.selected).length;
  const selectedTableCount = tables.filter((t) => t.selected).length;
  const totalSelected = selectedSheetCount + selectedTableCount;

  const effectiveRegistryUrl =
    selectedRegistryUrl === "__custom__" ? customRegistryUrl : selectedRegistryUrl;

  const handleExport = useCallback(async () => {
    if (!packageId.trim() || !packageName.trim()) {
      setError("Package ID and name are required.");
      return;
    }
    if (!outputPath.trim()) {
      setError("Output path is required.");
      return;
    }
    if (totalSelected === 0) {
      setError("Select at least one sheet or table to export.");
      return;
    }
    if (publishAfterExport && !effectiveRegistryUrl) {
      setError("Select a registry to publish to, or uncheck the publish option.");
      return;
    }

    setExporting(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const filePath = await exportAsPackage({
        outputPath: outputPath.trim(),
        id: packageId.trim(),
        name: packageName.trim(),
        version: version.trim() || "1.0.0",
        description: description.trim(),
        author: author.trim(),
        tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
        sheetIndices: sheets.filter((s) => s.selected).map((s) => s.index),
        tableIds: tables.filter((t) => t.selected).map((t) => t.id),
        filePaths: [],
        dataSources: [],
      });

      setExportedFilePath(filePath);

      if (publishAfterExport && effectiveRegistryUrl) {
        setExporting(false);
        setPublishing(true);
        try {
          const result = await publishPackage(
            filePath,
            effectiveRegistryUrl,
            authToken.trim() || undefined
          );
          setSuccessMessage(`Package exported and published! ${result.message}`);
        } catch (pubErr) {
          setSuccessMessage(null);
          setError(`Export succeeded, but publish failed: ${String(pubErr)}`);
          return;
        } finally {
          setPublishing(false);
        }
      } else {
        setSuccessMessage("Package exported successfully!");
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setExporting(false);
    }
  }, [
    outputPath, packageId, packageName, version, description, author, tags,
    sheets, tables, totalSelected, publishAfterExport, effectiveRegistryUrl, authToken,
  ]);

  const handlePublishExisting = useCallback(async () => {
    if (!exportedFilePath || !effectiveRegistryUrl) return;
    setPublishing(true);
    setError(null);

    try {
      const result = await publishPackage(
        exportedFilePath,
        effectiveRegistryUrl,
        authToken.trim() || undefined
      );
      setSuccessMessage(`Published! ${result.message}`);
    } catch (err) {
      setError(`Publish failed: ${String(err)}`);
    } finally {
      setPublishing(false);
    }
  }, [exportedFilePath, effectiveRegistryUrl, authToken]);

  if (!isOpen) return null;

  const busy = exporting || publishing;

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "rgba(0,0,0,0.5)",
        zIndex: 10000,
      }}
      onClick={onClose}
    >
      <div
        style={{
          backgroundColor: "#fff",
          borderRadius: 8,
          width: 680,
          maxHeight: "85vh",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
          color: "#222",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Header ─────────────────────────────────────────────────── */}
        <div
          style={{
            padding: "16px 24px",
            borderBottom: "1px solid #ddd",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            backgroundColor: "#f7f7f7",
          }}
        >
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Export as Package</h2>
          <button
            onClick={onClose}
            style={{
              cursor: "pointer",
              background: "none",
              border: "none",
              fontSize: 20,
              fontWeight: "bold",
              color: "#666",
              padding: "4px 8px",
              borderRadius: 4,
              lineHeight: 1,
            }}
            title="Close"
          >
            X
          </button>
        </div>

        {/* ── Scrollable body ────────────────────────────────────────── */}
        <div style={{ flex: 1, overflow: "auto", padding: "20px 24px" }}>

          {/* Section: Content Selection */}
          <div style={{ marginBottom: 20 }}>
            <div style={sectionTitleStyle}>Package Contents</div>

            {loadingContent ? (
              <div style={{ color: "#888", fontSize: 13, padding: "8px 0" }}>Loading workbook contents...</div>
            ) : (
              <div style={{ display: "flex", gap: 16 }}>
                {/* Sheets column */}
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, color: "#444" }}>
                    Sheets ({selectedSheetCount}/{sheets.length})
                  </div>
                  <div
                    style={{
                      border: "1px solid #ccc",
                      borderRadius: 4,
                      maxHeight: 140,
                      overflow: "auto",
                      backgroundColor: "#f9f9f9",
                    }}
                  >
                    {sheets.length === 0 ? (
                      <div style={{ padding: 12, color: "#999", fontSize: 12 }}>No sheets</div>
                    ) : (
                      sheets.map((s) => (
                        <label
                          key={s.index}
                          style={{
                            ...checkboxRowStyle,
                            padding: "6px 10px",
                            borderBottom: "1px solid #eee",
                            backgroundColor: s.selected ? "rgba(0,120,212,0.1)" : "transparent",
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={s.selected}
                            onChange={() => toggleSheet(s.index)}
                            style={{ accentColor: "#0078d4", width: 15, height: 15 }}
                          />
                          <span>{s.name}</span>
                        </label>
                      ))
                    )}
                  </div>
                </div>

                {/* Tables column */}
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, color: "#444" }}>
                    Tables ({selectedTableCount}/{tables.length})
                  </div>
                  <div
                    style={{
                      border: "1px solid #ccc",
                      borderRadius: 4,
                      maxHeight: 140,
                      overflow: "auto",
                      backgroundColor: "#f9f9f9",
                    }}
                  >
                    {tables.length === 0 ? (
                      <div style={{ padding: 12, color: "#999", fontSize: 12 }}>No tables</div>
                    ) : (
                      tables.map((t) => (
                        <label
                          key={t.id}
                          style={{
                            ...checkboxRowStyle,
                            padding: "6px 10px",
                            borderBottom: "1px solid #eee",
                            backgroundColor: t.selected ? "rgba(0,120,212,0.1)" : "transparent",
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={t.selected}
                            onChange={() => toggleTable(t.id)}
                            style={{ accentColor: "#0078d4", width: 15, height: 15 }}
                          />
                          <div style={{ display: "flex", flexDirection: "column" }}>
                            <span>{t.name}</span>
                            <span style={{ fontSize: 11, color: "#777" }}>on {t.sheetName}</span>
                          </div>
                        </label>
                      ))
                    )}
                  </div>
                </div>
              </div>
            )}

            {totalSelected > 0 && (
              <div style={{ fontSize: 12, color: "#0078d4", marginTop: 6 }}>
                {selectedSheetCount} sheet{selectedSheetCount !== 1 ? "s" : ""}
                {selectedTableCount > 0 && `, ${selectedTableCount} table${selectedTableCount !== 1 ? "s" : ""}`}
                {" "}selected
              </div>
            )}
          </div>

          {/* Section: Package Metadata */}
          <div style={{ marginBottom: 20 }}>
            <div style={sectionTitleStyle}>Package Metadata</div>

            <div style={{ display: "flex", gap: 12, marginBottom: 10 }}>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>
                  Package ID *
                  <input
                    type="text"
                    placeholder="com.company.package-name"
                    value={packageId}
                    onChange={(e) => setPackageId(e.target.value)}
                    style={inputStyle}
                  />
                </label>
              </div>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>
                  Display Name *
                  <input
                    type="text"
                    placeholder="My Dashboard Package"
                    value={packageName}
                    onChange={(e) => setPackageName(e.target.value)}
                    style={inputStyle}
                  />
                </label>
              </div>
            </div>

            <div style={{ display: "flex", gap: 12, marginBottom: 10 }}>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>
                  Version
                  <input
                    type="text"
                    value={version}
                    onChange={(e) => setVersion(e.target.value)}
                    style={inputStyle}
                  />
                </label>
              </div>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>
                  Author
                  <input
                    type="text"
                    value={author}
                    onChange={(e) => setAuthor(e.target.value)}
                    style={inputStyle}
                  />
                </label>
              </div>
            </div>

            <label style={labelStyle}>
              Description
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                style={{ ...inputStyle, resize: "vertical" }}
              />
            </label>

            <label style={{ ...labelStyle, marginTop: 10 }}>
              Tags (comma-separated)
              <input
                type="text"
                placeholder="dashboard, sales, monthly"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                style={inputStyle}
              />
            </label>
          </div>

          {/* Section: Output */}
          <div style={{ marginBottom: 16 }}>
            <div style={sectionTitleStyle}>Output</div>
            <div style={labelStyle}>
              Save to *
              <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                <input
                  type="text"
                  placeholder="C:\Packages\my-package.calp"
                  value={outputPath}
                  onChange={(e) => setOutputPath(e.target.value)}
                  style={{ ...inputStyle, marginTop: 0, flex: 1 }}
                />
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      const defaultName = packageId
                        ? `${packageId.replace(/\./g, "-")}-${version || "1.0.0"}.calp`
                        : "package.calp";
                      const path = await save({
                        filters: [
                          { name: "Calcula Package", extensions: ["calp"] },
                          { name: "All Files", extensions: ["*"] },
                        ],
                        defaultPath: defaultName,
                      });
                      if (path) setOutputPath(path);
                    } catch {
                      // User cancelled
                    }
                  }}
                  style={{
                    padding: "6px 14px",
                    borderRadius: 4,
                    border: "1px solid #aaa",
                    backgroundColor: "#fff",
                    color: "#333",
                    fontSize: 13,
                    fontWeight: 500,
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                  }}
                >
                  Browse...
                </button>
              </div>
            </div>
          </div>

          {/* Section: Publish */}
          <div
            style={{
              borderTop: "1px solid #ddd",
              paddingTop: 16,
            }}
          >
            <div style={sectionTitleStyle}>Publish</div>

            <label style={{ ...checkboxRowStyle, marginBottom: 8 }}>
              <input
                type="checkbox"
                checked={publishAfterExport}
                onChange={(e) => setPublishAfterExport(e.target.checked)}
                style={{ accentColor: "#0078d4", width: 15, height: 15 }}
              />
              <span style={{ fontSize: 13 }}>Publish to registry after export</span>
            </label>

            {publishAfterExport && (
              <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingLeft: 24 }}>
                <label style={labelStyle}>
                  Registry
                  <select
                    value={selectedRegistryUrl}
                    onChange={(e) => setSelectedRegistryUrl(e.target.value)}
                    style={inputStyle}
                  >
                    <option value="">Select registry...</option>
                    {providers.map((p) => (
                      <option key={p.id} value={"baseUrl" in p ? (p as any).baseUrl : ""}>
                        {p.name}
                      </option>
                    ))}
                    <option value="__custom__">Custom URL...</option>
                  </select>
                </label>

                {selectedRegistryUrl === "__custom__" && (
                  <label style={labelStyle}>
                    Registry URL
                    <input
                      type="text"
                      placeholder="http://localhost:8080"
                      value={customRegistryUrl}
                      onChange={(e) => setCustomRegistryUrl(e.target.value)}
                      style={inputStyle}
                    />
                  </label>
                )}

                <label style={labelStyle}>
                  Auth token (optional)
                  <input
                    type="password"
                    value={authToken}
                    onChange={(e) => setAuthToken(e.target.value)}
                    placeholder="Bearer token for authenticated registries"
                    style={inputStyle}
                  />
                </label>
              </div>
            )}
          </div>
        </div>

        {/* ── Footer ─────────────────────────────────────────────────── */}
        <div
          style={{
            padding: "12px 24px",
            borderTop: "1px solid #ddd",
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            alignItems: "center",
            backgroundColor: "#f7f7f7",
          }}
        >
          {error && (
            <div style={{ flex: 1, color: "#c00", fontSize: 13 }}>{error}</div>
          )}
          {successMessage && (
            <div style={{ flex: 1, color: "#107c10", fontSize: 13 }}>{successMessage}</div>
          )}
          <button
            onClick={onClose}
            disabled={busy}
            style={{
              padding: "6px 16px",
              borderRadius: 4,
              border: "1px solid #aaa",
              backgroundColor: "#fff",
              color: "#333",
              cursor: busy ? "wait" : "pointer",
              fontSize: 13,
              fontWeight: 500,
            }}
          >
            {successMessage ? "Close" : "Cancel"}
          </button>
          {/* Publish button after successful local-only export */}
          {exportedFilePath && !publishing && !publishAfterExport && providers.length > 0 && (
            <button
              onClick={handlePublishExisting}
              disabled={!effectiveRegistryUrl || busy}
              style={{
                backgroundColor: "#107c10",
                color: "#fff",
                border: "none",
                padding: "6px 20px",
                borderRadius: 4,
                fontSize: 13,
                cursor: !effectiveRegistryUrl || busy ? "not-allowed" : "pointer",
              }}
            >
              Publish
            </button>
          )}
          {!successMessage && (
            <button
              onClick={handleExport}
              disabled={busy || totalSelected === 0}
              style={{
                backgroundColor: totalSelected === 0 ? "#aaa" : "#0078d4",
                color: "#fff",
                border: "none",
                padding: "6px 20px",
                borderRadius: 4,
                fontSize: 13,
                fontWeight: 500,
                cursor: busy || totalSelected === 0 ? "not-allowed" : "pointer",
              }}
            >
              {exporting
                ? "Exporting..."
                : publishing
                  ? "Publishing..."
                  : publishAfterExport
                    ? "Export & Publish"
                    : "Export"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
