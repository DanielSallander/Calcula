//! FILENAME: app/extensions/Tracing/components/GoToDialog.tsx
// PURPOSE: "Go To" dialog for navigating to cross-sheet trace references.
// CONTEXT: Opened when double-clicking a dashed cross-sheet trace arrow.
//          Lists all cross-sheet references; user selects one and clicks OK to navigate.

import React, { useState } from "react";
import type { DialogProps } from "../../../src/api/uiTypes";
import {
  setActiveSheet,
  scrollToCell,
  setSelection,
  columnToLetter,
  DialogExtensions,
} from "../../../src/api";

// ============================================================================
// Styles
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
    width: 340,
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
    maxHeight: 300,
    overflowY: "auto" as const,
  },
  listItem: {
    padding: "6px 10px",
    cursor: "pointer",
    borderRadius: 4,
    fontSize: 13,
    marginBottom: 2,
  },
  listItemSelected: {
    padding: "6px 10px",
    cursor: "pointer",
    borderRadius: 4,
    fontSize: 13,
    marginBottom: 2,
    background: v("--accent-primary"),
    color: "#ffffff",
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
  emptyText: {
    color: v("--text-secondary"),
    fontStyle: "italic" as const,
    textAlign: "center" as const,
    padding: "20px 0",
  },
};

// ============================================================================
// Types
// ============================================================================

interface CrossSheetRef {
  sheetName: string;
  sheetIndex: number;
  row: number;
  col: number;
}

// ============================================================================
// Component
// ============================================================================

export function GoToDialog({ data, onClose }: DialogProps) {
  const refs = (data?.crossSheetRefs as CrossSheetRef[] | undefined) ?? [];
  const [selectedIndex, setSelectedIndex] = useState<number>(refs.length > 0 ? 0 : -1);

  const handleClose = () => {
    if (onClose) onClose();
    DialogExtensions.closeDialog("tracing-goto");
  };

  const handleGoTo = async () => {
    if (selectedIndex < 0 || selectedIndex >= refs.length) return;

    const ref = refs[selectedIndex];
    try {
      await setActiveSheet(ref.sheetIndex);
      scrollToCell(ref.row, ref.col);
      setSelection({
        startRow: ref.row,
        startCol: ref.col,
        endRow: ref.row,
        endCol: ref.col,
        type: "cells",
      });
    } catch (err) {
      console.error("[Tracing] GoTo navigation error:", err);
    }

    handleClose();
  };

  const formatRef = (ref: CrossSheetRef): string => {
    const colLetter = columnToLetter(ref.col);
    return `${ref.sheetName}!${colLetter}${ref.row + 1}`;
  };

  return (
    <div style={styles.backdrop} onClick={handleClose}>
      <div style={styles.dialog} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div style={styles.header}>
          <span style={styles.title}>Go To</span>
          <button style={styles.closeBtn} onClick={handleClose}>
            X
          </button>
        </div>

        {/* Body */}
        <div style={styles.body}>
          {refs.length === 0 ? (
            <div style={styles.emptyText}>No cross-sheet references found.</div>
          ) : (
            refs.map((ref, idx) => (
              <div
                key={`${ref.sheetIndex}-${ref.row}-${ref.col}`}
                style={
                  idx === selectedIndex
                    ? styles.listItemSelected
                    : styles.listItem
                }
                onClick={() => setSelectedIndex(idx)}
                onDoubleClick={() => {
                  setSelectedIndex(idx);
                  handleGoTo();
                }}
              >
                {formatRef(ref)}
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div style={styles.footer}>
          <button style={styles.btn} onClick={handleClose}>
            Cancel
          </button>
          <button
            style={styles.btnPrimary}
            onClick={handleGoTo}
            disabled={selectedIndex < 0}
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
