//! FILENAME: app/extensions/DefinedNames/components/NameManagerDialog.tsx
// PURPOSE: Name Manager dialog listing all defined names with CRUD operations.
// CONTEXT: Opened from Formulas > Name Manager menu item.

import React, { useState, useEffect, useCallback, useRef } from "react";
import type { DialogProps } from "../../../src/api/uiTypes";
import {
  getAllNamedRanges,
  deleteNamedRange,
  getSheets,
  showDialog,
  AppEvents,
  emitAppEvent,
  onAppEvent,
} from "../../../src/api";
import type { NamedRange } from "../../../src/api";
import { formatScope, formatRangeDisplay } from "../lib/nameUtils";

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
    width: 560,
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
  filterInput: {
    padding: "6px 8px",
    fontSize: 13,
    border: `1px solid ${v("--border-default")}`,
    borderRadius: 4,
    background: v("--grid-bg"),
    color: v("--text-primary"),
    outline: "none",
    fontFamily: '"Segoe UI", system-ui, sans-serif',
    width: "100%",
    boxSizing: "border-box" as const,
  },
  tableContainer: {
    flex: 1,
    overflow: "auto",
    border: `1px solid ${v("--border-default")}`,
    borderRadius: 4,
    minHeight: 200,
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
  buttonBar: {
    display: "flex",
    gap: 8,
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

export function NameManagerDialog(
  props: DialogProps
): React.ReactElement | null {
  const { isOpen, onClose } = props;
  const dialogRef = useRef<HTMLDivElement>(null);

  const [names, setNames] = useState<NamedRange[]>([]);
  const [sheetNamesList, setSheetNamesList] = useState<string[]>([]);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const loadData = useCallback(async () => {
    try {
      const [allNames, sheetsResult] = await Promise.all([
        getAllNamedRanges(),
        getSheets(),
      ]);
      setNames(allNames);
      setSheetNamesList(sheetsResult.sheets.map((s) => s.name));
    } catch (error) {
      console.error("[NameManager] Failed to load data:", error);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    loadData();
    setSelectedName(null);
    setFilter("");
  }, [isOpen, loadData]);

  // Listen for named ranges changed events (e.g., after NewNameDialog creates one)
  useEffect(() => {
    if (!isOpen) return;
    return onAppEvent(AppEvents.NAMED_RANGES_CHANGED, () => {
      loadData();
    });
  }, [isOpen, loadData]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) {
        onClose();
      }
    },
    [onClose]
  );

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

  const handleNew = useCallback(() => {
    showDialog("define-name", { mode: "new" });
  }, []);

  const handleEdit = useCallback(() => {
    if (!selectedName) return;
    const nr = names.find((n) => n.name === selectedName);
    if (!nr) return;
    showDialog("define-name", {
      mode: "edit",
      editName: nr.name,
      editRefersTo: nr.refersTo,
      editSheetIndex: nr.sheetIndex,
      editComment: nr.comment ?? "",
    });
  }, [selectedName, names]);

  const handleDelete = useCallback(async () => {
    if (!selectedName) return;
    try {
      const result = await deleteNamedRange(selectedName);
      if (result.success) {
        setSelectedName(null);
        emitAppEvent(AppEvents.NAMED_RANGES_CHANGED);
        await loadData();
      }
    } catch (error) {
      console.error("[NameManager] Failed to delete:", error);
    }
  }, [selectedName, loadData]);

  if (!isOpen) return null;

  const filteredNames = filter
    ? names.filter(
        (nr) =>
          nr.name.toLowerCase().includes(filter.toLowerCase()) ||
          nr.refersTo.toLowerCase().includes(filter.toLowerCase())
      )
    : names;

  return (
    <div style={styles.backdrop} onMouseDown={handleBackdropClick}>
      <div ref={dialogRef} style={styles.dialog}>
        <div style={styles.header}>
          <span style={styles.title}>Name Manager</span>
          <button style={styles.closeBtn} onClick={onClose}>
            X
          </button>
        </div>

        <div style={styles.body}>
          <div style={styles.buttonBar}>
            <button style={styles.btn} onClick={handleNew}>
              New...
            </button>
            <button
              style={
                selectedName
                  ? styles.btn
                  : { ...styles.btn, ...styles.btnDisabled }
              }
              onClick={handleEdit}
              disabled={!selectedName}
            >
              Edit...
            </button>
            <button
              style={
                selectedName
                  ? styles.btnDanger
                  : { ...styles.btnDanger, ...styles.btnDisabled }
              }
              onClick={handleDelete}
              disabled={!selectedName}
            >
              Delete
            </button>
          </div>

          <input
            style={styles.filterInput}
            type="text"
            placeholder="Filter names..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
          />

          <div style={styles.tableContainer}>
            {filteredNames.length === 0 ? (
              <div style={styles.emptyMessage}>
                {names.length === 0
                  ? "No named ranges defined."
                  : "No matches found."}
              </div>
            ) : (
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>Name</th>
                    <th style={styles.th}>Refers To</th>
                    <th style={styles.th}>Scope</th>
                    <th style={styles.th}>Comment</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredNames.map((nr) => {
                    const isSelected = nr.name === selectedName;
                    return (
                      <tr
                        key={nr.name}
                        style={{
                          ...styles.row,
                          ...(isSelected ? styles.rowSelected : {}),
                        }}
                        onClick={() => setSelectedName(nr.name)}
                        onDoubleClick={handleEdit}
                      >
                        <td style={styles.td}>{nr.name}</td>
                        <td style={styles.td}>
                          {formatRangeDisplay(nr.refersTo)}
                        </td>
                        <td style={styles.td}>
                          {formatScope(nr.sheetIndex, sheetNamesList)}
                        </td>
                        <td style={styles.td}>{nr.comment ?? ""}</td>
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
