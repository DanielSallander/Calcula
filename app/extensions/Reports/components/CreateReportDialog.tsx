//! FILENAME: app/extensions/Reports/components/CreateReportDialog.tsx
// PURPOSE: Create a "grid report" — a design-query (pivot-layout DSL) whose result
//   is materialized into a range of grid cells (committed / pivot-like). Reuses the
//   shared Monaco design-query editor + compileDesignQuery.

import React, { useState, useEffect, useCallback } from "react";
import type { DialogProps, ConnectionInfo } from "@api";
import { emitAppEvent, AppEvents } from "@api/events";
import { DesignQueryEditor } from "../../_shared/dsl/pivotLayout/DesignQueryEditor";
import {
  compileDesignQuery,
  type DesignQueryRequest,
} from "../../_shared/dsl/pivotLayout/designQuery";
import type { BiPivotModelInfo } from "../../_shared/components/types";
import { reportsBackend } from "../lib/reportsBackend";

const DSL_TEMPLATE =
  "# Report — ROWS become row groups, VALUES become measure columns.\n" +
  "# Ctrl+Space suggests fields and measures.\n" +
  "ROWS: \n" +
  "VALUES: ";

function colLetter(col: number): string {
  let n = col;
  let s = "";
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

interface ReportDialogData {
  sheetIndex?: number;
  anchorRow?: number;
  anchorCol?: number;
}

interface CreateReportResult {
  reportId: string;
  rowCount: number;
  colCount: number;
  overwrittenCellCount: number;
}

export function CreateReportDialog(props: DialogProps): React.ReactElement | null {
  const { isOpen, onClose, data } = props;
  const dialogData = (data ?? {}) as ReportDialogData;

  const [name, setName] = useState("Report");
  const [connectionId, setConnectionId] = useState("");
  const [dslText, setDslText] = useState(DSL_TEMPLATE);
  const [connections, setConnections] = useState<ConnectionInfo[]>([]);
  const [biModel, setBiModel] = useState<BiPivotModelInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const sheetIndex = dialogData.sheetIndex ?? 0;
  const anchorRow = dialogData.anchorRow ?? 0;
  const anchorCol = dialogData.anchorCol ?? 0;

  // Load connections on open.
  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    reportsBackend
      .invoke<ConnectionInfo[]>("bi_get_connections", {})
      .then((c) => setConnections(c ?? []))
      .catch(() => setConnections([]));
  }, [isOpen]);

  // Fetch the selected connection's model (for autocomplete + compile).
  useEffect(() => {
    let cancelled = false;
    if (!connectionId) {
      setBiModel(null);
      return;
    }
    reportsBackend
      .invoke<BiPivotModelInfo | null>("get_connection_bi_model", { connectionId })
      .then((m) => {
        if (!cancelled) setBiModel(m ?? null);
      })
      .catch(() => {
        if (!cancelled) setBiModel(null);
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId]);

  const handleCreate = useCallback(async () => {
    setError(null);
    if (!connectionId) {
      setError("Please choose a BI connection.");
      return;
    }
    if (!dslText.trim()) {
      setError("Please enter a design query.");
      return;
    }
    if (!biModel) {
      setError("The connection's model is still loading. Try again in a moment.");
      return;
    }
    const compiled = compileDesignQuery(dslText, connectionId, biModel);
    if (!compiled.request) {
      setError(
        compiled.errors.map((e) => `Line ${e.location.line}: ${e.message}`).join("\n") ||
          "The design query has errors.",
      );
      return;
    }
    setBusy(true);
    try {
      const result = await reportsBackend.invoke<CreateReportResult>("create_report", {
        request: {
          name: name.trim() || "Report",
          dslText,
          sheetIndex,
          anchorRow,
          anchorCol,
          query: compiled.request satisfies DesignQueryRequest,
        },
      });
      emitAppEvent(AppEvents.GRID_REFRESH);
      if (result && result.overwrittenCellCount > 0) {
        // Inform the user their cells were replaced (Ctrl+Z reverts it).
        setError(
          `Report created. Note: ${result.overwrittenCellCount} existing cell(s) were overwritten (Ctrl+Z to undo).`,
        );
        setBusy(false);
        return;
      }
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [name, connectionId, dslText, biModel, sheetIndex, anchorRow, anchorCol, onClose]);

  if (!isOpen) return null;

  const destination = `${colLetter(anchorCol)}${anchorRow + 1}`;

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
          <h2 style={{ margin: 0, fontSize: 16 }}>New report from design query</h2>
          <button
            onClick={onClose}
            style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer", color: "inherit" }}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <label style={{ display: "block", fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ width: "100%", boxSizing: "border-box", padding: "6px 8px", marginBottom: 12,
            border: "1px solid var(--border-color, #d0d7de)", borderRadius: 4, background: "var(--input-bg, #fff)", color: "inherit" }}
        />

        <label style={{ display: "block", fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Connection</label>
        <select
          value={connectionId}
          onChange={(e) => setConnectionId(e.target.value)}
          style={{ width: "100%", boxSizing: "border-box", padding: "6px 8px", marginBottom: 12,
            border: "1px solid var(--border-color, #d0d7de)", borderRadius: 4, background: "var(--input-bg, #fff)", color: "inherit" }}
        >
          <option value="">— Select a BI connection —</option>
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>

        <label style={{ display: "block", fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Design query</label>
        <DesignQueryEditor value={dslText} onChange={setDslText} biModel={biModel} height="180px" />
        <div style={{ fontSize: 11, color: "var(--text-secondary, #666)", margin: "6px 0 12px" }}>
          Materializes at <strong>{destination}</strong>. Ctrl+Space suggests fields and measures.
        </div>

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
            onClick={handleCreate}
            disabled={busy}
            style={{ padding: "6px 14px", borderRadius: 4, border: "none",
              background: busy ? "#8bbf9f" : "var(--accent-color, #2e7d5b)", color: "#fff", cursor: busy ? "default" : "pointer" }}
          >
            {busy ? "Creating…" : "Create report"}
          </button>
        </div>
      </div>
    </div>
  );
}
