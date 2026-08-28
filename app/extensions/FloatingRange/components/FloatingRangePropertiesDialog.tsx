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
  type FloatingRangePatch,
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
    overflowY: "auto",
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
  fieldset: {
    border: "1px solid #e0e0e0",
    borderRadius: 4,
    padding: "8px 10px 10px",
    margin: 0,
  },
  legend: { color: "#555", padding: "0 4px", fontSize: 12 },
  check: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "2px 0",
    cursor: "pointer",
  },
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
  // Taller than the original 220: the "Show" group has to fit without the
  // footer buttons being pushed out of a resized-down window.
  const win = useDialogWindow({ minWidth: 320, minHeight: 420 });

  const frId = typeof data?.frId === "string" ? data.frId : null;

  const [name, setName] = useState("");
  const [rows, setRows] = useState(1);
  const [cols, setCols] = useState(1);
  const [showTitle, setShowTitle] = useState(true);
  const [showColumnHeaders, setShowColumnHeaders] = useState(true);
  const [showRowHeaders, setShowRowHeaders] = useState(true);
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
      setShowTitle(entry.showTitle);
      setShowColumnHeaders(entry.showColumnHeaders);
      setShowRowHeaders(entry.showRowHeaders);
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
      // One patch for size AND chrome: both change the DERIVED frame, so
      // sending them together means one backend write and one undo step.
      // Only the fields that actually differ are sent — an absent flag means
      // "leave it alone", and a no-op patch records no undo entry at all.
      const patch: FloatingRangePatch = {};
      if (nextRows !== entry.rows) patch.rowCount = nextRows;
      if (nextCols !== entry.cols) patch.colCount = nextCols;
      if (showTitle !== entry.showTitle) patch.showTitle = showTitle;
      if (showColumnHeaders !== entry.showColumnHeaders) {
        patch.showColumnHeaders = showColumnHeaders;
      }
      if (showRowHeaders !== entry.showRowHeaders) {
        patch.showRowHeaders = showRowHeaders;
      }
      if (Object.keys(patch).length > 0) {
        const info = await updateFloatingRange(frId, patch);
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

          <fieldset style={styles.fieldset}>
            <legend style={styles.legend}>Show</legend>
            <label style={styles.check}>
              <input
                type="checkbox"
                data-fr-show-title=""
                checked={showTitle}
                onChange={(e) => setShowTitle(e.target.checked)}
              />
              Title bar (the range&apos;s name)
            </label>
            <label style={styles.check}>
              <input
                type="checkbox"
                data-fr-show-column-headers=""
                checked={showColumnHeaders}
                onChange={(e) => setShowColumnHeaders(e.target.checked)}
              />
              Column headers (A, B, C…)
            </label>
            <label style={styles.check}>
              <input
                type="checkbox"
                data-fr-show-row-headers=""
                checked={showRowHeaders}
                onChange={(e) => setShowRowHeaders(e.target.checked)}
              />
              Row gutter (1, 2, 3…)
            </label>
          </fieldset>

          <div style={{ color: "#777", fontSize: 12 }}>
            Hiding a strip makes the range smaller — the cells stay put and the
            frame shrinks around them. With the title bar hidden there is
            nothing left to grab, so in Design Mode a drag anywhere on the range
            moves it.
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
