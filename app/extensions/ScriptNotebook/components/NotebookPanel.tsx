//! FILENAME: app/extensions/ScriptNotebook/components/NotebookPanel.tsx
// PURPOSE: Main activity sidebar component for the notebook view.
// CONTEXT: Registered as an ActivityView in the left sidebar.

import React, { useEffect } from "react";
import type { ActivityViewProps } from "../../../src/api/uiTypes";
import { useNotebookStore } from "../lib/useNotebookStore";
import { NotebookToolbar } from "./NotebookToolbar";
import { NotebookCell } from "./NotebookCell";

export function NotebookPanel(_props: ActivityViewProps): React.ReactElement {
  const { activeNotebook, refreshNotebookList } = useNotebookStore();

  // Load notebook list on mount
  useEffect(() => {
    refreshNotebookList();
  }, [refreshNotebookList]);

  return (
    <div style={styles.container}>
      <NotebookToolbar />

      <div style={styles.cellList}>
        {activeNotebook ? (
          activeNotebook.cells.length > 0 ? (
            activeNotebook.cells.map((cell, i) => (
              <NotebookCell
                key={cell.id}
                cell={cell}
                index={i}
                isFirst={i === 0}
                isLast={i === activeNotebook.cells.length - 1}
              />
            ))
          ) : (
            <div style={styles.empty}>
              No cells. Click "+Cell" to add one.
            </div>
          )
        ) : (
          <div style={styles.empty}>
            <div style={styles.emptyTitle}>Calcula Notebook</div>
            <div style={styles.emptyText}>
              Create or select a notebook to start scripting.
            </div>
            <div style={styles.emptyText}>
              Notebooks let you write code in sequential cells with shared
              variables (like Jupyter). You can rewind to any previous state.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    overflow: "hidden",
  },
  cellList: {
    flex: 1,
    overflow: "auto",
    padding: "6px 8px",
  },
  empty: {
    padding: "24px 16px",
    textAlign: "center" as const,
    color: "var(--text-secondary, #888)",
    fontSize: "12px",
  },
  emptyTitle: {
    fontSize: "14px",
    fontWeight: 600,
    color: "var(--text-primary, #333)",
    marginBottom: "8px",
  },
  emptyText: {
    lineHeight: "18px",
    marginBottom: "6px",
  },
};
