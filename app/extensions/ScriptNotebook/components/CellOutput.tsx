//! FILENAME: app/extensions/ScriptNotebook/components/CellOutput.tsx
// PURPOSE: Displays structured output (text lines, tables) and errors for a
//          single notebook cell. Table outputs get per-output actions:
//          copy as CSV and send to grid (at selection / on a new sheet).

import React, { useState } from "react";
import {
  useGridState,
  updateCellsBatch,
  addSheet,
  setActiveSheetApi,
  showToast,
} from "@api";
import type { CellUpdateInput } from "@api";
import { ResultTable } from "../../_shared/components/ResultTable";
import type { NotebookOutputItem } from "../types";

interface CellOutputProps {
  output: NotebookOutputItem[];
  error: string | null;
  cellsModified: number;
  durationMs: number;
  executionIndex: number | null;
}

function toCsv(columns: string[], rows: string[][]): string {
  const esc = (s: string) =>
    /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  const lines: string[] = [];
  if (columns.length > 0) lines.push(columns.map(esc).join(","));
  for (const row of rows) lines.push(row.map(esc).join(","));
  return lines.join("\r\n");
}

/** Build the batch updates for a table (headers + data) at an anchor cell. */
function tableToUpdates(
  columns: string[],
  rows: string[][],
  startRow: number,
  startCol: number,
): CellUpdateInput[] {
  const updates: CellUpdateInput[] = [];
  let r = startRow;
  if (columns.length > 0) {
    columns.forEach((col, c) =>
      updates.push({ row: r, col: startCol + c, value: col }),
    );
    r += 1;
  }
  for (const row of rows) {
    row.forEach((cell, c) =>
      // Engine output is invariant-formatted ("." decimals); skip delocalization.
      updates.push({ row: r, col: startCol + c, value: cell, invariant: true }),
    );
    r += 1;
  }
  return updates;
}

function TableOutput({
  item,
}: {
  item: Extract<NotebookOutputItem, { kind: "table" }>;
}): React.ReactElement {
  const gridState = useGridState();
  const [sendOpen, setSendOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const copyCsv = async () => {
    try {
      await navigator.clipboard.writeText(toCsv(item.columns, item.rows));
      showToast("Copied as CSV", { variant: "success" });
    } catch (err) {
      showToast(`Copy failed: ${err}`, { variant: "error" });
    }
  };

  const sendToGrid = async (target: "selection" | "newSheet") => {
    setSendOpen(false);
    setBusy(true);
    try {
      let startRow = 0;
      let startCol = 0;
      if (target === "selection") {
        const sel = gridState.selection;
        startRow = sel ? sel.startRow : 0;
        startCol = sel ? sel.startCol : 0;
      } else {
        const result = await addSheet();
        await setActiveSheetApi(result.sheets.length - 1);
      }
      await updateCellsBatch(tableToUpdates(item.columns, item.rows, startRow, startCol));
      window.dispatchEvent(new CustomEvent("grid:refresh"));
      const rowCount = item.rows.length + (item.columns.length > 0 ? 1 : 0);
      showToast(
        `Sent ${rowCount} row${rowCount !== 1 ? "s" : ""} to the grid${item.truncated ? " (truncated result)" : ""}`,
        { variant: "success" },
      );
    } catch (err) {
      showToast(`Send to grid failed: ${err}`, { variant: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <ResultTable
        columns={item.columns}
        rows={item.rows}
        truncated={item.truncated}
        totalRows={item.totalRows}
      />
      <div style={styles.actionsRow}>
        <button style={styles.actionButton} onClick={copyCsv} disabled={busy}>
          Copy CSV
        </button>
        <span style={styles.actionsAnchor}>
          <button
            style={styles.actionButton}
            onClick={() => setSendOpen((o) => !o)}
            disabled={busy}
          >
            Send to grid {"▾"}
          </button>
          {sendOpen && (
            <span style={styles.sendMenu}>
              <button style={styles.actionButton} onClick={() => sendToGrid("selection")}>
                At selection
              </button>
              <button style={styles.actionButton} onClick={() => sendToGrid("newSheet")}>
                On new sheet
              </button>
            </span>
          )}
        </span>
      </div>
    </div>
  );
}

export function CellOutput({
  output,
  error,
  cellsModified,
  durationMs,
  executionIndex,
}: CellOutputProps): React.ReactElement | null {
  // Nothing to show if cell was never run
  if (executionIndex === null && !error && output.length === 0) {
    return null;
  }

  return (
    <div style={styles.container}>
      {/* Status line */}
      {executionIndex !== null && (
        <div style={styles.statusLine}>
          <span style={styles.indexBadge}>[{executionIndex}]</span>
          <span style={styles.stats}>
            {cellsModified > 0 && `${cellsModified} cell${cellsModified !== 1 ? "s" : ""} modified`}
            {cellsModified > 0 && ` | `}
            {durationMs}ms
          </span>
        </div>
      )}

      {/* Structured output items */}
      {output.length > 0 && (
        <div style={styles.outputBlock}>
          {output.map((item, i) =>
            item.kind === "table" ? (
              <TableOutput key={i} item={item} />
            ) : (
              <div key={i} style={styles.outputLine}>
                {item.text}
              </div>
            ),
          )}
        </div>
      )}

      {/* Error */}
      {error && (
        <div style={styles.errorBlock}>
          {error}
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    padding: "4px 8px 6px 8px",
    fontSize: "12px",
    fontFamily: "Consolas, 'Courier New', monospace",
    borderTop: "1px solid var(--border-color, #e0e0e0)",
  },
  statusLine: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    marginBottom: "2px",
    color: "var(--text-secondary, #888)",
    fontSize: "11px",
  },
  indexBadge: {
    fontWeight: 600,
    color: "var(--accent-color, #0078d4)",
  },
  stats: {
    opacity: 0.8,
  },
  outputBlock: {
    padding: "4px 0",
    color: "var(--text-primary, #333)",
  },
  outputLine: {
    lineHeight: "18px",
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
  },
  errorBlock: {
    padding: "4px 6px",
    background: "var(--error-bg, #fdd)",
    color: "var(--error-text, #c00)",
    borderRadius: "3px",
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
  },
  actionsRow: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    marginBottom: "4px",
  },
  actionsAnchor: {
    position: "relative",
    display: "inline-flex",
    gap: "4px",
  },
  sendMenu: {
    display: "inline-flex",
    gap: "4px",
  },
  actionButton: {
    border: "1px solid var(--border-color, #d0d0d0)",
    background: "var(--bg-secondary, #f7f7f7)",
    color: "var(--text-primary, #333)",
    borderRadius: "3px",
    cursor: "pointer",
    fontSize: "10px",
    padding: "1px 6px",
  },
};
