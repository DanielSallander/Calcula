//! FILENAME: app/extensions/Charts/components/DataInspectorWindow.tsx
// PURPOSE: Floating "inspect data" window for the chart dialog — shows the
//   current preview data (design-query / pivot / range result) as a grid.
// CONTEXT: Opened from the Data tab's "Inspect data…" button. A movable,
//   resizable window (shared @api/dialogWindow hook) closed via the X in its
//   upper-right corner; kept out of the dialog body so it costs no space.

import React from "react";
import { css } from "@emotion/css";
import { useDialogWindow } from "@api/dialogWindow";
import type { ParsedChartData } from "../types";

const MAX_ROWS = 1000;

const s = {
  window: css`
    position: fixed;
    left: 56%;
    top: 12%;
    width: 480px;
    height: 420px;
    z-index: 1052;
    pointer-events: auto;
    display: flex;
    flex-direction: column;
    background: var(--panel-bg);
    border: 1px solid var(--border-default);
    border-radius: 8px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
    color: var(--text-primary);
    font-family: "Segoe UI", system-ui, sans-serif;
    font-size: 12px;
  `,
  header: css`
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 12px;
    flex-shrink: 0;
    cursor: grab;
    user-select: none;
    border-bottom: 1px solid var(--border-default);

    &:active {
      cursor: grabbing;
    }
  `,
  title: css`
    font-weight: 600;
    font-size: 13px;
  `,
  close: css`
    background: transparent;
    border: none;
    color: var(--text-secondary);
    cursor: pointer;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 14px;
    line-height: 1;

    &:hover {
      background: var(--grid-bg);
      color: var(--text-primary);
    }
  `,
  body: css`
    flex: 1;
    overflow: auto;
  `,
  table: css`
    border-collapse: collapse;
    width: 100%;

    th {
      position: sticky;
      top: 0;
      background: var(--grid-bg);
      text-align: left;
      font-weight: 600;
      padding: 4px 10px;
      border-bottom: 1px solid var(--border-default);
      white-space: nowrap;
    }

    td {
      padding: 3px 10px;
      border-bottom: 1px solid var(--border-default);
      white-space: nowrap;
    }

    td.num {
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
  `,
  footer: css`
    flex-shrink: 0;
    padding: 5px 12px;
    font-size: 11px;
    color: var(--text-secondary);
    border-top: 1px solid var(--border-default);
  `,
  empty: css`
    padding: 24px;
    color: var(--text-secondary);
    text-align: center;
  `,
};

interface DataInspectorWindowProps {
  data: ParsedChartData | null;
  onClose: () => void;
}

export function DataInspectorWindow({ data, onClose }: DataInspectorWindowProps): React.ReactElement {
  const win = useDialogWindow({ minWidth: 300, minHeight: 200 });

  const rowCount = data?.categories.length ?? 0;
  const shownRows = Math.min(rowCount, MAX_ROWS);

  return (
    <div ref={win.ref} className={s.window} style={win.style}>
      <div className={s.header} onMouseDown={win.onHeaderMouseDown}>
        <span className={s.title}>Query Data</span>
        <button className={s.close} onClick={onClose} aria-label="Close" title="Close">
          x
        </button>
      </div>

      <div className={s.body}>
        {!data || data.series.length === 0 ? (
          <div className={s.empty}>No data — fix the query to see its result here.</div>
        ) : (
          <table className={s.table}>
            <thead>
              <tr>
                <th>Category</th>
                {data.series.map((sr, i) => (
                  <th key={i}>{sr.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.categories.slice(0, MAX_ROWS).map((cat, ri) => (
                <tr key={ri}>
                  <td>{cat}</td>
                  {data.series.map((sr, si) => {
                    const v = sr.values[ri];
                    return (
                      <td key={si} className="num">
                        {typeof v === "number"
                          ? v.toLocaleString(undefined, { maximumFractionDigits: 2 })
                          : String(v ?? "")}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className={s.footer}>
        {rowCount > MAX_ROWS
          ? `Showing the first ${MAX_ROWS.toLocaleString()} of ${rowCount.toLocaleString()} rows`
          : `${rowCount.toLocaleString()} row${rowCount === 1 ? "" : "s"} × ${data?.series.length ?? 0} series`}
      </div>
      {win.resizeHandles}
    </div>
  );
}
