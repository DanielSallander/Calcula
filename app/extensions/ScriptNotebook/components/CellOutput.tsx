//! FILENAME: app/extensions/ScriptNotebook/components/CellOutput.tsx
// PURPOSE: Displays output/error for a single notebook cell.

import React from "react";

interface CellOutputProps {
  output: string[];
  error: string | null;
  cellsModified: number;
  durationMs: number;
  executionIndex: number | null;
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

      {/* Console output */}
      {output.length > 0 && (
        <div style={styles.outputBlock}>
          {output.map((line, i) => (
            <div key={i} style={styles.outputLine}>
              {line}
            </div>
          ))}
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
};
