//! FILENAME: app/extensions/Reports/components/ManageReportsDialog.tsx
// PURPOSE: List grid reports with Refresh (re-run the query, resolving @Control
//   params) and Delete actions. Slice-1 had no management UI; this adds it.

import React, { useState, useEffect, useCallback } from "react";
import type { DialogProps } from "@api";
import { listReports, refreshOneReport, deleteReport } from "../lib/reportRefresh";
import type { ReportInfo } from "../types";

function colLetter(col: number): string {
  let n = col;
  let s = "";
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

const btn: React.CSSProperties = {
  padding: "4px 10px",
  borderRadius: 4,
  border: "1px solid var(--border-color, #d0d7de)",
  background: "var(--bg-secondary, #f3f4f6)",
  color: "inherit",
  cursor: "pointer",
  fontSize: 12,
};

export function ManageReportsDialog(props: DialogProps): React.ReactElement | null {
  const { isOpen, onClose } = props;
  const [reports, setReports] = useState<ReportInfo[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    listReports()
      .then(setReports)
      .catch(() => setReports([]));
  }, []);

  useEffect(() => {
    if (isOpen) {
      setError(null);
      reload();
    }
  }, [isOpen, reload]);

  const onRefresh = async (r: ReportInfo) => {
    setBusy(r.id);
    setError(null);
    try {
      await refreshOneReport(r);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const onDelete = async (r: ReportInfo) => {
    setBusy(r.id);
    setError(null);
    try {
      await deleteReport(r.id);
      reload();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.35)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: "560px",
          maxWidth: "92vw",
          maxHeight: "80vh",
          overflow: "auto",
          background: "var(--bg-primary, #fff)",
          color: "var(--text-primary, #1a1a1a)",
          border: "1px solid var(--border-color, #d0d7de)",
          borderRadius: "8px",
          boxShadow: "0 8px 32px rgba(0,0,0,0.25)",
          padding: "18px 20px",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>Reports</h2>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer", color: "inherit" }} aria-label="Close">
            ×
          </button>
        </div>

        {reports.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--text-secondary, #666)", padding: "12px 0" }}>
            No reports yet. Create one from <strong>Data ▸ Report from Design Query…</strong>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {reports.map((r) => (
              <div
                key={r.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "8px 10px",
                  border: "1px solid var(--border-color, #e5e7eb)",
                  borderRadius: 6,
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {r.name}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-secondary, #666)" }}>
                    Sheet {r.sheetIndex + 1} · {colLetter(r.anchorCol)}
                    {r.anchorRow + 1}
                  </div>
                </div>
                <button style={btn} disabled={busy === r.id} onClick={() => onRefresh(r)}>
                  {busy === r.id ? "…" : "Refresh"}
                </button>
                <button
                  style={{ ...btn, borderColor: "var(--error-color, #b42318)", color: "var(--error-color, #b42318)" }}
                  disabled={busy === r.id}
                  onClick={() => onDelete(r)}
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        )}

        {error && (
          <div style={{ fontSize: 12, color: "var(--error-color, #b42318)", whiteSpace: "pre-wrap", marginTop: 12 }}>
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
