//! FILENAME: app/extensions/_shared/components/ResultTable.tsx
// PURPOSE: Small scrollable HTML table for rendering tabular results
//          (notebook table outputs; reusable by other panes, e.g. a future
//          measure preview). Payloads are already capped upstream, so no
//          virtualization — sticky header + incremental "show more" suffice.

import React, { useState } from "react";

interface ResultTableProps {
  /** Column headers; empty array = render without a header row. */
  columns: string[];
  rows: string[][];
  /** True when the payload itself was truncated upstream. */
  truncated?: boolean;
  /** Row count before upstream truncation (defaults to rows.length). */
  totalRows?: number;
  /** Max pixel height of the scroll area. */
  maxHeight?: number;
}

const PAGE_SIZE = 100;

function isNumeric(value: string): boolean {
  if (value === "") return false;
  return !Number.isNaN(Number(value));
}

export function ResultTable({
  columns,
  rows,
  truncated = false,
  totalRows,
  maxHeight = 240,
}: ResultTableProps): React.ReactElement {
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const visible = rows.slice(0, visibleCount);
  const total = totalRows ?? rows.length;
  const hasMore = visibleCount < rows.length;

  return (
    <div style={styles.wrapper}>
      <div style={{ ...styles.scroll, maxHeight }}>
        <table style={styles.table}>
          {columns.length > 0 && (
            <thead>
              <tr>
                {columns.map((col, i) => (
                  <th key={i} style={styles.th}>
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {visible.map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) => (
                  <td
                    key={c}
                    style={{
                      ...styles.td,
                      textAlign: isNumeric(cell) ? "right" : "left",
                    }}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(hasMore || truncated || rows.length > 0) && (
        <div style={styles.footer}>
          <span>
            {`Showing ${Math.min(visibleCount, rows.length)} of ${total} row${total !== 1 ? "s" : ""}`}
            {truncated && ` (result truncated at ${rows.length})`}
          </span>
          {hasMore && (
            <button
              style={styles.showMore}
              onClick={() => setVisibleCount((n) => n + PAGE_SIZE)}
            >
              Show more
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    border: "1px solid var(--border-color, #e0e0e0)",
    borderRadius: "3px",
    margin: "4px 0",
    overflow: "hidden",
  },
  scroll: {
    overflow: "auto",
  },
  table: {
    borderCollapse: "collapse",
    width: "100%",
    fontSize: "11px",
    fontFamily: "Consolas, 'Courier New', monospace",
  },
  th: {
    position: "sticky",
    top: 0,
    background: "var(--bg-secondary, #f5f5f5)",
    color: "var(--text-primary, #333)",
    textAlign: "left",
    fontWeight: 600,
    padding: "3px 8px",
    borderBottom: "1px solid var(--border-color, #e0e0e0)",
    whiteSpace: "nowrap",
  },
  td: {
    padding: "2px 8px",
    borderBottom: "1px solid var(--border-color-light, #f0f0f0)",
    whiteSpace: "nowrap",
    color: "var(--text-primary, #333)",
  },
  footer: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "8px",
    padding: "2px 8px",
    fontSize: "10px",
    color: "var(--text-secondary, #888)",
    background: "var(--bg-secondary, #fafafa)",
    borderTop: "1px solid var(--border-color-light, #f0f0f0)",
  },
  showMore: {
    border: "none",
    background: "none",
    color: "var(--accent-color, #0078d4)",
    cursor: "pointer",
    fontSize: "10px",
    padding: "1px 4px",
  },
};
