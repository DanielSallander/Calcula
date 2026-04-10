// FILENAME: app/extensions/LinkedSheets/components/BrowseLinkedDialog.tsx
// PURPOSE: Consumer-side dialog to browse and link published sheets.

import React, { useState, useCallback } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { DialogProps } from "@api/uiTypes";
import {
  browsePublishedSheets,
  linkPublishedSheets,
  getPublishInfo,
  type PublishedSheetInfo,
} from "@api/linkedSheets";

const inputStyle: React.CSSProperties = {
  padding: "6px 10px",
  border: "1px solid #ccc",
  borderRadius: 4,
  backgroundColor: "#fff",
  color: "#222",
  fontSize: 13,
  outline: "none",
  width: "100%",
  boxSizing: "border-box",
};

const primaryBtnStyle: React.CSSProperties = {
  padding: "8px 20px",
  border: "none",
  borderRadius: 4,
  backgroundColor: "#0078d4",
  color: "#fff",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};

const secondaryBtnStyle: React.CSSProperties = {
  padding: "8px 20px",
  border: "1px solid #bbb",
  borderRadius: 4,
  backgroundColor: "#fff",
  color: "#333",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};

export const BrowseLinkedDialog: React.FC<DialogProps> = ({
  isOpen,
  onClose,
}) => {
  const [pubDir, setPubDir] = useState("");
  const [sheets, setSheets] = useState<PublishedSheetInfo[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [availableEnvs, setAvailableEnvs] = useState<string[]>([]);
  const [selectedEnv, setSelectedEnv] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const handleBrowseDir = useCallback(async () => {
    const path = await open({
      multiple: false,
      directory: true,
      title: "Select Publication Directory",
    });
    if (path && typeof path === "string") {
      setPubDir(path);
      loadSheets(path);
    }
  }, []);

  const loadSheets = useCallback(async (dir: string) => {
    setLoading(true);
    setError(null);
    setSheets([]);
    setSelectedIds(new Set());
    setAvailableEnvs([]);
    setSelectedEnv("");

    try {
      const results = await browsePublishedSheets(dir);
      setSheets(results);

      // Also load manifest to get environment info
      const manifest = await getPublishInfo(dir);
      if (manifest?.environments && manifest.environments.length > 0) {
        setAvailableEnvs(manifest.environments);
        setSelectedEnv(manifest.environments[0]);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const toggleSheet = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleLink = useCallback(async () => {
    if (!pubDir || selectedIds.size === 0) return;

    setLinking(true);
    setError(null);
    setResult(null);

    try {
      const res = await linkPublishedSheets(
        pubDir,
        Array.from(selectedIds),
        selectedEnv || undefined
      );
      setResult(
        `Linked ${res.linkedSheetNames.length} sheet(s): ${res.linkedSheetNames.join(", ")}`
      );
      setSelectedIds(new Set());
      window.location.reload();
    } catch (e) {
      setError(String(e));
    } finally {
      setLinking(false);
    }
  }, [pubDir, selectedIds, selectedEnv]);

  if (!isOpen) return null;

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: "rgba(0,0,0,0.4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 10000,
      }}
      onClick={onClose}
    >
      <div
        style={{
          backgroundColor: "#fff",
          borderRadius: 8,
          padding: 24,
          width: 520,
          maxHeight: "80vh",
          overflow: "auto",
          boxShadow: "0 8px 32px rgba(0,0,0,0.2)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 style={{ margin: "0 0 16px", fontSize: 18 }}>
          Link Sheets from Published Source
        </h2>

        {/* Publication directory */}
        <div style={{ marginBottom: 16 }}>
          <label
            style={{
              display: "block",
              fontSize: 12,
              color: "#666",
              marginBottom: 4,
            }}
          >
            Publication Directory
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              style={{ ...inputStyle, flex: 1 }}
              value={pubDir}
              onChange={(e) => setPubDir(e.target.value)}
              placeholder="Path to publication directory..."
            />
            <button style={secondaryBtnStyle} onClick={handleBrowseDir}>
              Browse
            </button>
          </div>
          {pubDir && !loading && sheets.length === 0 && !error && (
            <button
              style={{
                ...secondaryBtnStyle,
                marginTop: 8,
                fontSize: 12,
                padding: "4px 12px",
              }}
              onClick={() => loadSheets(pubDir)}
            >
              Load Published Sheets
            </button>
          )}
        </div>

        {/* Loading */}
        {loading && (
          <div style={{ padding: 16, textAlign: "center", color: "#888" }}>
            Loading published sheets...
          </div>
        )}

        {/* Environment selection */}
        {availableEnvs.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <label
              style={{
                display: "block",
                fontSize: 12,
                color: "#666",
                marginBottom: 4,
              }}
            >
              Environment (for database connections)
            </label>
            <select
              style={{ ...inputStyle, width: "auto", minWidth: 200 }}
              value={selectedEnv}
              onChange={(e) => setSelectedEnv(e.target.value)}
            >
              {availableEnvs.map((env) => (
                <option key={env} value={env}>
                  {env}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Sheet list */}
        {sheets.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <label
              style={{
                display: "block",
                fontSize: 12,
                color: "#666",
                marginBottom: 8,
              }}
            >
              Available Sheets ({sheets.length})
            </label>
            {sheets.map((sheet) => (
              <div
                key={sheet.id}
                style={{
                  padding: "10px 12px",
                  border: "1px solid #e0e0e0",
                  borderRadius: 4,
                  marginBottom: 6,
                  backgroundColor: selectedIds.has(sheet.id)
                    ? "#f0f7ff"
                    : "#fff",
                  cursor: "pointer",
                }}
                onClick={() => toggleSheet(sheet.id)}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selectedIds.has(sheet.id)}
                    onChange={() => toggleSheet(sheet.id)}
                    onClick={(e) => e.stopPropagation()}
                  />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 500 }}>{sheet.name}</div>
                    {sheet.description && (
                      <div style={{ fontSize: 12, color: "#888", marginTop: 2 }}>
                        {sheet.description}
                      </div>
                    )}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: "#888",
                      textAlign: "right",
                    }}
                  >
                    <div>v{sheet.version}</div>
                    <div>{new Date(sheet.publishedAt).toLocaleDateString()}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Status messages */}
        {error && (
          <div
            style={{
              padding: 8,
              backgroundColor: "#fff0f0",
              color: "#c00",
              borderRadius: 4,
              fontSize: 12,
              marginBottom: 12,
            }}
          >
            {error}
          </div>
        )}
        {result && (
          <div
            style={{
              padding: 8,
              backgroundColor: "#f0fff0",
              color: "#060",
              borderRadius: 4,
              fontSize: 12,
              marginBottom: 12,
            }}
          >
            {result}
          </div>
        )}

        {/* Buttons */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button style={secondaryBtnStyle} onClick={onClose}>
            Close
          </button>
          <button
            style={{
              ...primaryBtnStyle,
              opacity:
                selectedIds.size === 0 || linking ? 0.5 : 1,
            }}
            disabled={selectedIds.size === 0 || linking}
            onClick={handleLink}
          >
            {linking
              ? "Linking..."
              : `Link ${selectedIds.size} Sheet${selectedIds.size !== 1 ? "s" : ""}`}
          </button>
        </div>
      </div>
    </div>
  );
};
