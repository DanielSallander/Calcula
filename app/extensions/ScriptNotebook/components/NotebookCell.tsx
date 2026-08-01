//! FILENAME: app/extensions/ScriptNotebook/components/NotebookCell.tsx
// PURPOSE: Individual cell component in the notebook view.
// CONTEXT: Contains a code editor textarea, run/rewind controls, and output display.

import React, { useCallback, useState } from "react";
import { showToast } from "@api";
import type { NotebookCell as NotebookCellType } from "../types";
import { CellOutput } from "./CellOutput";
import { MarkdownView } from "./MarkdownView";
import { NotebookMonacoEditor } from "./NotebookMonacoEditor";
import { useNotebookStore } from "../lib/useNotebookStore";
import { cellKindOf, markdownBodyOf, withMarkdownMarker } from "../lib/cellKind";
import {
  methodNameFor,
  planPromotion,
  promoteCellToObjectScript,
} from "../lib/promoteToObjectScript";

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

/** Promote: an arrow leaving a box — "graduate this cell out of the notebook". */
const PromoteIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M8 11V2M5 5l3-3 3 3" />
    <path d="M2.5 9v4.5h11V9" />
  </svg>
);

/**
 * "Promote to object script": ask for a name, show the capability set DERIVED
 * from what the cell actually called, and only then persist — unmounted.
 *
 * The consent text says exactly what happens (an INACTIVE script, started by
 * hand) because that is exactly what `promoteCellToObjectScript` does; it never
 * calls mountScript.
 */
async function promoteWithConsent(
  cell: NotebookCellType,
  cellNumber: number,
  notebookName: string,
): Promise<void> {
  const plan = planPromotion(cell.source);
  const defaultName = `${notebookName} — cell ${cellNumber}`;
  const scriptName = window.prompt(
    "Promote this cell to an object script.\n\n" +
      "The analysis becomes a callable method on a workbook script. Name it:",
    defaultName,
  );
  if (scriptName === null || scriptName.trim() === "") return;

  const methodName = methodNameFor(scriptName);
  const capLine =
    plan.capabilities.length > 0
      ? plan.capabilities.map((c) => `  • ${c}`).join("\n")
      : "  (none — this cell used no privileged API)";
  const noteLine =
    plan.notes.length > 0
      ? `\n\nPorting notes are written into the script:\n${plan.notes
          .map((n) => `  • ${n.api}`)
          .join("\n")}`
      : "";

  const ok = window.confirm(
    `Create the object script "${scriptName.trim()}"?\n\n` +
      `It will declare these capabilities, derived from the calls this cell made:\n${capLine}\n\n` +
      `The script is saved INACTIVE. Nothing runs until you start it in the Object ` +
      `Scripts pane, and its analysis then runs only when the exposed method ` +
      `"${methodName}" is called — never on workbook open.${noteLine}`,
  );
  if (!ok) return;

  try {
    const result = await promoteCellToObjectScript({
      scriptName: scriptName.trim(),
      methodName,
      cellSource: cell.source,
      notebookName,
      cellNumber,
    });
    showToast(
      `Created inactive object script "${result.scriptName}". Review and start it in the Object Scripts pane.`,
      { type: "success" },
    );
  } catch (err) {
    showToast(`Promotion failed: ${err instanceof Error ? err.message : String(err)}`, {
      type: "error",
    });
  }
}

export function NotebookCell({
  cell,
  index,
  isFirst,
  isLast,
}: NotebookCellProps): React.ReactElement {
  const {
    activeNotebook,
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

  const kind = cellKindOf(cell.source);
  const isMarkdown = kind === "markdown";
  // A text cell opens rendered once it has content; a brand-new one opens in
  // edit mode so there is something to type into.
  const [editingText, setEditingText] = useState(
    () => isMarkdown && markdownBodyOf(cell.source).trim() === "",
  );

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

  const handleTextChange = useCallback(
    (body: string) => {
      updateCellSource(cell.id, withMarkdownMarker(body));
    },
    [cell.id, updateCellSource],
  );

  const handlePromote = useCallback(() => {
    void promoteWithConsent(cell, index + 1, activeNotebook?.name ?? "Notebook");
  }, [cell, index, activeNotebook]);

  return (
    <div
      style={{
        ...styles.cell,
        ...(isMarkdown ? styles.textCell : cellStateStyle),
      }}
    >
      {/* Cell header */}
      <div style={styles.header}>
        <div style={styles.headerLeft}>
          <span style={isMarkdown ? styles.textLabel : styles.cellLabel}>
            {isMarkdown ? "Text" : `[${cell.executionIndex ?? " "}]`}
          </span>
        </div>
        <div style={styles.headerRight}>
          {isMarkdown && (
            <button
              style={styles.textButton}
              onClick={() => setEditingText((v) => !v)}
              title={editingText ? "Render this text" : "Edit this text"}
            >
              {editingText ? "Done" : "Edit"}
            </button>
          )}
          {!isMarkdown && (
            <button
              style={styles.iconButton}
              onClick={() => runCell(cell.id)}
              disabled={isExecuting}
              title="Run cell (Shift+Enter)"
            >
              <PlayIcon />
            </button>
          )}
          {!isMarkdown && hasRun && (
            <button
              style={styles.iconButton}
              onClick={() => rewindToCell(cell.id)}
              disabled={isExecuting}
              title="Rewind to before this cell"
            >
              <RewindIcon />
            </button>
          )}
          {!isMarkdown && hasRun && (
            <button
              style={styles.iconButton}
              onClick={() => runFromCell(cell.id)}
              disabled={isExecuting}
              title="Run from this cell onwards"
            >
              <RunFromIcon />
            </button>
          )}
          {!isMarkdown && cell.source.trim() !== "" && (
            <button
              style={styles.iconButton}
              onClick={handlePromote}
              title="Promote to an object script (saved inactive, for review)"
            >
              <PromoteIcon />
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

      {isMarkdown ? (
        /* Text cell: prose only. No editor, no run controls, no output —
           run/rewind skip it on both sides of the IPC boundary. */
        editingText ? (
          <textarea
            style={styles.textArea}
            value={markdownBodyOf(cell.source)}
            onChange={(e) => handleTextChange(e.target.value)}
            onBlur={() => setEditingText(false)}
            placeholder="Markdown — headings, lists, `code`, **bold**, links…"
            autoFocus
          />
        ) : (
          <div onDoubleClick={() => setEditingText(true)} title="Double-click to edit">
            <MarkdownView source={markdownBodyOf(cell.source)} />
          </div>
        )
      ) : (
        <>
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
        </>
      )}
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
  textCell: {
    borderLeftColor: "var(--text-secondary, #999)",
  },
  textLabel: {
    fontSize: "10px",
    letterSpacing: "0.4px",
    textTransform: "uppercase" as const,
    color: "var(--text-secondary, #888)",
    fontWeight: 600,
  },
  textButton: {
    padding: "1px 6px",
    fontSize: "11px",
    border: "none",
    background: "transparent",
    color: "var(--accent-color, #0078d4)",
    cursor: "pointer",
    fontWeight: 500,
  },
  textArea: {
    width: "100%",
    minHeight: "80px",
    boxSizing: "border-box" as const,
    padding: "8px 10px",
    border: "none",
    outline: "none",
    resize: "vertical" as const,
    fontFamily: "Consolas, 'Courier New', monospace",
    fontSize: "12px",
    lineHeight: "18px",
    background: "var(--editor-bg, #fff)",
    color: "var(--text-primary, #333)",
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
