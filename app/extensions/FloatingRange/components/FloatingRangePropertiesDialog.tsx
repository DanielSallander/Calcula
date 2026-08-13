//! FILENAME: app/extensions/FloatingRange/components/FloatingRangePropertiesDialog.tsx
// PURPOSE: Minimal properties dialog for a floating range: name field +
//          row/col count steppers (backend bounds 1..1000 / 1..256).
// CONTEXT: useDialogWindow is MANDATORY for dialogs (movable + resizable).
//          Deliberately NOT the Controls PropertiesPane — a pane with
//          formula-bound counts is the v2 slot; nothing here precludes it.

import React, { useEffect, useState } from "react";
import { useDialogWindow } from "@api/dialogWindow";
import type { DialogProps } from "@api/uiTypes";
import {
  updateFloatingRange,
  renameFloatingRange,
  FLOATING_RANGE_MAX_ROWS,
  FLOATING_RANGE_MAX_COLS,
} from "@api/floatingRanges";
import { AppEvents, emitAppEvent } from "@api/events";
import { requestOverlayRedraw } from "@api/gridOverlays";
import {
  getFloatingRangeById,
  upsertFromInfo,
  syncFloatingRangeRegions,
} from "../lib/floatingRangeStore";
import { invalidateFrCache } from "../rendering/frRenderer";

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.25)",
    zIndex: 1000,
  },
  dialog: {
    position: "fixed",
    left: "50%",
    top: "40%",
    transform: "translate(-50%, -50%)",
    background: "var(--dialog-bg, #ffffff)",
    color: "var(--dialog-fg, #1a1a1a)",
    border: "1px solid #c8c8c8",
    borderRadius: 6,
    boxShadow: "0 8px 32px rgba(0,0,0,0.24)",
    zIndex: 1001,
    display: "flex",
    flexDirection: "column",
    fontSize: 13,
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "8px 12px",
    borderBottom: "1px solid #e0e0e0",
    cursor: "move",
    userSelect: "none",
  },
  title: { fontWeight: 600 },
  closeBtn: {
    border: "none",
    background: "transparent",
    cursor: "pointer",
    fontSize: 13,
    padding: "2px 6px",
  },
  body: {
    padding: 12,
    display: "flex",
    flexDirection: "column",
    gap: 10,
    flex: 1,
  },
  label: { marginBottom: 4, color: "#555" },
  input: {
    width: "100%",
    padding: "4px 6px",
    border: "1px solid #bbb",
    borderRadius: 3,
    fontSize: 13,
    boxSizing: "border-box",
  },
  row: { display: "flex", gap: 10 },
  stepper: { width: 90 },
  warning: { color: "#b42318" },
  footer: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 8,
    padding: "8px 12px",
    borderTop: "1px solid #e0e0e0",
  },
  btn: {
    padding: "4px 14px",
    border: "1px solid #bbb",
    borderRadius: 3,
    background: "#f5f5f5",
    cursor: "pointer",
    fontSize: 13,
  },
  btnPrimary: {
    padding: "4px 14px",
    border: "1px solid #1a6b3c",
    borderRadius: 3,
    background: "#217346",
    color: "#fff",
    cursor: "pointer",
    fontSize: 13,
  },
};

export function FloatingRangePropertiesDialog(
  props: DialogProps,
): React.ReactElement | null {
  const { isOpen, onClose, data } = props;
  const win = useDialogWindow({ minWidth: 320, minHeight: 220 });

  const frId = typeof data?.frId === "string" ? data.frId : null;

  const [name, setName] = useState("");
  const [rows, setRows] = useState(1);
  const [cols, setCols] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    win.reset();
    setError(null);
    setBusy(false);
    const entry = frId ? getFloatingRangeById(frId) : null;
    if (entry) {
      setName(entry.name);
      setRows(entry.rows);
      setCols(entry.cols);
    }
    // `win` is stable for the dialog's lifetime; re-running on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, frId]);

  if (!isOpen || !frId) return null;
  const entry = getFloatingRangeById(frId);
  if (!entry) return null;

  const clampRows = (v: number) =>
    Math.max(1, Math.min(FLOATING_RANGE_MAX_ROWS, Math.trunc(v) || 1));
  const clampCols = (v: number) =>
    Math.max(1, Math.min(FLOATING_RANGE_MAX_COLS, Math.trunc(v) || 1));

  const apply = async () => {
    setError(null);
    setBusy(true);
    try {
      const nextRows = clampRows(rows);
      const nextCols = clampCols(cols);
      if (nextRows !== entry.rows || nextCols !== entry.cols) {
        const info = await updateFloatingRange(frId, {
          rowCount: nextRows,
          colCount: nextCols,
        });
        upsertFromInfo(info);
        invalidateFrCache(frId);
      }
      const trimmed = name.trim();
      if (trimmed && trimmed !== entry.name) {
        // Renaming repairs every referencing formula and ENDS the undo history
        // (sheet-rename machinery) — same silent behavior as a sheet rename.
        const info = await renameFloatingRange(frId, trimmed);
        upsertFromInfo(info);
      }
      syncFloatingRangeRegions();
      requestOverlayRedraw();
      emitAppEvent(AppEvents.GRID_REFRESH);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div style={styles.backdrop} onMouseDown={onClose} />
      <div
        ref={win.ref}
        data-fr-properties-dialog=""
        style={{ ...styles.dialog, width: 360, ...win.style }}
      >
        <div style={styles.header} onMouseDown={win.onHeaderMouseDown}>
          <span style={styles.title}>Floating Range Properties</span>
          <button type="button" style={styles.closeBtn} onClick={onClose}>
            X
          </button>
        </div>

        <div style={styles.body}>
          <div>
            <div style={styles.label}>Name</div>
            <input
              style={styles.input}
              data-fr-name-input=""
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div style={styles.row}>
            <div style={styles.stepper}>
              <div style={styles.label}>Rows</div>
              <input
                type="number"
                min={1}
                max={FLOATING_RANGE_MAX_ROWS}
                style={styles.input}
                data-fr-rows-input=""
                value={rows}
                onChange={(e) => setRows(clampRows(Number(e.target.value)))}
              />
            </div>
            <div style={styles.stepper}>
              <div style={styles.label}>Columns</div>
              <input
                type="number"
                min={1}
                max={FLOATING_RANGE_MAX_COLS}
                style={styles.input}
                data-fr-cols-input=""
                value={cols}
                onChange={(e) => setCols(clampCols(Number(e.target.value)))}
              />
            </div>
          </div>

          <div style={{ color: "#777", fontSize: 12 }}>
            Shrinking hides rows/columns without deleting their cells; growing
            restores them. Renaming updates every formula that references this
            range and clears the undo history.
          </div>

          {error ? <div style={styles.warning}>{error}</div> : null}
        </div>

        <div style={styles.footer}>
          <button type="button" style={styles.btn} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            style={styles.btnPrimary}
            data-fr-apply-button=""
            onClick={() => void apply()}
            disabled={busy}
          >
            OK
          </button>
        </div>

        {win.resizeHandles}
      </div>
    </>
  );
}
