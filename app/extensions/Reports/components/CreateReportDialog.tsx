//! FILENAME: app/extensions/Reports/components/CreateReportDialog.tsx
// PURPOSE: Create a "grid report" — a design-query (pivot-layout DSL) whose result
//   is materialized into a range of grid cells (committed / pivot-like). Reuses the
//   shared Monaco design-query editor + compileDesignQuery.

import React, { useState, useEffect, useCallback } from "react";
import type { DialogProps, ConnectionInfo } from "@api";
import { refreshGridCells } from "../lib/reportRefresh";
import { DesignQueryEditor } from "../../_shared/dsl/pivotLayout/DesignQueryEditor";
import type { DslControlHint } from "../../_shared/dsl/pivotLayout/pivotDslLanguage";
import {
  compileDesignQuery,
  type DesignQueryRequest,
} from "../../_shared/dsl/pivotLayout/designQuery";
import type { BiPivotModelInfo } from "../../_shared/components/types";
import { getControlValue } from "@api/controlValues";
import { reportsBackend } from "../lib/reportsBackend";
import { substituteControlParams } from "../../_shared/dsl/pivotLayout/paramSubstitution";
import { buildControlHints } from "../../_shared/dsl/pivotLayout/controlHints";
import { refreshReportRegions } from "../lib/reportRegions";
import { colLetter } from "../lib/cellRef";
import { dryRunDesignQuery } from "../lib/dryRunDesignQuery";
import { TOKENS } from "../../_shared/lib/themeTokens";

const DSL_TEMPLATE =
  "# Report — ROWS become row groups, VALUES become measure columns.\n" +
  "# Ctrl+Space suggests fields and measures.\n" +
  "ROWS: \n" +
  "VALUES: ";

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
  const [controlHints, setControlHints] = useState<DslControlHint[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const sheetIndex = dialogData.sheetIndex ?? 0;
  const anchorRow = dialogData.anchorRow ?? 0;
  const anchorCol = dialogData.anchorCol ?? 0;

  // Load connections + snapshot the named controls / ribbon filters on open
  // (for @Name autocomplete — a report's FILTERS can bind to either family).
  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    reportsBackend
      .invoke<ConnectionInfo[]>("bi_get_connections", {})
      .then((c) => setConnections(c ?? []))
      .catch(() => setConnections([]));
    setControlHints(buildControlHints());
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
    // Resolve any @ControlName params against current pane-control values, then compile.
    const substituted = substituteControlParams(dslText, getControlValue);
    const compiled = compileDesignQuery(substituted, connectionId, biModel);
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
      refreshGridCells();
      void refreshReportRegions();
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
          // WIDE ENOUGH FOR THE CONVERSATION TO SIT BESIDE THE QUERY. At 560px
          // the AI panel was stacked above a 180px editor and its side-by-side
          // diff was clipped mid-line, which reads as "the change is smaller
          // than it is". Two columns need roughly double.
          width: "1060px",
          maxWidth: "96vw",
          // A HEIGHT BUDGET, which this dialog never had. It was a flat padded
          // box with no `maxHeight` and no `overflow`, so a growing transcript
          // pushed the footer — and the Create button with it — off the bottom
          // of the screen with no way to scroll to it.
          maxHeight: "90vh",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          background: TOKENS.surfaceBg,
          color: TOKENS.textPrimary,
          border: `1px solid ${TOKENS.border}`,
          borderRadius: "8px",
          boxShadow: "0 8px 32px rgba(0,0,0,0.25)",
          padding: "18px 20px",
          boxSizing: "border-box",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexShrink: 0 }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>New report from design query</h2>
          <button
            onClick={onClose}
            style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer", color: "inherit" }}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* THE SCROLLING BODY. Everything that can grow lives here, so the
            footer below stays reachable however long the conversation gets. */}
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden", paddingRight: 2 }}>
        <label style={{ display: "block", fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ width: "100%", boxSizing: "border-box", padding: "6px 8px", marginBottom: 12,
            border: "1px solid ${TOKENS.border}", borderRadius: 4, background: `${TOKENS.inputBg}`, color: "inherit" }}
        />

        <label style={{ display: "block", fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Connection</label>
        <select
          value={connectionId}
          onChange={(e) => setConnectionId(e.target.value)}
          style={{ width: "100%", boxSizing: "border-box", padding: "6px 8px", marginBottom: 12,
            border: "1px solid ${TOKENS.border}", borderRadius: 4, background: `${TOKENS.inputBg}`, color: "inherit" }}
        >
          <option value="">— Select a BI connection —</option>
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>

        <label style={{ display: "block", fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Design query</label>
        <DesignQueryEditor
          value={dslText}
          onChange={setDslText}
          biModel={biModel}
          controlHints={controlHints}
          height="300px"
          assist={{ connectionId, dryRun: dryRunDesignQuery }}
          assistPlacement="blade"
        />
        <div style={{ fontSize: 11, color: `${TOKENS.textSecondary}`, margin: "6px 0 12px" }}>
          Materializes at <strong>{destination}</strong>. Bind a Controls-pane value or ribbon
          filter in FILTERS with <code>@Name</code> — quote names with spaces or dots:{" "}
          <code>@"Products.Category"</code> (type <code>@</code> for suggestions). The report
          re-runs when the bound value changes; an unset control (or a filter at "(All)") removes
          that FILTERS line, showing all rows. Renaming a control breaks its <code>@</code>{" "}
          bindings. Ctrl+Space suggests fields.
        </div>

        {error && (
          <div style={{ fontSize: 12, color: `${TOKENS.dangerFg}`, whiteSpace: "pre-wrap", marginBottom: 12 }}>
            {error}
          </div>
        )}

        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexShrink: 0, paddingTop: 12 }}>
          <button
            onClick={onClose}
            style={{ padding: "6px 14px", borderRadius: 4, border: "1px solid ${TOKENS.border}",
              background: `${TOKENS.panelBg}`, color: "inherit", cursor: "pointer" }}
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={busy}
            style={{ padding: "6px 14px", borderRadius: 4, border: "none",
              background: busy ? "#8bbf9f" : `${TOKENS.accent}`, color: "#fff", cursor: busy ? "default" : "pointer" }}
          >
            {busy ? "Creating…" : "Create report"}
          </button>
        </div>
      </div>
    </div>
  );
}
