//! FILENAME: app/extensions/Sorting/components/SortWarningDialog.tsx
// PURPOSE: Excel's Sort Warning: one selected column sits inside wider data --
//          expand the selection (the default) or continue with it alone.
// CONTEXT: Answers lib/sortWarning.ts's promise. Every way out that is not the
//          Sort button (Cancel, the X, Escape, the backdrop) answers "cancel",
//          including an unmount by a path this component never saw (the dialog
//          container's own Escape closes it by unmounting).

import React, { useCallback, useEffect, useRef, useState } from "react";
import type { DialogProps } from "@api/uiTypes";
import { useDialogWindow } from "@api/dialogWindow";
import { answerSortWarning, type SortWarningChoice } from "../lib/sortWarning";

const styles = {
  backdrop: {
    position: "fixed" as const,
    inset: 0,
    zIndex: 1060,
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
    width: 380,
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
  title: { fontSize: 14, fontWeight: 600 },
  closeBtn: {
    background: "none",
    border: "none",
    color: "var(--text-secondary, #999)",
    fontSize: 18,
    cursor: "pointer",
    padding: "2px 6px",
    lineHeight: 1,
  },
  body: { padding: "12px 16px", display: "flex", flexDirection: "column" as const, gap: 8 },
  radioRow: { display: "flex", alignItems: "center", gap: 8, cursor: "pointer" },
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
};

export function SortWarningDialog({ isOpen, onClose }: DialogProps): React.ReactElement | null {
  const win = useDialogWindow({ minWidth: 340, minHeight: 200 });
  const [choice, setChoice] = useState<Exclude<SortWarningChoice, "cancel">>("expand");
  const answered = useRef(false);

  const finish = useCallback(
    (answer: SortWarningChoice) => {
      if (answered.current) return;
      answered.current = true;
      answerSortWarning(answer);
      onClose();
    },
    [onClose],
  );

  // Closed without an answer (the container's Escape unmounts it): cancel.
  useEffect(
    () => () => {
      if (!answered.current) {
        answered.current = true;
        answerSortWarning("cancel");
      }
    },
    [],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        finish(choice);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish("cancel");
      }
    },
    [choice, finish],
  );

  if (!isOpen) return null;

  return (
    <div style={styles.backdrop} onClick={() => finish("cancel")}>
      <div
        ref={win.ref}
        role="dialog"
        aria-modal="true"
        aria-label="Sort Warning"
        data-testid="sort-warning-dialog"
        style={{ ...styles.dialog, position: "relative", ...win.style }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div style={styles.header} onMouseDown={win.onHeaderMouseDown}>
          <span style={styles.title}>Sort Warning</span>
          <button style={styles.closeBtn} onClick={() => finish("cancel")} aria-label="Close">
            x
          </button>
        </div>
        <div style={styles.body}>
          <div>
            Calcula found data next to your selection. Since you have not selected this data, it
            will not be sorted.
          </div>
          <div>What do you want to do?</div>
          <label style={styles.radioRow}>
            <input
              type="radio"
              name="sortWarningChoice"
              checked={choice === "expand"}
              onChange={() => setChoice("expand")}
              data-testid="sort-warning-expand"
              autoFocus
            />
            <span>Expand the selection</span>
          </label>
          <label style={styles.radioRow}>
            <input
              type="radio"
              name="sortWarningChoice"
              checked={choice === "current"}
              onChange={() => setChoice("current")}
              data-testid="sort-warning-current"
            />
            <span>Continue with the current selection</span>
          </label>
        </div>
        <div style={styles.footer}>
          <button style={styles.btnPrimary} onClick={() => finish(choice)} data-testid="sort-warning-sort">
            Sort
          </button>
          <button style={styles.btn} onClick={() => finish("cancel")} data-testid="sort-warning-cancel">
            Cancel
          </button>
        </div>
        {win.resizeHandles}
      </div>
    </div>
  );
}
