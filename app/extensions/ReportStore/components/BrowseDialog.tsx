//! FILENAME: app/extensions/ReportStore/components/BrowseDialog.tsx
// PURPOSE: Browse and import packages from registered providers.

import React, { useState, useCallback, useEffect } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { DialogProps } from "@api/uiTypes";
import type { PackageInfo, RegistryProvider } from "@api/distribution";
import {
  getRegistryProviders,
  getRegistryProvider,
  browsePackages,
  parsePackageInfo,
} from "@api/distribution";
import { DialogExtensions } from "@api";
import { BINDING_DIALOG_ID } from "../manifest";
import { PackageCard } from "./PackageCard";

/** Shared input style for text inputs and selects */
const inputStyle: React.CSSProperties = {
  padding: "6px 10px",
  border: "1px solid #ccc",
  borderRadius: 4,
  backgroundColor: "#fff",
  color: "#222",
  fontSize: 13,
  outline: "none",
};

/** Shared style for secondary (outline) buttons */
const secondaryBtnStyle: React.CSSProperties = {
  padding: "6px 16px",
  border: "1px solid #bbb",
  borderRadius: 4,
  backgroundColor: "#fff",
  color: "#333",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

/** Shared style for primary (blue) buttons */
const primaryBtnStyle: React.CSSProperties = {
  padding: "6px 16px",
  border: "none",
  borderRadius: 4,
  backgroundColor: "#0078d4",
  color: "#fff",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

export const BrowseDialog: React.FC<DialogProps> = ({ isOpen, onClose }) => {
  const [packages, setPackages] = useState<PackageInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchText, setSearchText] = useState("");
  const [selectedProvider, setSelectedProvider] = useState<string>("");
  const [directoryPath, setDirectoryPath] = useState("");
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);

  const providers = getRegistryProviders();

  const handleBrowseFile = useCallback(async () => {
    try {
      const path = await open({
        filters: [
          { name: "Calcula Package", extensions: ["calp"] },
          { name: "All Files", extensions: ["*"] },
        ],
        multiple: false,
        directory: false,
      });
      if (path && typeof path === "string") {
        setLoading(true);
        setError(null);
        setSelectedFilePath(path);
        setSelectedProvider("");
        setDirectoryPath("");
        const info = await parsePackageInfo(path);
        setPackages([info]);
        setLoading(false);
      }
    } catch (err) {
      setError(String(err));
      setLoading(false);
    }
  }, []);

  const handleBrowseDirectory = useCallback(async () => {
    if (!directoryPath.trim()) return;
    setLoading(true);
    setError(null);
    setSelectedFilePath(null);
    try {
      const results = await browsePackages(directoryPath.trim());
      setPackages(results);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [directoryPath]);

  const handleProviderSearch = useCallback(async () => {
    const provider = providers.find((p) => p.id === selectedProvider);
    if (!provider) return;
    setLoading(true);
    setError(null);
    setSelectedFilePath(null);
    try {
      const result = await provider.search({
        text: searchText,
        offset: 0,
        limit: 50,
      });
      setPackages(result.packages);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [selectedProvider, searchText, providers]);

  const handleImport = useCallback(
    (pkg: PackageInfo) => {
      if (selectedProvider) {
        DialogExtensions.openDialog(BINDING_DIALOG_ID, {
          package: pkg,
          providerId: selectedProvider,
        });
      } else if (selectedFilePath) {
        DialogExtensions.openDialog(BINDING_DIALOG_ID, {
          package: pkg,
          filePath: selectedFilePath,
        });
      } else {
        DialogExtensions.openDialog(BINDING_DIALOG_ID, {
          package: pkg,
          sourcePath: directoryPath,
        });
      }
    },
    [directoryPath, selectedProvider, selectedFilePath]
  );

  if (!isOpen) return null;

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
        zIndex: 10000,
      }}
      onClick={onClose}
    >
      <div
        style={{
          backgroundColor: "#fff",
          borderRadius: 8,
          width: 800,
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
            padding: "14px 20px",
            borderBottom: "1px solid #e0e0e0",
            backgroundColor: "#f7f7f7",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#222" }}>
            Import Package
          </h2>
          <button
            onClick={onClose}
            style={{
              cursor: "pointer",
              background: "none",
              border: "none",
              fontSize: 20,
              fontWeight: "bold",
              color: "#666",
              lineHeight: 1,
            }}
          >
            X
          </button>
        </div>

        {/* Browse Section */}
        <div style={{ padding: "14px 20px", borderBottom: "1px solid #e0e0e0" }}>
          {/* Row 1: Open file button */}
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10 }}>
            <button
              onClick={handleBrowseFile}
              disabled={loading}
              style={{
                ...primaryBtnStyle,
                padding: "8px 20px",
                fontSize: 13,
                cursor: loading ? "default" : "pointer",
              }}
            >
              Open .calp File...
            </button>
            <span style={{ color: "#999", fontSize: 12 }}>
              Browse to a specific package file
            </span>
          </div>

          {/* Divider */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "6px 0 10px" }}>
            <div style={{ flex: 1, height: 1, backgroundColor: "#e0e0e0" }} />
            <span style={{ color: "#999", fontSize: 11, textTransform: "uppercase", letterSpacing: 1 }}>
              or search
            </span>
            <div style={{ flex: 1, height: 1, backgroundColor: "#e0e0e0" }} />
          </div>

          {/* Row 2: Provider search */}
          {providers.length > 0 && (
            <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
              <select
                value={selectedProvider}
                onChange={(e) => setSelectedProvider(e.target.value)}
                style={{ ...inputStyle, flex: "0 0 200px" }}
              >
                <option value="">Select provider...</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <input
                type="text"
                placeholder="Search packages..."
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleProviderSearch()}
                style={{ ...inputStyle, flex: 1 }}
              />
              <button
                onClick={handleProviderSearch}
                disabled={!selectedProvider || loading}
                style={{
                  ...secondaryBtnStyle,
                  opacity: !selectedProvider || loading ? 0.5 : 1,
                  cursor: !selectedProvider || loading ? "default" : "pointer",
                }}
              >
                Search
              </button>
            </div>
          )}

          {/* Row 3: Folder scan */}
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="text"
              placeholder="Folder path (e.g. C:\Packages)..."
              value={directoryPath}
              onChange={(e) => { setDirectoryPath(e.target.value); setSelectedFilePath(null); }}
              onKeyDown={(e) => e.key === "Enter" && handleBrowseDirectory()}
              style={{ ...inputStyle, flex: 1 }}
            />
            <button
              onClick={handleBrowseDirectory}
              disabled={!directoryPath.trim() || loading}
              style={{
                ...secondaryBtnStyle,
                opacity: !directoryPath.trim() || loading ? 0.5 : 1,
                cursor: !directoryPath.trim() || loading ? "default" : "pointer",
              }}
            >
              {loading ? "Loading..." : "Scan Folder"}
            </button>
          </div>
        </div>

        {/* Results */}
        <div style={{ flex: 1, overflow: "auto", padding: "14px 20px", minHeight: 200 }}>
          {error && (
            <div
              style={{
                color: "#c00",
                backgroundColor: "#fff0f0",
                border: "1px solid #fcc",
                borderRadius: 4,
                padding: "8px 12px",
                marginBottom: 10,
                fontSize: 13,
              }}
            >
              {error}
            </div>
          )}
          {loading && (
            <div style={{ textAlign: "center", color: "#888", padding: 40 }}>
              Loading...
            </div>
          )}
          {packages.length === 0 && !loading && !error && (
            <div style={{ textAlign: "center", color: "#999", padding: 40, fontSize: 13 }}>
              Open a .calp file, scan a folder, or search a registry to find packages.
            </div>
          )}
          {!loading && packages.map((pkg) => (
            <PackageCard key={`${pkg.id}@${pkg.version}`} pkg={pkg} onImport={handleImport} />
          ))}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "10px 20px",
            borderTop: "1px solid #e0e0e0",
            backgroundColor: "#f7f7f7",
            display: "flex",
            justifyContent: "flex-end",
          }}
        >
          <button
            onClick={onClose}
            style={{
              ...secondaryBtnStyle,
              padding: "6px 20px",
            }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
