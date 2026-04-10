// FILENAME: app/extensions/LinkedSheets/components/PublishDialog.tsx
// PURPOSE: Author-side dialog to publish selected sheets to a shared directory.

import React, { useState, useEffect, useCallback } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { DialogProps } from "@api/uiTypes";
import {
  publishSheets,
  getPublishInfo,
  type PublishedSheetInfo,
  type ConnectionInput,
} from "@api/linkedSheets";
import { invokeBackend } from "@api/backend";

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

interface SheetItem {
  index: number;
  name: string;
  selected: boolean;
  description: string;
}

export const PublishDialog: React.FC<DialogProps> = ({
  isOpen,
  onClose,
  data,
}) => {
  const [pubDir, setPubDir] = useState("");
  const [author, setAuthor] = useState("");
  const [sheets, setSheets] = useState<SheetItem[]>([]);
  const [existingPublished, setExistingPublished] = useState<
    PublishedSheetInfo[]
  >([]);
  const [publishing, setPublishing] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // BI connection fields (optional)
  const [includeConnection, setIncludeConnection] = useState(false);
  const [connectionName, setConnectionName] = useState("");
  const [connectionString, setConnectionString] = useState("");

  // Load sheet names on open
  useEffect(() => {
    if (!isOpen) return;
    setResult(null);
    setError(null);

    invokeBackend<string[]>("get_sheet_names", {}).then((names) => {
      setSheets(
        names.map((name, index) => ({
          index,
          name,
          selected: false,
          description: "",
        }))
      );
    });

    // Pre-fill pub dir if passed via data
    if (data?.pubDir && typeof data.pubDir === "string") {
      setPubDir(data.pubDir);
      loadExistingPublished(data.pubDir);
    }
  }, [isOpen]);

  const loadExistingPublished = useCallback(async (dir: string) => {
    try {
      const info = await getPublishInfo(dir);
      setExistingPublished(info?.sheets ?? []);
    } catch {
      setExistingPublished([]);
    }
  }, []);

  const handleBrowseDir = useCallback(async () => {
    const path = await open({
      multiple: false,
      directory: true,
      title: "Select Publication Directory",
    });
    if (path && typeof path === "string") {
      setPubDir(path);
      loadExistingPublished(path);
    }
  }, [loadExistingPublished]);

  const toggleSheet = useCallback((index: number) => {
    setSheets((prev) =>
      prev.map((s) =>
        s.index === index ? { ...s, selected: !s.selected } : s
      )
    );
  }, []);

  const setDescription = useCallback((index: number, desc: string) => {
    setSheets((prev) =>
      prev.map((s) => (s.index === index ? { ...s, description: desc } : s))
    );
  }, []);

  const handlePublish = useCallback(async () => {
    const selected = sheets.filter((s) => s.selected);
    if (!pubDir || selected.length === 0) return;

    setPublishing(true);
    setError(null);
    setResult(null);

    try {
      const connections: ConnectionInput[] = [];
      if (includeConnection && connectionString) {
        connections.push({
          name: connectionName || "Database",
          connectionType: "PostgreSQL",
          connectionString,
        });
      }

      const res = await publishSheets(
        pubDir,
        selected.map((s) => s.index),
        author || "Unknown",
        selected.map((s) => s.description),
        connections
      );
      setResult(
        `Published ${res.sheetsPublished} sheet(s) to ${res.pubDir}`
      );
      loadExistingPublished(pubDir);
    } catch (e) {
      setError(String(e));
    } finally {
      setPublishing(false);
    }
  }, [sheets, pubDir, author, includeConnection, connectionName, connectionString, loadExistingPublished]);

  if (!isOpen) return null;

  const selectedCount = sheets.filter((s) => s.selected).length;

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
          width: 560,
          maxHeight: "85vh",
          overflow: "auto",
          boxShadow: "0 8px 32px rgba(0,0,0,0.2)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 style={{ margin: "0 0 16px", fontSize: 18 }}>Publish Sheets</h2>

        {/* Publication directory */}
        <div style={{ marginBottom: 12 }}>
          <label
            style={{ display: "block", fontSize: 12, color: "#666", marginBottom: 4 }}
          >
            Publication Directory
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              style={{ ...inputStyle, flex: 1 }}
              value={pubDir}
              onChange={(e) => setPubDir(e.target.value)}
              placeholder="Shared folder to publish to..."
            />
            <button style={secondaryBtnStyle} onClick={handleBrowseDir}>
              Browse
            </button>
          </div>
        </div>

        {/* Author */}
        <div style={{ marginBottom: 16 }}>
          <label
            style={{ display: "block", fontSize: 12, color: "#666", marginBottom: 4 }}
          >
            Author
          </label>
          <input
            style={inputStyle}
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            placeholder="Your name..."
          />
        </div>

        {/* Sheet selection */}
        <div style={{ marginBottom: 16 }}>
          <label
            style={{
              display: "block",
              fontSize: 12,
              color: "#666",
              marginBottom: 8,
            }}
          >
            Select Sheets to Publish
          </label>
          {sheets.map((sheet) => {
            const existing = existingPublished.find(
              (p) =>
                p.name === sheet.name ||
                p.id ===
                  sheet.name
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, "-")
                    .replace(/^-|-$/g, "")
            );
            return (
              <div
                key={sheet.index}
                style={{
                  padding: "8px 12px",
                  border: "1px solid #e0e0e0",
                  borderRadius: 4,
                  marginBottom: 6,
                  backgroundColor: sheet.selected ? "#f0f7ff" : "#fff",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={sheet.selected}
                    onChange={() => toggleSheet(sheet.index)}
                  />
                  <span style={{ fontWeight: 500 }}>{sheet.name}</span>
                  {existing && (
                    <span
                      style={{
                        fontSize: 11,
                        color: "#888",
                        marginLeft: "auto",
                      }}
                    >
                      v{existing.version} published
                    </span>
                  )}
                </div>
                {sheet.selected && (
                  <input
                    style={{ ...inputStyle, marginTop: 6 }}
                    value={sheet.description}
                    onChange={(e) =>
                      setDescription(sheet.index, e.target.value)
                    }
                    placeholder="Description (optional)..."
                  />
                )}
              </div>
            );
          })}
        </div>

        {/* BI Connection (optional) */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <input
              type="checkbox"
              checked={includeConnection}
              onChange={(e) => setIncludeConnection(e.target.checked)}
            />
            <label style={{ fontSize: 13, color: "#444" }}>
              Include BI connection (auto-parameterized for environment switching)
            </label>
          </div>
          {includeConnection && (
            <div style={{ paddingLeft: 24 }}>
              <input
                style={{ ...inputStyle, marginBottom: 6 }}
                value={connectionName}
                onChange={(e) => setConnectionName(e.target.value)}
                placeholder="Connection name (e.g., Sales Database)..."
              />
              <input
                style={inputStyle}
                value={connectionString}
                onChange={(e) => setConnectionString(e.target.value)}
                placeholder="postgresql://user:pass@host:5432/dbname"
              />
              <div style={{ fontSize: 11, color: "#888", marginTop: 4 }}>
                Host, port, database, user, and password will be auto-extracted as parameters.
                A DEV environment profile will be created from the current values.
              </div>
            </div>
          )}
        </div>

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
                !pubDir || selectedCount === 0 || publishing ? 0.5 : 1,
            }}
            disabled={!pubDir || selectedCount === 0 || publishing}
            onClick={handlePublish}
          >
            {publishing
              ? "Publishing..."
              : `Publish ${selectedCount} Sheet${selectedCount !== 1 ? "s" : ""}`}
          </button>
        </div>
      </div>
    </div>
  );
};
