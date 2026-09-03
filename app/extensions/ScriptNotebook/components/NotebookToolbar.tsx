//! FILENAME: app/extensions/ScriptNotebook/components/NotebookToolbar.tsx
// PURPOSE: Top toolbar for the notebook panel.
// CONTEXT: Contains Run All, Add Cell, Reset, and notebook selector controls.

import React, { useState, useCallback } from "react";
import { useNotebookStore } from "../lib/useNotebookStore";
import { MODEL_QUERY_TEMPLATE } from "../lib/cellTemplates";
import { confirmAsync } from "@api/dialogs";

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

/**
 * The application a notebook arrived in, or null when it is the user's own.
 *
 * Reads the stamp the pull path writes (`source_package`,
 * core/calp/src/pull.rs) exactly as the Rust run gate does: a blank name is
 * nothing stamped, never an application called "". Mirrors
 * `scriptOriginForStoredRecord` (@api/scriptHost/scriptOrigin) — a
 * publisher-chosen name is CONTENT that is displayed, never a flag that
 * selects "local".
 */
function packageOf(record: { sourcePackage?: string } | null): string | null {
  const name = record?.sourcePackage?.trim() ?? "";
  return name === "" ? null : name;
}

export function NotebookToolbar(): React.ReactElement {
  const {
    activeNotebook,
    notebooks,
    isExecuting,
    runRefusal,
    runAll,
    addCell,
    appendCellsWithSource,
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

  const activePackage = packageOf(activeNotebook);

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
          {notebooks.map((nb) => {
            // The row says whose notebook it is BEFORE it is opened: this list
            // is the only thing the user sees when choosing, and a publisher's
            // notebook used to be indistinguishable from their own here.
            const pkg = packageOf(nb);
            return (
              <option key={nb.id} value={nb.id}>
                {nb.name} ({nb.cellCount} cell{nb.cellCount !== 1 ? "s" : ""})
                {pkg ? ` — from "${pkg}"` : ""}
              </option>
            );
          })}
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

      {/* Provenance band: whose code is open right now. Shown for the ACTIVE
          notebook, always, not only when a run is refused — the user must know
          where the code they are reading came from before they press Run. */}
      {activePackage && (
        <div
          style={styles.provenance}
          title={`This notebook was distributed inside the application "${activePackage}". Its cells are inert until you approve that application's code.`}
        >
          From application &quot;{activePackage}&quot; — not authored in this
          workbook
        </div>
      )}

      {/* A refused run, in words. Without this the backend's refusal is a
          console line and the Run button just appears to do nothing. */}
      {runRefusal && <div style={styles.refusal}>{runRefusal}</div>}

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
            title="Add a code cell at the end"
          >
            + Code
          </button>
          <button
            style={styles.button}
            onClick={() => addCell(undefined, "markdown")}
            title="Add a text (markdown) cell at the end — prose, never executed"
          >
            + Text
          </button>
          <button
            style={styles.button}
            onClick={() => appendCellsWithSource([MODEL_QUERY_TEMPLATE])}
            title="Add a starter cell for the read-only model API"
          >
            Model query…
          </button>
          <div style={{ flex: 1 }} />
          <button
            style={{ ...styles.button, color: "var(--error-text, #c00)" }}
            onClick={() => {
              // AWAITED (in an IIFE — the handler itself stays sync). The bare
              // `confirm(...)` returned a truthy Promise, so Cancel deleted the
              // notebook exactly like OK.
              void (async () => {
                if (await confirmAsync(`Delete notebook "${activeNotebook.name}"?`)) {
                  deleteNotebook(activeNotebook.id);
                }
              })();
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
  provenance: {
    padding: "3px 6px",
    fontSize: "11px",
    lineHeight: "15px",
    borderRadius: "3px",
    border: "1px solid var(--warning-border, #e0c07a)",
    background: "var(--warning-bg, #fdf6e3)",
    color: "var(--warning-text, #7a5c00)",
  },
  refusal: {
    padding: "4px 6px",
    fontSize: "11px",
    lineHeight: "15px",
    borderRadius: "3px",
    border: "1px solid var(--error-border, #e0a0a0)",
    background: "var(--error-bg, #fdeaea)",
    color: "var(--error-text, #c00)",
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
