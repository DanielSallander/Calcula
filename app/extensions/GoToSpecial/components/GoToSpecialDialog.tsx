//! FILENAME: app/extensions/GoToSpecial/components/GoToSpecialDialog.tsx
// PURPOSE: Go To Special dialog - select cells by type (blanks, formulas, etc.)

import React, { useState, useCallback } from "react";
import { useDialogWindow } from "@api/dialogWindow";
import type { DialogProps } from "@api/uiTypes";
import { restoreFocusToGrid } from "@api";
import type { GoToSpecialCriteria } from "@api";
import { CRITERIA_OPTIONS } from "../criteriaOptions";
import { selectSpecialCells, NO_CELLS_FOUND } from "../lib/selectSpecialCells";

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
    background: "var(--panel-bg, #1e1e1e)",
    border: "1px solid var(--border-default, #3c3c3c)",
    borderRadius: 8,
    boxShadow: "0 12px 40px rgba(0, 0, 0, 0.5)",
    width: 320,
    display: "flex",
    flexDirection: "column" as const,
    color: "var(--text-primary, #cccccc)",
    fontFamily: '"Segoe UI", system-ui, sans-serif',
    fontSize: 13,
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "12px 16px 8px",
    borderBottom: "1px solid var(--border-default, #3c3c3c)",
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
    gap: 6,
  },
  radioRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "3px 0",
    cursor: "pointer",
  },
  radioInput: {
    margin: 0,
    cursor: "pointer",
  },
  radioLabel: {
    cursor: "pointer",
    userSelect: "none" as const,
  },
  footer: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 8,
    padding: "8px 16px 12px",
    borderTop: "1px solid var(--border-default, #3c3c3c)",
  },
  btn: {
    padding: "5px 16px",
    borderRadius: 4,
    border: "1px solid var(--border-default, #3c3c3c)",
    background: "var(--button-bg, #333)",
    color: "var(--text-primary, #ccc)",
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
  status: {
    padding: "4px 16px 8px",
    fontSize: 12,
    color: "var(--text-secondary, #999)",
  },
};

export function GoToSpecialDialog({ isOpen, onClose }: DialogProps): React.ReactElement | null {
  // Movable + resizable dialog window (shared @api hook)
  const win = useDialogWindow({ minWidth: 300, minHeight: 260 });

  const [selectedCriteria, setSelectedCriteria] = useState<GoToSpecialCriteria>("blanks");
  const [statusMessage, setStatusMessage] = useState<string>("");
  const [isSearching, setIsSearching] = useState(false);
  // The search and the selection are the SAME code the Find & Select quick
  // items run (goToSpecial.select, lib/selectSpecialCells.ts): exactly the
  // matching cells, never the rectangle around them. This handler used to
  // select the BOUNDING BOX as Core's main range (and the cells themselves
  // only as extra ranges, and only up to 1000 of them), so "Constants, then
  // Delete" cleared every formula inside the box.
  const handleOk = useCallback(async () => {
    setIsSearching(true);
    setStatusMessage("Searching...");

    try {
      const outcome = await selectSpecialCells(selectedCriteria, { announce: false });
      if (outcome.kind === "none") {
        setStatusMessage(NO_CELLS_FOUND);
        return;
      }
      if (outcome.kind === "refused") {
        setStatusMessage(outcome.message);
        return;
      }
      onClose();
      restoreFocusToGrid();
    } catch (error) {
      setStatusMessage(`Error: ${error}`);
    } finally {
      setIsSearching(false);
    }
  }, [selectedCriteria, onClose]);

  if (!isOpen) return null;

  return (
    <div style={styles.backdrop} onClick={onClose}>
      <div
        ref={win.ref}
        style={{ ...styles.dialog, position: "relative", ...win.style }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={styles.header} onMouseDown={win.onHeaderMouseDown}>
          <span style={styles.title}>Go To Special</span>
          <button style={styles.closeBtn} onClick={onClose} title="Close">x</button>
        </div>

        <div style={styles.body}>
          {CRITERIA_OPTIONS.map((option) => (
            <label key={option.value} style={styles.radioRow}>
              <input
                type="radio"
                name="goToSpecialCriteria"
                value={option.value}
                checked={selectedCriteria === option.value}
                onChange={() => setSelectedCriteria(option.value)}
                style={styles.radioInput}
              />
              <span style={styles.radioLabel}>{option.label}</span>
            </label>
          ))}
        </div>

        {statusMessage && (
          <div style={styles.status}>{statusMessage}</div>
        )}

        <div style={styles.footer}>
          <button style={styles.btn} onClick={onClose}>Cancel</button>
          <button
            style={styles.btnPrimary}
            onClick={handleOk}
            disabled={isSearching}
          >
            {isSearching ? "Searching..." : "OK"}
          </button>
        </div>
        {win.resizeHandles}
      </div>
    </div>
  );
}
