//! FILENAME: app/extensions/BusinessIntelligence/components/CreateModelPivotDialog.tsx
// PURPOSE: "PivotTable from Model..." dialog — pick an existing model
//          connection and insert a model-backed pivot at the current selection.
// CONTEXT: Opened from Model > PivotTable from Model... . Range-based pivots
//          keep their own path (Insert > PivotTable...); this dialog is
//          strictly for Calcula-model sources. With no connections in the
//          workbook it offers to open the New Model Connection dialog instead.

import React, { useState, useCallback, useEffect } from "react";
import { useDialogWindow } from "@api/dialogWindow";
import type { DialogProps } from "@api";
import { useGridState, columnToLetter, DialogExtensions } from "@api";
import { getConnections } from "../../_shared/lib/bi-api";
import { createModelPivot } from "../lib/modelPivot";
import { MODEL_DIALOG_ID } from "../manifest";
import type { ConnectionInfo } from "../types";

const styles = {
  backdrop: {
    position: "fixed" as const,
    inset: 0,
    zIndex: 1050,
    background: "rgba(0, 0, 0, 0.45)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  dialog: {
    background: "var(--panel-bg, #ffffff)",
    border: "1px solid var(--border-default, #d0d0d0)",
    borderRadius: 8,
    boxShadow: "0 12px 40px rgba(0, 0, 0, 0.35)",
    width: 380,
    display: "flex",
    flexDirection: "column" as const,
    color: "var(--text-primary, #333333)",
    fontFamily: '"Segoe UI", system-ui, sans-serif',
    fontSize: 13,
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "12px 16px 8px",
    borderBottom: "1px solid var(--border-default, #d0d0d0)",
  },
  title: {
    fontSize: 14,
    fontWeight: 600,
  },
  closeBtn: {
    background: "none",
    border: "none",
    color: "var(--text-secondary, #999)",
    fontSize: 18,
    cursor: "pointer",
    padding: "2px 6px",
    lineHeight: 1,
  },
  body: {
    padding: "12px 16px",
    display: "flex",
    flexDirection: "column" as const,
    gap: 12,
  },
  label: {
    fontSize: 12,
    fontWeight: 500,
    color: "var(--text-secondary, #555)",
  },
  select: {
    padding: "6px 10px",
    fontSize: 13,
    border: "1px solid var(--border-default, #ccc)",
    borderRadius: 4,
    width: "100%",
    boxSizing: "border-box" as const,
    background: "var(--input-bg, #ffffff)",
    color: "var(--text-primary, #333333)",
  },
  emptyState: {
    padding: "10px 12px",
    background: "var(--panel-bg-secondary, #f5f5f5)",
    borderRadius: 4,
    fontSize: 12,
    color: "var(--text-secondary, #555)",
    lineHeight: 1.5,
  },
  destination: {
    fontSize: 12,
    color: "var(--text-secondary, #555)",
  },
  error: {
    fontSize: 12,
    color: "var(--status-error, #d32f2f)",
  },
  footer: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 8,
    padding: "8px 16px 12px",
    borderTop: "1px solid var(--border-default, #d0d0d0)",
  },
  btn: {
    padding: "5px 16px",
    borderRadius: 4,
    border: "1px solid var(--border-default, #c0c0c0)",
    background: "var(--button-bg, #f0f0f0)",
    color: "var(--text-primary, #333)",
    cursor: "pointer",
    fontSize: 13,
  },
  btnPrimary: {
    padding: "5px 16px",
    borderRadius: 4,
    border: "none",
    background: "var(--accent-bg, #0078d4)",
    color: "#ffffff",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 600,
  },
  btnDisabled: {
    padding: "5px 16px",
    borderRadius: 4,
    border: "none",
    background: "var(--button-bg, #e0e0e0)",
    color: "var(--text-secondary, #999)",
    cursor: "not-allowed" as const,
    fontSize: 13,
    fontWeight: 600,
  },
};

export function CreateModelPivotDialog({
  isOpen,
  onClose,
}: DialogProps): React.ReactElement | null {
  // Movable + resizable dialog window (shared @api hook)
  const win = useDialogWindow({ minWidth: 340, minHeight: 200 });

  const gridState = useGridState();
  const [connections, setConnections] = useState<ConnectionInfo[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  // (Re)load connections every time the dialog opens.
  useEffect(() => {
    if (!isOpen) return;
    setLoaded(false);
    setError("");
    getConnections()
      .then((conns) => {
        setConnections(conns);
        setSelectedId((prev) =>
          prev && conns.some((c) => c.id === prev) ? prev : (conns[0]?.id ?? ""),
        );
      })
      .catch((err) => setError(`Failed to load connections: ${err}`))
      .finally(() => setLoaded(true));
  }, [isOpen]);

  const handleNewConnection = useCallback(() => {
    onClose();
    DialogExtensions.openDialog(MODEL_DIALOG_ID, {});
  }, [onClose]);

  const handleInsert = useCallback(async () => {
    if (!selectedId) return;
    try {
      setCreating(true);
      setError("");
      const sel = gridState.selection;
      await createModelPivot(selectedId, {
        row: sel ? sel.startRow : 0,
        col: sel ? sel.startCol : 0,
        sheetIndex: gridState.sheetContext?.activeSheetIndex,
      });
      onClose();
    } catch (err) {
      setError(`Failed to create pivot: ${err}`);
    } finally {
      setCreating(false);
    }
  }, [selectedId, gridState, onClose]);

  if (!isOpen) return null;

  const sel = gridState.selection;
  const destCell = `${columnToLetter(sel ? sel.startCol : 0)}${(sel ? sel.startRow : 0) + 1}`;
  const hasConnections = connections.length > 0;

  return (
    <div style={styles.backdrop} onClick={onClose}>
      <div
        ref={win.ref}
        style={{ ...styles.dialog, position: "relative", ...win.style }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={styles.header} onMouseDown={win.onHeaderMouseDown}>
          <span style={styles.title}>PivotTable from Model</span>
          <button style={styles.closeBtn} onClick={onClose} title="Close">
            x
          </button>
        </div>

        <div style={styles.body}>
          {!loaded ? (
            <div style={styles.emptyState}>Loading connections...</div>
          ) : hasConnections ? (
            <>
              <div>
                <div style={styles.label}>Model Connection</div>
                <select
                  style={styles.select}
                  value={selectedId}
                  onChange={(e) => setSelectedId(e.target.value)}
                >
                  {connections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                      {c.isConnected ? "" : " (not connected)"}
                    </option>
                  ))}
                </select>
              </div>
              <div style={styles.destination}>Destination: Cell {destCell}</div>
            </>
          ) : (
            <div style={styles.emptyState}>
              This workbook has no model connections yet. Create one first —
              the connection dialog also offers to insert a PivotTable when
              it finishes.
            </div>
          )}

          {error && <div style={styles.error}>{error}</div>}
        </div>

        <div style={styles.footer}>
          <button style={styles.btn} onClick={handleNewConnection}>
            New Model Connection...
          </button>
          <button style={styles.btn} onClick={onClose}>
            Cancel
          </button>
          {hasConnections && (
            <button
              style={creating || !selectedId ? styles.btnDisabled : styles.btnPrimary}
              onClick={handleInsert}
              disabled={creating || !selectedId}
            >
              {creating ? "Creating..." : "Insert PivotTable"}
            </button>
          )}
        </div>
        {win.resizeHandles}
      </div>
    </div>
  );
}
