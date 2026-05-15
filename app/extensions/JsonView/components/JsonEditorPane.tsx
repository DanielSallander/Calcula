//! FILENAME: app/extensions/JsonView/components/JsonEditorPane.tsx
// PURPOSE: Task Pane component for inspecting/editing any workbook object as JSON.
// CONTEXT: Registered as a TaskPane view with contextKeys: ["always"].
//          Provides object selector dropdown, Monaco editor, and Apply/Revert toolbar.

import React, { useState, useEffect, useCallback, useRef } from "react";
import { getObjectJson, setObjectJson, listObjects } from "@api/jsonView";
import type { ObjectEntry } from "@api/jsonView";
import { MonacoJsonEditor } from "./MonacoJsonEditor";
import { getObjectTypeName } from "../lib/objectTypes";

// ============================================================================
// Styles
// ============================================================================

const styles = {
  container: {
    display: "flex",
    flexDirection: "column" as const,
    height: "100%",
    backgroundColor: "#1e1e1e",
    color: "#cccccc",
  },
  toolbar: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    padding: "6px 8px",
    borderBottom: "1px solid #333",
    flexShrink: 0,
  },
  select: {
    flex: 1,
    backgroundColor: "#3c3c3c",
    color: "#cccccc",
    border: "1px solid #555",
    borderRadius: "3px",
    padding: "3px 6px",
    fontSize: "12px",
    fontFamily: "'Segoe UI', sans-serif",
  },
  button: {
    backgroundColor: "#0e639c",
    color: "#ffffff",
    border: "none",
    borderRadius: "3px",
    padding: "4px 10px",
    fontSize: "12px",
    cursor: "pointer",
    fontFamily: "'Segoe UI', sans-serif",
  },
  buttonSecondary: {
    backgroundColor: "#3c3c3c",
    color: "#cccccc",
    border: "1px solid #555",
    borderRadius: "3px",
    padding: "4px 10px",
    fontSize: "12px",
    cursor: "pointer",
    fontFamily: "'Segoe UI', sans-serif",
  },
  buttonDisabled: {
    opacity: 0.5,
    cursor: "default",
  },
  editorContainer: {
    flex: 1,
    minHeight: 0,
  },
  statusBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "3px 8px",
    borderTop: "1px solid #333",
    fontSize: "11px",
    color: "#888",
    flexShrink: 0,
  },
  errorText: {
    color: "#f48771",
  },
  emptyState: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
    fontSize: "13px",
    color: "#888",
    padding: "20px",
    textAlign: "center" as const,
  },
};

// ============================================================================
// Component
// ============================================================================

export function JsonEditorPane(): React.ReactElement {
  const [objects, setObjects] = useState<ObjectEntry[]>([]);
  const [selectedKey, setSelectedKey] = useState("");
  const [jsonText, setJsonText] = useState("");
  const [originalJson, setOriginalJson] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [dirty, setDirty] = useState(false);
  const loadingRef = useRef(false);

  // Load object list
  useEffect(() => {
    listObjects()
      .then(setObjects)
      .catch((err) => console.error("[JsonView] Failed to list objects:", err));
  }, []);

  // Load selected object's JSON
  const loadObjectJson = useCallback(async (key: string) => {
    if (!key || loadingRef.current) return;

    const [objectType, objectId] = key.split(":", 2);
    if (!objectType || !objectId) return;

    loadingRef.current = true;
    setLoading(true);
    setError(null);

    try {
      const json = await getObjectJson(objectType, objectId);
      setJsonText(json);
      setOriginalJson(json);
      setDirty(false);
    } catch (err) {
      setError(String(err));
      setJsonText("");
      setOriginalJson("");
    } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  }, []);

  // Handle dropdown selection change
  const handleSelectChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const key = e.target.value;
      setSelectedKey(key);
      loadObjectJson(key);
    },
    [loadObjectJson],
  );

  // Handle editor text change
  const handleJsonChange = useCallback(
    (value: string) => {
      setJsonText(value);
      setDirty(value !== originalJson);
      // Validate JSON syntax
      try {
        JSON.parse(value);
        setError(null);
      } catch (err) {
        if (err instanceof SyntaxError) {
          setError(`Syntax: ${err.message}`);
        }
      }
    },
    [originalJson],
  );

  // Apply changes
  const handleApply = useCallback(async () => {
    if (!selectedKey) return;

    const [objectType, objectId] = selectedKey.split(":", 2);
    if (!objectType || !objectId) return;

    // Validate JSON first
    try {
      JSON.parse(jsonText);
    } catch {
      setError("Cannot apply: invalid JSON syntax");
      return;
    }

    setLoading(true);
    try {
      await setObjectJson(objectType, objectId, jsonText);
      setOriginalJson(jsonText);
      setDirty(false);
      setError(null);
    } catch (err) {
      setError(`Apply failed: ${String(err)}`);
    } finally {
      setLoading(false);
    }
  }, [selectedKey, jsonText]);

  // Revert to last-saved state
  const handleRevert = useCallback(() => {
    setJsonText(originalJson);
    setDirty(false);
    setError(null);
  }, [originalJson]);

  // Refresh from backend
  const handleRefresh = useCallback(() => {
    if (selectedKey) {
      loadObjectJson(selectedKey);
    }
  }, [selectedKey, loadObjectJson]);

  // Build the dropdown key: "objectType:objectId"
  const objectOptions = objects.map((o) => ({
    key: `${o.objectType}:${o.objectId}`,
    label: o.label,
  }));

  const hasSelection = selectedKey !== "";
  const canApply = hasSelection && dirty && error === null;

  return (
    <div style={styles.container}>
      {/* Toolbar */}
      <div style={styles.toolbar}>
        <select style={styles.select} value={selectedKey} onChange={handleSelectChange}>
          <option value="">-- Select object --</option>
          {objectOptions.map((opt) => (
            <option key={opt.key} value={opt.key}>
              {opt.label}
            </option>
          ))}
        </select>
        <button
          style={{ ...styles.buttonSecondary, ...(loading ? styles.buttonDisabled : {}) }}
          onClick={handleRefresh}
          disabled={!hasSelection || loading}
          title="Refresh from backend"
        >
          Refresh
        </button>
      </div>

      {/* Editor area */}
      {hasSelection ? (
        <>
          <div style={styles.editorContainer}>
            <MonacoJsonEditor
              value={jsonText}
              onChange={handleJsonChange}
              readOnly={loading}
            />
          </div>

          {/* Action bar */}
          <div style={styles.toolbar}>
            <button
              style={{ ...styles.button, ...(canApply ? {} : styles.buttonDisabled) }}
              onClick={handleApply}
              disabled={!canApply}
            >
              Apply
            </button>
            <button
              style={{ ...styles.buttonSecondary, ...(dirty ? {} : styles.buttonDisabled) }}
              onClick={handleRevert}
              disabled={!dirty}
            >
              Revert
            </button>
          </div>
        </>
      ) : (
        <div style={styles.emptyState}>
          Select a workbook object above to inspect its JSON configuration.
        </div>
      )}

      {/* Status bar */}
      <div style={styles.statusBar}>
        <span>
          {hasSelection && selectedKey
            ? getObjectTypeName(selectedKey.split(":")[0])
            : "No selection"}
        </span>
        {error ? <span style={styles.errorText}>{error}</span> : null}
        {dirty && !error ? <span>Modified</span> : null}
      </div>
    </div>
  );
}
