//! FILENAME: app/extensions/ScriptNotebook/components/NotebookToolbar.tsx
// PURPOSE: Top toolbar for the notebook panel.
// CONTEXT: Contains Run All, Add Cell, Reset, and notebook selector controls.

import React, { useState, useCallback } from "react";
import { useNotebookStore } from "../lib/useNotebookStore";

const PlayAllIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
    <path d="M2 2l6 6-6 6V2zM8 2l6 6-6 6V2z" />
  </svg>
);

const StopIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
    <rect x="3" y="3" width="10" height="10" rx="1" />
  </svg>
);

const NewIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <rect x="2" y="1" width="12" height="14" rx="1" />
    <path d="M5 8h6M8 5v6" />
  </svg>
);

export function NotebookToolbar(): React.ReactElement {
  const {
    activeNotebook,
    notebooks,
    isExecuting,
    runAll,
    addCell,
    createNotebook,
    openNotebook,
    deleteNotebook,
    refreshNotebookList,
  } = useNotebookStore();

  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");

  const handleCreate = useCallback(async () => {
    if (!newName.trim()) return;
    await createNotebook(newName.trim());
    setNewName("");
    setShowCreate(false);
  }, [newName, createNotebook]);

  const handleCreateKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        handleCreate();
      } else if (e.key === "Escape") {
        setShowCreate(false);
        setNewName("");
      }
    },
    [handleCreate],
  );

  return (
    <div style={styles.toolbar}>
      {/* Notebook selector */}
      <div style={styles.row}>
        <select
          style={styles.select}
          value={activeNotebook?.id ?? ""}
          onChange={(e) => {
            if (e.target.value) {
              openNotebook(e.target.value);
            }
          }}
          onFocus={() => refreshNotebookList()}
        >
          <option value="">-- Select Notebook --</option>
          {notebooks.map((nb) => (
            <option key={nb.id} value={nb.id}>
              {nb.name} ({nb.cellCount} cell{nb.cellCount !== 1 ? "s" : ""})
            </option>
          ))}
        </select>
        <button
          style={styles.button}
          onClick={() => setShowCreate(true)}
          title="New notebook"
        >
          <NewIcon />
        </button>
      </div>

      {/* Create notebook inline */}
      {showCreate && (
        <div style={styles.row}>
          <input
            style={styles.input}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={handleCreateKeyDown}
            placeholder="Notebook name..."
            autoFocus
          />
          <button style={styles.textButton} onClick={handleCreate}>
            Create
          </button>
          <button
            style={styles.textButton}
            onClick={() => {
              setShowCreate(false);
              setNewName("");
            }}
          >
            Cancel
          </button>
        </div>
      )}

      {/* Action buttons (only when a notebook is active) */}
      {activeNotebook && (
        <div style={styles.row}>
          <button
            style={styles.button}
            onClick={runAll}
            disabled={isExecuting}
            title="Run All Cells"
          >
            {isExecuting ? <StopIcon /> : <PlayAllIcon />}
            <span style={styles.buttonLabel}>
              {isExecuting ? "Running..." : "Run All"}
            </span>
          </button>
          <button
            style={styles.button}
            onClick={() => addCell()}
            title="Add Cell at End"
          >
            +Cell
          </button>
          <div style={{ flex: 1 }} />
          <button
            style={{ ...styles.button, color: "var(--error-text, #c00)" }}
            onClick={() => {
              if (confirm(`Delete notebook "${activeNotebook.name}"?`)) {
                deleteNotebook(activeNotebook.id);
              }
            }}
            title="Delete notebook"
          >
            Del
          </button>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  toolbar: {
    padding: "6px 8px",
    borderBottom: "1px solid var(--border-color, #e0e0e0)",
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    background: "var(--toolbar-bg, #f5f5f5)",
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
  },
  select: {
    flex: 1,
    padding: "3px 6px",
    fontSize: "12px",
    border: "1px solid var(--border-color, #ccc)",
    borderRadius: "3px",
    background: "var(--input-bg, #fff)",
    color: "var(--text-primary, #333)",
    minWidth: 0,
  },
  input: {
    flex: 1,
    padding: "3px 6px",
    fontSize: "12px",
    border: "1px solid var(--border-color, #ccc)",
    borderRadius: "3px",
    background: "var(--input-bg, #fff)",
    color: "var(--text-primary, #333)",
    outline: "none",
  },
  button: {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    padding: "3px 8px",
    fontSize: "12px",
    border: "1px solid var(--border-color, #ccc)",
    borderRadius: "3px",
    background: "var(--button-bg, #fff)",
    color: "var(--text-primary, #333)",
    cursor: "pointer",
    whiteSpace: "nowrap" as const,
  },
  textButton: {
    padding: "3px 8px",
    fontSize: "12px",
    border: "none",
    background: "transparent",
    color: "var(--accent-color, #0078d4)",
    cursor: "pointer",
    fontWeight: 500,
  },
  buttonLabel: {
    fontSize: "11px",
  },
};
