//! FILENAME: app/extensions/Reports/components/EditReportDialog.tsx
// PURPOSE: Edit an existing grid report's name + design-query DSL and re-run it.
//   Opened from the report context menu / contextual ribbon tab with
//   data = { reportId }. Save = compile (after @param substitution) -> one
//   refresh_report call that re-materializes AND persists the new DSL/name
//   (single undo step).

import React, { useState, useEffect, useCallback } from "react";
import type { DialogProps } from "@api";
import { DesignQueryEditor } from "../../_shared/dsl/pivotLayout/DesignQueryEditor";
import type { DslControlHint } from "../../_shared/dsl/pivotLayout/pivotDslLanguage";
import type { BiPivotModelInfo } from "../../_shared/components/types";
import { buildControlHints } from "../../_shared/dsl/pivotLayout/controlHints";
import { reportsBackend } from "../lib/reportsBackend";
import { refreshReport, refreshGridCells } from "../lib/reportRefresh";
import { refreshReportRegions, getCachedReport } from "../lib/reportRegions";
import { cellRef } from "../lib/cellRef";
import type { ReportInfo } from "../types";

interface EditReportDialogData {
  reportId?: string;
}

export function EditReportDialog(props: DialogProps): React.ReactElement | null {
  const { isOpen, onClose, data } = props;
  const reportId = (data as EditReportDialogData | undefined)?.reportId;

  const [report, setReport] = useState<ReportInfo | null>(null);
  const [name, setName] = useState("");
  const [dslText, setDslText] = useState("");
  const [biModel, setBiModel] = useState<BiPivotModelInfo | null>(null);
  const [controlHints, setControlHints] = useState<DslControlHint[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Load the report + its connection's model + control hints on open.
  useEffect(() => {
    if (!isOpen || !reportId) return;
    setError(null);
    const cached = getCachedReport(reportId);
    if (!cached) {
      setReport(null);
      setError("This report no longer exists.");
      return;
    }
    setReport(cached);
    setName(cached.name);
    setDslText(cached.dslText);
    setBiModel(null);
    reportsBackend
      .invoke<BiPivotModelInfo | null>("get_connection_bi_model", {
        connectionId: cached.connectionId,
      })
      .then((m) => setBiModel(m ?? null))
      .catch(() => setBiModel(null));
    setControlHints(buildControlHints());
  }, [isOpen, reportId]);

  const handleSave = useCallback(async () => {
    if (!report) return;
    setError(null);
    if (!dslText.trim()) {
      setError("Please enter a design query.");
      return;
    }
    setBusy(true);
    try {
      const result = await refreshReport(
        { ...report, dslText },
        { updateDsl: { dslText, name: name.trim() || report.name } },
      );
      if (!result.ok) {
        setError(result.message ?? "The report could not be refreshed.");
        return;
      }
      refreshGridCells();
      await refreshReportRegions();
      if ((result.overwrittenCellCount ?? 0) > 0) {
        setError(
          `Saved. Note: ${result.overwrittenCellCount} existing cell(s) outside the previous report area were overwritten (Ctrl+Z to undo).`,
        );
        return;
      }
      onClose();
    } finally {
      setBusy(false);
    }
  }, [report, dslText, name, onClose]);

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
          background: "var(--bg-primary, #fff)",
          color: "var(--text-primary, #1a1a1a)",
          border: "1px solid var(--border-color, #d0d7de)",
          borderRadius: "8px",
          boxShadow: "0 8px 32px rgba(0,0,0,0.25)",
          padding: "18px 20px",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>Edit report</h2>
          <button
            onClick={onClose}
            style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer", color: "inherit" }}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {report && (
          <>
            <label style={{ display: "block", fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={{ width: "100%", boxSizing: "border-box", padding: "6px 8px", marginBottom: 12,
                border: "1px solid var(--border-color, #d0d7de)", borderRadius: 4, background: "var(--input-bg, #fff)", color: "inherit" }}
            />

            <label style={{ display: "block", fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Design query</label>
            <DesignQueryEditor
              value={dslText}
              onChange={setDslText}
              biModel={biModel}
              controlHints={controlHints}
              height="180px"
            />
            <div style={{ fontSize: 11, color: "var(--text-secondary, #666)", margin: "6px 0 12px" }}>
              Anchored at <strong>{cellRef(report.anchorRow, report.anchorCol)}</strong>. Saving
              re-runs the query and replaces the report's cells (one Ctrl+Z step).
            </div>
          </>
        )}

        {error && (
          <div style={{ fontSize: 12, color: "var(--error-color, #b42318)", whiteSpace: "pre-wrap", marginBottom: 12 }}>
            {error}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            onClick={onClose}
            style={{ padding: "6px 14px", borderRadius: 4, border: "1px solid var(--border-color, #d0d7de)",
              background: "var(--bg-secondary, #f3f4f6)", color: "inherit", cursor: "pointer" }}
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={busy || !report}
            style={{ padding: "6px 14px", borderRadius: 4, border: "none",
              background: busy ? "#8bbf9f" : "var(--accent-color, #2e7d5b)", color: "#fff",
              cursor: busy || !report ? "default" : "pointer" }}
          >
            {busy ? "Saving…" : "Save & refresh"}
          </button>
        </div>
      </div>
    </div>
  );
}
