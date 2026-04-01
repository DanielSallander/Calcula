//! FILENAME: app/extensions/WatchWindow/components/WatchWindowDialog.tsx
// PURPOSE: Watch Window dialog - monitors specific cell values across sheets.
// CONTEXT: Opened from Formulas menu or right-click "Add Watch".

import React, { useState, useEffect, useCallback, useRef } from "react";
import type { DialogProps } from "../../../src/api/uiTypes";
import {
  onAppEvent,
  AppEvents,
  columnToLetter,
  emitAppEvent,
  restoreFocusToGrid,
  setActiveSheetApi,
} from "../../../src/api";
import {
  getItems,
  subscribe,
  addWatch,
  removeWatch,
  removeAllWatches,
  refreshWatches,
} from "../lib/watchStore";
import type { WatchItem } from "../lib/watchStore";

const v = (name: string) => `var(${name})`;

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

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
    width: 640,
    maxHeight: "80vh",
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
    flex: 1,
    overflow: "hidden",
  },
  buttonBar: {
    display: "flex",
    gap: 8,
  },
  tableContainer: {
    flex: 1,
    overflow: "auto",
    border: `1px solid ${v("--border-default")}`,
    borderRadius: 4,
    minHeight: 180,
    maxHeight: 400,
  },
  table: {
    width: "100%",
    borderCollapse: "collapse" as const,
    fontSize: 12,
  },
  th: {
    textAlign: "left" as const,
    padding: "6px 10px",
    borderBottom: `1px solid ${v("--border-default")}`,
    fontWeight: 600,
    fontSize: 11,
    color: v("--text-secondary"),
    position: "sticky" as const,
    top: 0,
    background: v("--panel-bg"),
    zIndex: 1,
  },
  td: {
    padding: "6px 10px",
    borderBottom: `1px solid ${v("--border-default")}`,
    whiteSpace: "nowrap" as const,
    overflow: "hidden",
    textOverflow: "ellipsis",
    maxWidth: 150,
  },
  row: {
    cursor: "pointer",
  },
  rowSelected: {
    background: v("--accent-primary"),
    color: "#ffffff",
  },
  btn: {
    padding: "6px 16px",
    fontSize: 13,
    borderRadius: 4,
    cursor: "pointer",
    minWidth: 70,
    background: v("--grid-bg"),
    color: v("--text-primary"),
    border: `1px solid ${v("--border-default")}`,
  },
  btnDanger: {
    padding: "6px 16px",
    fontSize: 13,
    borderRadius: 4,
    cursor: "pointer",
    minWidth: 70,
    background: "#e74c3c",
    color: "#ffffff",
    border: "1px solid #c0392b",
  },
  btnDisabled: {
    opacity: 0.45,
    cursor: "not-allowed" as const,
  },
  footer: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 8,
    padding: "12px 16px",
    borderTop: `1px solid ${v("--border-default")}`,
  },
  emptyMessage: {
    padding: "24px 16px",
    textAlign: "center" as const,
    color: v("--text-secondary"),
    fontStyle: "italic" as const,
  },
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function WatchWindowDialog(props: DialogProps): React.ReactElement | null {
  const { isOpen, onClose, data } = props;
  const dialogRef = useRef<HTMLDivElement>(null);

  const [watches, setWatches] = useState<readonly WatchItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Sync with store
  useEffect(() => {
    setWatches(getItems());
    return subscribe(() => {
      setWatches(getItems());
    });
  }, []);

  // Refresh values when dialog opens
  useEffect(() => {
    if (!isOpen) return;
    refreshWatches();
    setSelectedId(null);
  }, [isOpen]);

  // If opened with data to add a watch, add it
  useEffect(() => {
    if (!isOpen || !data) return;
    const { sheetIndex, sheetName, row, col, name } = data as {
      sheetIndex?: number;
      sheetName?: string;
      row?: number;
      col?: number;
      name?: string;
    };
    if (sheetIndex != null && row != null && col != null && sheetName) {
      const item = addWatch(sheetIndex, sheetName, row, col, name);
      setSelectedId(item.id);
      refreshWatches();
    }
  }, [isOpen, data]);

  // Listen for data changes to refresh values
  useEffect(() => {
    if (!isOpen) return;
    const unsub1 = onAppEvent(AppEvents.DATA_CHANGED, () => refreshWatches());
    const unsub2 = onAppEvent(AppEvents.CELLS_UPDATED, () => refreshWatches());
    const unsub3 = onAppEvent(AppEvents.SHEET_CHANGED, () => refreshWatches());
    return () => {
      unsub1();
      unsub2();
      unsub3();
    };
  }, [isOpen]);

  // Escape to close
  useEffect(() => {
    if (!isOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [isOpen, onClose]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) {
        onClose();
      }
    },
    [onClose],
  );

  const handleDelete = useCallback(() => {
    if (!selectedId) return;
    removeWatch(selectedId);
    setSelectedId(null);
  }, [selectedId]);

  const handleDeleteAll = useCallback(() => {
    removeAllWatches();
    setSelectedId(null);
  }, []);

  const handleNavigate = useCallback(
    async (item: WatchItem) => {
      // Switch sheet if needed, then navigate to cell
      try {
        await setActiveSheetApi(item.sheetIndex);
        emitAppEvent(AppEvents.SHEET_CHANGED, { sheetIndex: item.sheetIndex });
        // Small delay to let sheet switch complete
        requestAnimationFrame(() => {
          emitAppEvent(AppEvents.NAVIGATE_TO_CELL, {
            row: item.row,
            col: item.col,
          });
        });
      } catch {
        // If sheet switch fails, just navigate on current sheet
        emitAppEvent(AppEvents.NAVIGATE_TO_CELL, {
          row: item.row,
          col: item.col,
        });
      }
      onClose();
      restoreFocusToGrid();
    },
    [onClose],
  );

  if (!isOpen) return null;

  return (
    <div style={styles.backdrop} onMouseDown={handleBackdropClick}>
      <div ref={dialogRef} style={styles.dialog}>
        <div style={styles.header}>
          <span style={styles.title}>Watch Window</span>
          <button style={styles.closeBtn} onClick={onClose}>
            X
          </button>
        </div>

        <div style={styles.body}>
          <div style={styles.buttonBar}>
            <button
              style={
                selectedId
                  ? styles.btnDanger
                  : { ...styles.btnDanger, ...styles.btnDisabled }
              }
              onClick={handleDelete}
              disabled={!selectedId}
            >
              Delete Watch
            </button>
            <button
              style={
                watches.length > 0
                  ? styles.btn
                  : { ...styles.btn, ...styles.btnDisabled }
              }
              onClick={handleDeleteAll}
              disabled={watches.length === 0}
            >
              Delete All
            </button>
          </div>

          <div style={styles.tableContainer}>
            {watches.length === 0 ? (
              <div style={styles.emptyMessage}>
                No watches defined. Right-click a cell and select "Add Watch" to
                start monitoring cell values.
              </div>
            ) : (
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>Sheet</th>
                    <th style={styles.th}>Name</th>
                    <th style={styles.th}>Cell</th>
                    <th style={styles.th}>Value</th>
                    <th style={styles.th}>Formula</th>
                  </tr>
                </thead>
                <tbody>
                  {watches.map((item) => {
                    const isSelected = item.id === selectedId;
                    const cellRef = `${columnToLetter(item.col)}${item.row + 1}`;
                    return (
                      <tr
                        key={item.id}
                        style={{
                          ...styles.row,
                          ...(isSelected ? styles.rowSelected : {}),
                        }}
                        onClick={() => setSelectedId(item.id)}
                        onDoubleClick={() => handleNavigate(item)}
                      >
                        <td style={styles.td}>{item.sheetName}</td>
                        <td style={styles.td}>{item.name ?? ""}</td>
                        <td style={styles.td}>{cellRef}</td>
                        <td style={styles.td}>{item.value}</td>
                        <td style={styles.td}>{item.formula ?? ""}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div style={styles.footer}>
          <button style={styles.btn} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
