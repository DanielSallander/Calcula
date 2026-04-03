//! FILENAME: app/extensions/ReportStore/components/BindingDialog.tsx
// PURPOSE: Dialog for mapping package data sources to local data targets.

import React, { useState, useCallback } from "react";
import type { DialogProps } from "@api/uiTypes";
import type {
  PackageInfo,
  DataSourceDeclaration,
  ImportBinding,
} from "@api/distribution";
import { importPackage, getRegistryProvider } from "@api/distribution";

const selectStyle: React.CSSProperties = {
  padding: "6px 10px",
  border: "1px solid #ccc",
  borderRadius: 4,
  backgroundColor: "#fff",
  color: "#222",
  fontSize: 13,
};

const inputStyle: React.CSSProperties = {
  padding: "6px 10px",
  border: "1px solid #ccc",
  borderRadius: 4,
  backgroundColor: "#fff",
  color: "#222",
  fontSize: 13,
};

interface BindingEntry {
  source: DataSourceDeclaration;
  binding: ImportBinding;
}

export const BindingDialog: React.FC<DialogProps> = ({ isOpen, onClose, data }) => {
  const pkg = data?.package as PackageInfo | undefined;
  const sourcePath = data?.sourcePath as string | undefined;
  const providerId = data?.providerId as string | undefined;
  const filePath = data?.filePath as string | undefined;

  const [sheetConflict, setSheetConflict] = useState<"rename" | "replace" | "skip">("rename");
  const [tableConflict, setTableConflict] = useState<"rename" | "replace" | "skip">("rename");
  const [bindings, setBindings] = useState<BindingEntry[]>(() =>
    (pkg?.dataSources ?? []).map((source) => ({
      source,
      binding: {
        sourceId: source.id,
        internalRef: source.internalRef,
        targetType: source.type === "table" ? "table" as const : "range" as const,
        tableName: "",
      },
    }))
  );
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const updateBinding = useCallback(
    (index: number, updates: Partial<ImportBinding>) => {
      setBindings((prev) => {
        const next = [...prev];
        next[index] = {
          ...next[index],
          binding: { ...next[index].binding, ...updates },
        };
        return next;
      });
    },
    []
  );

  const handleImport = useCallback(async () => {
    if (!pkg) return;
    if (!sourcePath && !providerId && !filePath) return;
    setImporting(true);
    setError(null);

    try {
      let packagePath: string;

      if (providerId) {
        const provider = getRegistryProvider(providerId);
        if (!provider) {
          throw new Error(`Registry provider "${providerId}" not found`);
        }
        packagePath = await provider.fetchPackage(pkg.id, pkg.version);
      } else if (filePath) {
        packagePath = filePath;
      } else {
        packagePath = `${sourcePath}\\${pkg.id.replace(/\./g, "-")}-${pkg.version}.calp`;
      }

      const result = await importPackage({
        path: packagePath,
        sheetConflict,
        tableConflict,
        bindings: bindings.map((b) => b.binding),
      });

      console.log("[ReportStore] Import complete:", result);

      // Full reload to pick up new sheets, styles, tables, and cell data.
      // This matches the pattern used by File > Open.
      window.location.reload();
    } catch (err) {
      setError(String(err));
    } finally {
      setImporting(false);
    }
  }, [pkg, sourcePath, providerId, filePath, sheetConflict, tableConflict, bindings, onClose]);

  if (!isOpen || !pkg) return null;

  const displayName = pkg.name || pkg.id || "Unnamed Package";
  const contentSummary = pkg.contents.map((c) => `${c.name} (${c.type})`).join(", ");

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
        backgroundColor: "rgba(0,0,0,0.45)",
        zIndex: 10001,
      }}
      onClick={onClose}
    >
      <div
        style={{
          backgroundColor: "#fff",
          borderRadius: 8,
          width: 700,
          maxHeight: "80vh",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 8px 32px rgba(0,0,0,0.25)",
          color: "#222",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            padding: "16px 20px",
            borderBottom: "1px solid #e0e0e0",
            backgroundColor: "#f7f7f7",
          }}
        >
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#222" }}>
            Import Package
          </h2>
          <div style={{ marginTop: 8, display: "flex", alignItems: "baseline", gap: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: "#333" }}>{displayName}</span>
            <span style={{ fontSize: 12, color: "#777" }}>v{pkg.version}</span>
          </div>
          {pkg.description && (
            <div style={{ fontSize: 12, color: "#666", marginTop: 4 }}>{pkg.description}</div>
          )}
          {contentSummary && (
            <div style={{ fontSize: 12, color: "#888", marginTop: 4 }}>
              Contents: {contentSummary}
            </div>
          )}
        </div>

        {/* Conflict Resolution */}
        <div style={{ padding: "14px 20px", borderBottom: "1px solid #e0e0e0" }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#333", marginBottom: 10 }}>
            Conflict Resolution
          </div>
          <div style={{ display: "flex", gap: 24, fontSize: 13 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ color: "#555" }}>Sheet conflict:</span>
              <select
                value={sheetConflict}
                onChange={(e) => setSheetConflict(e.target.value as typeof sheetConflict)}
                style={selectStyle}
              >
                <option value="rename">Rename</option>
                <option value="replace">Replace</option>
                <option value="skip">Skip</option>
              </select>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ color: "#555" }}>Table conflict:</span>
              <select
                value={tableConflict}
                onChange={(e) => setTableConflict(e.target.value as typeof tableConflict)}
                style={selectStyle}
              >
                <option value="rename">Rename</option>
                <option value="replace">Replace</option>
                <option value="skip">Skip</option>
              </select>
            </div>
          </div>
        </div>

        {/* Data source bindings */}
        <div style={{ flex: 1, overflow: "auto", padding: "14px 20px" }}>
          {bindings.length === 0 ? (
            <div style={{ color: "#888", textAlign: "center", padding: 30, fontSize: 13 }}>
              This package has no data source requirements. Click Import to proceed.
            </div>
          ) : (
            <>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#333", marginBottom: 10 }}>
                Data Source Bindings
              </div>
              {bindings.map((entry, index) => (
                <div
                  key={entry.source.id}
                  style={{
                    border: "1px solid #e0e0e0",
                    borderRadius: 6,
                    padding: "12px 16px",
                    marginBottom: 8,
                    backgroundColor: "#fafafa",
                  }}
                >
                  <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4, color: "#222" }}>
                    {entry.source.name}
                  </div>
                  {entry.source.description && (
                    <div style={{ fontSize: 12, color: "#666", marginBottom: 8 }}>
                      {entry.source.description}
                    </div>
                  )}
                  <div style={{ fontSize: 12, color: "#888", marginBottom: 8 }}>
                    Expected columns:{" "}
                    {entry.source.columns
                      .map((c) => `${c.name} (${c.type}${c.required ? ", required" : ""})`)
                      .join(", ")}
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <select
                      value={entry.binding.targetType}
                      onChange={(e) =>
                        updateBinding(index, { targetType: e.target.value as "table" | "range" })
                      }
                      style={selectStyle}
                    >
                      <option value="table">Table</option>
                      <option value="range">Range</option>
                    </select>
                    {entry.binding.targetType === "table" ? (
                      <input
                        type="text"
                        placeholder="Table name..."
                        value={entry.binding.tableName ?? ""}
                        onChange={(e) => updateBinding(index, { tableName: e.target.value })}
                        style={{ ...inputStyle, flex: 1 }}
                      />
                    ) : (
                      <>
                        <input
                          type="text"
                          placeholder="Sheet name..."
                          value={entry.binding.sheetName ?? ""}
                          onChange={(e) => updateBinding(index, { sheetName: e.target.value })}
                          style={{ ...inputStyle, flex: 1 }}
                        />
                        <input
                          type="text"
                          placeholder="Range (e.g. A1:G100)"
                          style={{ ...inputStyle, flex: 1 }}
                        />
                      </>
                    )}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "12px 20px",
            borderTop: "1px solid #e0e0e0",
            backgroundColor: "#f7f7f7",
            display: "flex",
            justifyContent: "flex-end",
            alignItems: "center",
            gap: 8,
          }}
        >
          {error && (
            <div
              style={{
                flex: 1,
                color: "#c00",
                backgroundColor: "#fff0f0",
                border: "1px solid #fcc",
                borderRadius: 4,
                padding: "6px 10px",
                fontSize: 13,
              }}
            >
              {error}
            </div>
          )}
          <button
            onClick={onClose}
            disabled={importing}
            style={{
              padding: "6px 20px",
              border: "1px solid #bbb",
              borderRadius: 4,
              backgroundColor: "#fff",
              color: "#333",
              fontSize: 13,
              fontWeight: 600,
              cursor: importing ? "default" : "pointer",
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleImport}
            disabled={importing}
            style={{
              backgroundColor: importing ? "#5ca3d9" : "#0078d4",
              color: "#fff",
              border: "none",
              padding: "6px 20px",
              borderRadius: 4,
              fontSize: 13,
              fontWeight: 600,
              cursor: importing ? "wait" : "pointer",
            }}
          >
            {importing ? "Importing..." : "Import"}
          </button>
        </div>
      </div>
    </div>
  );
};
