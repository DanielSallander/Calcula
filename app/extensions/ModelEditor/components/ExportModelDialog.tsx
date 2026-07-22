//! FILENAME: app/extensions/ModelEditor/components/ExportModelDialog.tsx
// PURPOSE: "Export Model..." chooser — pick which model connection to export
//          when the workbook has more than one.
// CONTEXT: Opened from Model > Export Model... . With a single connection the
//          menu action exports directly and this dialog never shows. Export
//          writes a standalone ModelBundle copy; the model still lives in —
//          and saves with — the workbook.

import React, { useState, useCallback, useEffect } from "react";
import { useDialogWindow } from "@api/dialogWindow";
import type { DialogProps, ConnectionInfo } from "@api";
import { biGetConnections, biModelExportToFile, showToast } from "@api";

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
    width: 360,
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
  hint: {
    fontSize: 12,
    color: "var(--text-secondary, #555)",
    lineHeight: 1.5,
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

export function ExportModelDialog({
  isOpen,
  onClose,
}: DialogProps): React.ReactElement | null {
  // Movable + resizable dialog window (shared @api hook)
  const win = useDialogWindow({ minWidth: 320, minHeight: 170 });

  const [connections, setConnections] = useState<ConnectionInfo[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");

  // (Re)load connections every time the dialog opens.
  useEffect(() => {
    if (!isOpen) return;
    setError("");
    biGetConnections()
      .then((conns) => {
        setConnections(conns);
        setSelectedId((prev) =>
          prev && conns.some((c) => c.id === prev) ? prev : (conns[0]?.id ?? ""),
        );
      })
      .catch((err) => setError(`Failed to load connections: ${err}`));
  }, [isOpen]);

  const handleExport = useCallback(async () => {
    const conn = connections.find((c) => c.id === selectedId);
    if (!conn) return;
    try {
      setExporting(true);
      setError("");
      const path = await biModelExportToFile(conn.id, conn.name);
      if (path) {
        showToast(`Model "${conn.name}" exported to ${path}`, { type: "success" });
        onClose();
      }
      // null = user cancelled the save dialog; keep this dialog open.
    } catch (err) {
      setError(`Export failed: ${err}`);
    } finally {
      setExporting(false);
    }
  }, [connections, selectedId, onClose]);

  if (!isOpen) return null;

  return (
    <div style={styles.backdrop} onClick={onClose}>
      <div
        ref={win.ref}
        style={{ ...styles.dialog, position: "relative", ...win.style }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={styles.header} onMouseDown={win.onHeaderMouseDown}>
          <span style={styles.title}>Export Model</span>
          <button style={styles.closeBtn} onClick={onClose} title="Close">
            x
          </button>
        </div>

        <div style={styles.body}>
          <div>
            <div style={styles.label}>Model to export</div>
            <select
              style={styles.select}
              value={selectedId}
              onChange={(e) => setSelectedId(e.target.value)}
            >
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div style={styles.hint}>
            Writes a standalone model file for sharing or versioning. The model
            keeps living in — and saving with — this workbook.
          </div>
          {error && <div style={styles.error}>{error}</div>}
        </div>

        <div style={styles.footer}>
          <button style={styles.btn} onClick={onClose}>
            Cancel
          </button>
          <button
            style={exporting || !selectedId ? styles.btnDisabled : styles.btnPrimary}
            onClick={handleExport}
            disabled={exporting || !selectedId}
          >
            {exporting ? "Exporting..." : "Export..."}
          </button>
        </div>
        {win.resizeHandles}
      </div>
    </div>
  );
}
