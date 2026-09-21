//! FILENAME: app/extensions/RemoveDuplicates/components/RemoveDuplicatesDialog.tsx
// PURPOSE: Dialog for the Remove Duplicates data tool.
// CONTEXT: Allows users to select columns, toggle headers, and remove duplicate rows.

import React, { useState, useEffect, useCallback, useRef } from "react";
import type { DialogProps } from "@api/uiTypes";
import {
  detectDataRegion,
  getViewportCells,
  indexToCol,
  removeDuplicates,
} from "@api";
import { DialogFieldGrid, dialogWidth, dialogHeight } from "@api/dialogLayout";
import { useDialogWindow } from "@api/dialogWindow";

// ============================================================================
// Styles (using CSS variables from the app theme)
// ============================================================================

const v = (name: string) => `var(${name})`;

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
    background: v("--panel-bg"),
    border: `1px solid ${v("--border-default")}`,
    borderRadius: 8,
    boxShadow: "0 12px 40px rgba(0, 0, 0, 0.5)",
    // No fixed `width` here: it is chosen per render from how many columns the
    // region actually has (see `boxWidth`). A 4-column sheet has no use for the
    // room a 20-column import needs, and widening it unconditionally just
    // strings four short labels across an empty row.
    // The ceiling is on the BOX, not on the list: the list is the flexing child,
    // so a taller dialog shows more columns instead of more dead space.
    maxHeight: dialogHeight(560),
    display: "flex",
    flexDirection: "column" as const,
    color: v("--text-primary"),
    fontFamily: '"Segoe UI", system-ui, sans-serif',
    fontSize: 13,
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "12px 16px",
    borderBottom: `1px solid ${v("--border-default")}`,
    // The title bar is also the drag handle, so it must never be squeezed.
    flexShrink: 0,
    cursor: "move",
  },
  title: {
    fontWeight: 600,
    fontSize: 15,
  },
  closeBtn: {
    background: "transparent",
    border: "none",
    color: v("--text-secondary"),
    cursor: "pointer",
    padding: "4px 8px",
    borderRadius: 4,
    fontSize: 14,
    lineHeight: 1,
  },
  body: {
    padding: "16px",
    display: "flex",
    flexDirection: "column" as const,
    gap: 12,
    // Takes the space the header and footer leave, and passes it to the list.
    flex: 1,
    minHeight: 0,
  },
  // One row for every control that acts on the whole list: the headers toggle
  // relabels it, Select All / Unselect All tick it. Three stacked rows cost
  // ~44px of the height the list wanted.
  controlRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    flexWrap: "wrap" as const,
    flexShrink: 0,
    paddingBottom: 6,
    borderBottom: `1px solid ${v("--border-default")}`,
  },
  headerCheckboxRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    cursor: "pointer",
    fontSize: 13,
  },
  selectButtons: {
    display: "flex",
    gap: 8,
  },
  selectBtn: {
    padding: "3px 10px",
    fontSize: 12,
    borderRadius: 3,
    cursor: "pointer",
    background: v("--grid-bg"),
    color: v("--text-primary"),
    border: `1px solid ${v("--border-default")}`,
  },
  columnList: {
    // The list is what grows. A hard 200px cap showed ~8 rows of a 20-column
    // import through a straw that the user had no way to widen; now it takes
    // whatever the body has left, and dragging the dialog taller shows more.
    flex: "1 1 auto",
    minHeight: 140,
    overflowY: "auto" as const,
    border: `1px solid ${v("--border-default")}`,
    borderRadius: 4,
    padding: "4px 0",
  },
  checkboxRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    cursor: "pointer",
    fontSize: 13,
    padding: "3px 10px",
    minWidth: 0,
  },
  // A long header name must not push a grid track wide enough to lose a column.
  columnLabel: {
    overflow: "hidden" as const,
    textOverflow: "ellipsis" as const,
    whiteSpace: "nowrap" as const,
    minWidth: 0,
  },
  checkbox: {
    width: 16,
    height: 16,
    flexShrink: 0,
    cursor: "pointer",
    accentColor: v("--accent-primary"),
  },
  footer: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 8,
    padding: "12px 16px",
    borderTop: `1px solid ${v("--border-default")}`,
    // The OK button stays put however tall the list gets.
    flexShrink: 0,
  },
  btn: {
    padding: "6px 20px",
    fontSize: 13,
    borderRadius: 4,
    cursor: "pointer",
    minWidth: 80,
    background: v("--grid-bg"),
    color: v("--text-primary"),
    border: `1px solid ${v("--border-default")}`,
  },
  btnPrimary: {
    padding: "6px 20px",
    fontSize: 13,
    borderRadius: 4,
    cursor: "pointer",
    minWidth: 80,
    background: v("--accent-primary"),
    color: "#ffffff",
    border: `1px solid ${v("--accent-primary")}`,
  },
  summaryBackdrop: {
    position: "fixed" as const,
    inset: 0,
    zIndex: 1060,
    background: "rgba(0, 0, 0, 0.45)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  summaryDialog: {
    background: v("--panel-bg"),
    border: `1px solid ${v("--border-default")}`,
    borderRadius: 8,
    boxShadow: "0 12px 40px rgba(0, 0, 0, 0.5)",
    width: 360,
    display: "flex",
    flexDirection: "column" as const,
    color: v("--text-primary"),
    fontFamily: '"Segoe UI", system-ui, sans-serif',
    fontSize: 13,
    padding: "20px",
    gap: 16,
  },
};

// ============================================================================
// Types
// ============================================================================

interface ColumnInfo {
  absCol: number;
  label: string;
  checked: boolean;
}

interface DataRegion {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

// ============================================================================
// Component
// ============================================================================

export function RemoveDuplicatesDialog(props: DialogProps): React.ReactElement | null {
  const { onClose, data } = props;
  // The main dialog is movable/resizable — with a 20-column region the list is
  // the whole dialog, and the user had no way to make it bigger.
  const win = useDialogWindow({ minWidth: 380, minHeight: 320 });
  // Still needed for the no-region notice, which is not a resizable window.
  const dialogRef = useRef<HTMLDivElement>(null);

  const [loaded, setLoaded] = useState(false);
  const [hasHeaders, setHasHeaders] = useState(true);
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [region, setRegion] = useState<DataRegion | null>(null);
  const [headerNames, setHeaderNames] = useState<string[]>([]);
  // `error` carries the backend's reason. remove_duplicates reports refusals
  // (e.g. a protected sheet) through result.error rather than a rejected
  // promise, and throwing that text away left users with a bare
  // "An error occurred" for a completely actionable problem.
  const [summary, setSummary] = useState<
    { removed: number; remaining: number; error?: string } | null
  >(null);

  // Load data region and column headers on mount
  useEffect(() => {
    // Reopen centered at the natural size rather than wherever it was last
    // dragged to, which would be off screen after a window resize.
    win.reset();
    async function load() {
      const sel = data as Record<string, unknown> | undefined;
      const activeRow = (sel?.activeRow as number) ?? 0;
      const activeCol = (sel?.activeCol as number) ?? 0;

      // Auto-detect contiguous data region
      const detected = await detectDataRegion(activeRow, activeCol);
      if (!detected) {
        setLoaded(true);
        return;
      }

      const [sRow, sCol, eRow, eCol] = detected;
      const r: DataRegion = {
        startRow: sRow,
        startCol: sCol,
        endRow: eRow,
        endCol: eCol,
      };
      setRegion(r);

      // Fetch header row to get column names
      const headerCells = await getViewportCells(sRow, sCol, sRow, eCol);
      const names: string[] = [];
      for (let col = sCol; col <= eCol; col++) {
        const cell = headerCells.find((c) => c.row === sRow && c.col === col);
        names.push(cell?.display || "");
      }
      setHeaderNames(names);

      // Initialize columns - all checked by default
      const cols: ColumnInfo[] = [];
      for (let col = sCol; col <= eCol; col++) {
        const idx = col - sCol;
        const headerName = names[idx] || "";
        cols.push({
          absCol: col,
          label: headerName || indexToCol(col),
          checked: true,
        });
      }
      setColumns(cols);
      setLoaded(true);
    }
    load();
  }, []);

  // Update column labels when "My data has headers" changes
  useEffect(() => {
    if (!region) return;
    setColumns((prev) =>
      prev.map((col, idx) => ({
        ...col,
        label: hasHeaders && headerNames[idx]
          ? headerNames[idx]
          : `Column ${indexToCol(col.absCol)}`,
      })),
    );
  }, [hasHeaders, headerNames, region]);

  // Keyboard handlers
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (summary) {
        if (e.key === "Escape" || e.key === "Enter") {
          e.stopPropagation();
          setSummary(null);
          onClose();
        }
        return;
      }
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
      if (e.key === "Enter") {
        e.stopPropagation();
        handleOk();
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [columns, hasHeaders, region, summary]);

  // Click outside to close
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      // Two boxes share this backdrop and exactly one is ever mounted: the main
      // dialog carries the window hook's ref (so it can be dragged), the
      // no-region notice keeps its own.
      const box = win.ref.current ?? dialogRef.current;
      if (box && !box.contains(e.target as Node)) {
        onClose();
      }
    },
    [onClose, win.ref],
  );

  const handleToggleColumn = useCallback((absCol: number) => {
    setColumns((prev) =>
      prev.map((col) =>
        col.absCol === absCol ? { ...col, checked: !col.checked } : col,
      ),
    );
  }, []);

  const handleSelectAll = useCallback(() => {
    setColumns((prev) => prev.map((col) => ({ ...col, checked: true })));
  }, []);

  const handleUnselectAll = useCallback(() => {
    setColumns((prev) => prev.map((col) => ({ ...col, checked: false })));
  }, []);

  const handleOk = useCallback(async () => {
    if (!region) return;

    const keyColumns = columns.filter((c) => c.checked).map((c) => c.absCol);
    if (keyColumns.length === 0) return;

    const result = await removeDuplicates(
      region.startRow,
      region.startCol,
      region.endRow,
      region.endCol,
      keyColumns,
      hasHeaders,
    );

    if (result.success) {
      // Refresh grid - dispatch grid:refresh to refetch cell data and redraw canvas
      window.dispatchEvent(new CustomEvent("grid:refresh"));

      // Show summary
      setSummary({
        removed: result.duplicatesRemoved,
        remaining: result.uniqueRemaining,
      });
    } else {
      // Show the backend's reason, not a generic message.
      setSummary({ removed: -1, remaining: -1, error: result.error ?? undefined });
    }
  }, [region, columns, hasHeaders]);

  if (!loaded) return null;

  // No data region detected
  if (!region) {
    return (
      <div style={styles.backdrop} onMouseDown={handleBackdropClick}>
        <div ref={dialogRef} style={styles.summaryDialog}>
          <div>No data detected around the active cell.</div>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button style={styles.btnPrimary} onClick={onClose}>
              OK
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Summary dialog (shown after operation completes)
  if (summary) {
    return (
      <div style={styles.summaryBackdrop}>
        <div style={styles.summaryDialog}>
          <div>
            {summary.removed >= 0
              ? `${summary.removed} duplicate values found and removed; ${summary.remaining} unique values remain.`
              : summary.error || "An error occurred while removing duplicates."}
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button
              style={styles.btnPrimary}
              onClick={() => {
                setSummary(null);
                onClose();
              }}
            >
              OK
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Horizontal room is EARNED by the column count. Below nine columns the
  // single flex column still reads best; a wide dialog would only spread a
  // handful of short labels over an empty row.
  const wide = columns.length > 8;
  const boxWidth = dialogWidth(columns.length > 14 ? 640 : wide ? 520 : 420);

  const columnCheckboxes = columns.map((col) => (
    <label key={col.absCol} style={styles.checkboxRow} title={col.label}>
      <input
        type="checkbox"
        style={styles.checkbox}
        checked={col.checked}
        onChange={() => handleToggleColumn(col.absCol)}
      />
      <span style={styles.columnLabel}>{col.label}</span>
    </label>
  ));

  // Main dialog
  return (
    <div style={styles.backdrop} onMouseDown={handleBackdropClick}>
      <div
        ref={win.ref}
        // position:relative anchors the resize handles; win.style LAST so the
        // user's own drag wins over the centering and the max-height.
        style={{ ...styles.dialog, width: boxWidth, position: "relative", ...win.style }}
      >
        {/* Header — also the drag handle */}
        <div style={styles.header} onMouseDown={win.onHeaderMouseDown}>
          <span style={styles.title}>Remove Duplicates</span>
          <button style={styles.closeBtn} onClick={onClose}>
            X
          </button>
        </div>

        {/* Body */}
        <div style={styles.body}>
          {/* One row of list-wide controls: the headers toggle relabels the
              list below, Select All / Unselect All tick it. */}
          <div style={styles.controlRow}>
            <label style={styles.headerCheckboxRow}>
              <input
                type="checkbox"
                style={styles.checkbox}
                checked={hasHeaders}
                onChange={(e) => setHasHeaders(e.target.checked)}
              />
              My data has headers
            </label>

            <div style={styles.selectButtons}>
              <button style={styles.selectBtn} onClick={handleSelectAll}>
                Select All
              </button>
              <button style={styles.selectBtn} onClick={handleUnselectAll}>
                Unselect All
              </button>
            </div>
          </div>

          {/* Column list. Above the threshold the checkboxes flow into columns
              (auto-fit, so dragging the dialog narrow collapses them back);
              below it, the original single flex column is left alone. */}
          <div style={styles.columnList} data-testid="remove-duplicates-column-list">
            {wide ? (
              <DialogFieldGrid minColumnWidth={200} rowGap={0}>
                {columnCheckboxes}
              </DialogFieldGrid>
            ) : (
              columnCheckboxes
            )}
          </div>
        </div>

        {/* Footer */}
        <div style={styles.footer}>
          <button style={styles.btn} onClick={onClose}>
            Cancel
          </button>
          <button
            style={{
              ...styles.btnPrimary,
              opacity: columns.some((c) => c.checked) ? 1 : 0.5,
              cursor: columns.some((c) => c.checked) ? "pointer" : "not-allowed",
            }}
            onClick={handleOk}
            disabled={!columns.some((c) => c.checked)}
          >
            OK
          </button>
        </div>
        {win.resizeHandles}
      </div>
    </div>
  );
}
