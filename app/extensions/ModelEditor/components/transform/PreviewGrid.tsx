// FILENAME: app/extensions/ModelEditor/components/transform/PreviewGrid.tsx
// PURPOSE: The preview pane of the transformation editor: the sampled rows a
//          candidate pipeline produces as of the selected step, with the
//          truncated/sampled notes that keep a SAMPLE from being read as the
//          number a refresh will produce.

import React from "react";
import type { TransformPreviewResult } from "@api";
import { styles } from "../editorShared";
import { ME } from "../theme";

export function PreviewGrid({
  title,
  result,
  busy,
  error,
  disabledReason,
  onRefresh,
  onCancel,
}: {
  /** e.g. "Preview as of step 2 — Rename column". */
  title: string;
  result: TransformPreviewResult | null;
  busy: boolean;
  /** A thrown error (no connection, unknown table); engine step failures come
   *  back inside `result.diagnostics` instead. */
  error: string | null;
  /** Set when a preview cannot run at all (unbound table) — explains why. */
  disabledReason?: string | null;
  onRefresh: () => void;
  onCancel: () => void;
}): React.ReactElement {
  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <span style={{ ...styles.label, flex: 1, minWidth: 0 }}>{title}</span>
        {busy && (
          <span style={{ ...styles.hint, whiteSpace: "nowrap" }}>Sampling the source…</span>
        )}
        <button
          style={styles.smallBtn}
          disabled={busy || Boolean(disabledReason)}
          onClick={onRefresh}
        >
          Refresh
        </button>
        <button style={styles.smallBtn} disabled={!busy} onClick={onCancel}>
          Cancel
        </button>
      </div>

      {disabledReason && <div style={styles.hint}>{disabledReason}</div>}

      {!disabledReason && error && (
        <div
          style={{
            fontSize: 12,
            color: ME.dangerFg,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            marginBottom: 6,
          }}
        >
          {error}
        </div>
      )}

      {!disabledReason &&
        (result?.diagnostics ?? []).map((d, i) => (
          <div
            key={i}
            style={{
              fontSize: 12,
              color: d.severity === "error" ? ME.dangerFg : ME.warnFg,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              marginBottom: 6,
            }}
          >
            Step {d.index + 1}
            {d.stepType ? ` (${d.stepType})` : ""}: {d.message}
          </div>
        ))}

      {!disabledReason && result && result.columns.length > 0 && (
        <>
          <div
            style={{
              flex: 1,
              minHeight: 120,
              overflow: "auto",
              border: `1px solid ${ME.border}`,
              borderRadius: 4,
              background: ME.surface,
            }}
          >
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead>
                <tr>
                  {result.columns.map((c) => (
                    <th
                      key={c}
                      style={{
                        ...styles.th,
                        position: "sticky",
                        top: 0,
                        background: ME.sunken,
                        zIndex: 1,
                      }}
                    >
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row, i) => (
                  <tr key={i}>
                    {row.map((cell, j) => (
                      <td
                        key={j}
                        style={{
                          ...styles.td,
                          whiteSpace: "nowrap",
                          maxWidth: 260,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          ...(cell === null ? styles.muted : {}),
                        }}
                        title={cell ?? undefined}
                      >
                        {cell === null ? "—" : cell}
                      </td>
                    ))}
                  </tr>
                ))}
                {result.rows.length === 0 && (
                  <tr>
                    <td style={{ ...styles.td, ...styles.muted }} colSpan={result.columns.length}>
                      No rows reach this step.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div style={{ ...styles.hint, marginTop: 4 }}>
            {result.rowCount} row{result.rowCount === 1 ? "" : "s"} shown
            {result.truncated ? " — the sample hit its row cap, so the source has more." : "."}
          </div>
          {result.sampled && (
            <div
              style={{
                marginTop: 4,
                padding: "4px 8px",
                background: ME.warnBg,
                color: ME.warnFg,
                border: "1px solid #f0d98c",
                borderRadius: 3,
                fontSize: 11,
              }}
            >
              A step in this prefix aggregates or reorders across the whole table, and the sample is
              only part of it. These figures are indicative — the refresh recomputes them over every
              row.
            </div>
          )}
        </>
      )}

      {!disabledReason && !result && !error && !busy && (
        <div style={styles.hint}>No preview yet.</div>
      )}
    </div>
  );
}
