//! FILENAME: app/extensions/RemoveDuplicates/components/RemoveDuplicatesDialog.tsx
// PURPOSE: Dialog for the Remove Duplicates data tool.
// CONTEXT: Allows users to select columns, toggle headers, and remove duplicate rows.

import React, { useState, useEffect, useCallback, useRef } from "react";
import type { DialogProps } from "../../../src/api/uiTypes";
import {
  detectDataRegion,
  getViewportCells,
  indexToCol,
  removeDuplicates,
} from "../../../src/api";

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
    width: 420,
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
  },
  headerCheckboxRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    cursor: "pointer",
    fontSize: 13,
    paddingBottom: 4,
    borderBottom: `1px solid ${v("--border-default")}`,
  },
  selectButtons: {
    display: "flex",
    gap: 8,
    marginBottom: 4,
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
    maxHeight: 200,
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
  },
  checkbox: {
    width: 16,
    height: 16,
    cursor: "pointer",
    accentColor: v("--accent-primary"),
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: 600,
    color: v("--text-secondary"),
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
  },
  footer: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 8,
    padding: "12px 16px",
    borderTop: `1px solid ${v("--border-default")}`,
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
  const dialogRef = useRef<HTMLDivElement>(null);

  const [loaded, setLoaded] = useState(false);
  const [hasHeaders, setHasHeaders] = useState(true);
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [region, setRegion] = useState<DataRegion | null>(null);
  const [headerNames, setHeaderNames] = useState<string[]>([]);
  const [summary, setSummary] = useState<{ removed: number; remaining: number } | null>(null);

  // Load data region and column headers on mount
  useEffect(() => {
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
      if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) {
        onClose();
      }
    },
    [onClose],
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
      // Show error in summary
      setSummary({ removed: -1, remaining: -1 });
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
              : "An error occurred while removing duplicates."}
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

  // Main dialog
  return (
    <div style={styles.backdrop} onMouseDown={handleBackdropClick}>
      <div ref={dialogRef} style={styles.dialog}>
        {/* Header */}
        <div style={styles.header}>
          <span style={styles.title}>Remove Duplicates</span>
          <button style={styles.closeBtn} onClick={onClose}>
            X
          </button>
        </div>

        {/* Body */}
        <div style={styles.body}>
          {/* My data has headers checkbox */}
          <label style={styles.headerCheckboxRow}>
            <input
              type="checkbox"
              style={styles.checkbox}
              checked={hasHeaders}
              onChange={(e) => setHasHeaders(e.target.checked)}
            />
            My data has headers
          </label>

          {/* Column selection label and buttons */}
          <div style={styles.sectionLabel}>Columns</div>
          <div style={styles.selectButtons}>
            <button style={styles.selectBtn} onClick={handleSelectAll}>
              Select All
            </button>
            <button style={styles.selectBtn} onClick={handleUnselectAll}>
              Unselect All
            </button>
          </div>

          {/* Column list */}
          <div style={styles.columnList}>
            {columns.map((col) => (
              <label
                key={col.absCol}
                style={styles.checkboxRow}
              >
                <input
                  type="checkbox"
                  style={styles.checkbox}
                  checked={col.checked}
                  onChange={() => handleToggleColumn(col.absCol)}
                />
                {col.label}
              </label>
            ))}
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
      </div>
    </div>
  );
}
