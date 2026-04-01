//! FILENAME: app/extensions/ScriptNotebook/components/NotebookCell.tsx
// PURPOSE: Individual cell component in the notebook view.
// CONTEXT: Contains a code editor textarea, run/rewind controls, and output display.

import React, { useCallback } from "react";
import type { NotebookCell as NotebookCellType } from "../types";
import { CellOutput } from "./CellOutput";
import { NotebookMonacoEditor } from "./NotebookMonacoEditor";
import { useNotebookStore } from "../lib/useNotebookStore";

interface NotebookCellProps {
  cell: NotebookCellType;
  index: number;
  isFirst: boolean;
  isLast: boolean;
}

// SVG micro-icons
const PlayIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
    <path d="M4 2l10 6-10 6V2z" />
  </svg>
);

const RewindIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
    <path d="M2 2h2v12H2V2zm4 6l8-6v12L6 8z" />
  </svg>
);

const RunFromIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
    <path d="M2 2h2v12H2V2zm4 0l10 6-10 6V2z" />
  </svg>
);

const PlusIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M8 2v12M2 8h12" />
  </svg>
);

const TrashIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M3 4h10M6 4V3h4v1M5 4v9h6V4" />
  </svg>
);

const ArrowUpIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M8 12V4M4 8l4-4 4 4" />
  </svg>
);

const ArrowDownIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M8 4v8M4 8l4 4 4-4" />
  </svg>
);

export function NotebookCell({
  cell,
  index,
  isFirst,
  isLast,
}: NotebookCellProps): React.ReactElement {
  const {
    updateCellSource,
    runCell,
    rewindToCell,
    runFromCell,
    addCell,
    removeCell,
    moveCellUp,
    moveCellDown,
    isExecuting,
    executingCellId,
  } = useNotebookStore();

  const isRunning = executingCellId === cell.id;
  const hasExecuted = cell.executionIndex !== null;
  const hasError = cell.lastError !== null;
  const hasRun = hasExecuted || hasError;
  // Stale = was previously run but executionIndex cleared after rewind
  const isStale = !hasExecuted && (cell.lastOutput.length > 0 || hasError);

  // Determine left-border state color:
  //   blue = successfully ran, gray = never run, orange = stale after rewind
  let cellStateStyle: React.CSSProperties;
  if (isRunning) {
    cellStateStyle = styles.runningCell;
  } else if (isStale) {
    cellStateStyle = styles.staleCell;
  } else if (hasError) {
    cellStateStyle = styles.errorCell;
  } else if (hasExecuted) {
    cellStateStyle = styles.ranCell;
  } else {
    cellStateStyle = styles.notRunCell;
  }

  const handleSourceChange = useCallback(
    (newValue: string) => {
      updateCellSource(cell.id, newValue);
    },
    [cell.id, updateCellSource],
  );

  const handleRunCell = useCallback(() => {
    runCell(cell.id);
  }, [cell.id, runCell]);

  return (
    <div
      style={{
        ...styles.cell,
        ...cellStateStyle,
      }}
    >
      {/* Cell header */}
      <div style={styles.header}>
        <div style={styles.headerLeft}>
          <span style={styles.cellLabel}>
            [{cell.executionIndex ?? " "}]
          </span>
        </div>
        <div style={styles.headerRight}>
          <button
            style={styles.iconButton}
            onClick={() => runCell(cell.id)}
            disabled={isExecuting}
            title="Run cell (Shift+Enter)"
          >
            <PlayIcon />
          </button>
          {hasRun && (
            <button
              style={styles.iconButton}
              onClick={() => rewindToCell(cell.id)}
              disabled={isExecuting}
              title="Rewind to before this cell"
            >
              <RewindIcon />
            </button>
          )}
          {hasRun && (
            <button
              style={styles.iconButton}
              onClick={() => runFromCell(cell.id)}
              disabled={isExecuting}
              title="Run from this cell onwards"
            >
              <RunFromIcon />
            </button>
          )}
          <span style={styles.separator} />
          {!isFirst && (
            <button
              style={styles.iconButton}
              onClick={() => moveCellUp(cell.id)}
              title="Move up"
            >
              <ArrowUpIcon />
            </button>
          )}
          {!isLast && (
            <button
              style={styles.iconButton}
              onClick={() => moveCellDown(cell.id)}
              title="Move down"
            >
              <ArrowDownIcon />
            </button>
          )}
          <button
            style={styles.iconButton}
            onClick={() => addCell(cell.id)}
            title="Add cell below"
          >
            <PlusIcon />
          </button>
          <button
            style={styles.iconButton}
            onClick={() => removeCell(cell.id)}
            title="Remove cell"
          >
            <TrashIcon />
          </button>
        </div>
      </div>

      {/* Code editor */}
      <NotebookMonacoEditor
        value={cell.source}
        onChange={handleSourceChange}
        onRunCell={handleRunCell}
      />

      {/* Output */}
      <CellOutput
        output={cell.lastOutput}
        error={cell.lastError}
        cellsModified={cell.cellsModified}
        durationMs={cell.durationMs}
        executionIndex={cell.executionIndex}
      />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  cell: {
    border: "1px solid var(--border-color, #e0e0e0)",
    borderLeft: "3px solid var(--border-color, #ccc)",
    borderRadius: "4px",
    marginBottom: "6px",
    overflow: "hidden",
    background: "var(--editor-bg, #fff)",
  },
  notRunCell: {
    borderLeftColor: "var(--border-color, #ccc)",
  },
  ranCell: {
    borderLeftColor: "#0078d4",
  },
  staleCell: {
    borderLeftColor: "#f0ad4e",
    opacity: 0.7,
  },
  errorCell: {
    borderLeftColor: "#d9534f",
  },
  runningCell: {
    borderLeftColor: "#0078d4",
    borderLeftWidth: "3px",
    boxShadow: "0 0 0 1px rgba(0, 120, 212, 0.3)",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "2px 6px",
    background: "var(--toolbar-bg, #f5f5f5)",
    borderBottom: "1px solid var(--border-color, #e0e0e0)",
    minHeight: "26px",
  },
  headerLeft: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
  },
  headerRight: {
    display: "flex",
    alignItems: "center",
    gap: "2px",
  },
  cellLabel: {
    fontSize: "11px",
    fontFamily: "Consolas, 'Courier New', monospace",
    color: "var(--accent-color, #0078d4)",
    fontWeight: 600,
    minWidth: "24px",
  },
  iconButton: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "22px",
    height: "22px",
    border: "none",
    background: "transparent",
    borderRadius: "3px",
    cursor: "pointer",
    color: "var(--text-secondary, #666)",
    padding: 0,
  },
  separator: {
    width: "1px",
    height: "14px",
    background: "var(--border-color, #e0e0e0)",
    margin: "0 2px",
  },
};
