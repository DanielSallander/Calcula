//! FILENAME: app/extensions/GoToSpecial/components/GoToDialog.tsx
// PURPOSE: Excel's Go To dialog (F5 / Ctrl+G, Home > Find & Select > Go To...):
//          a "Go to:" list (the locations you came from, then the workbook's
//          names and tables), a Reference box, and Special... / OK / Cancel.
// CONTEXT: Home tab 2026-10-04 (navigate.goTo). The navigation is the Name
//          Box's (lib/goTo.ts -> @api/referenceNavigation); the dialog stays open
//          with the reason when the reference cannot be gone to, as Excel's does
//          ("Reference isn't valid."). Special... closes it and opens Go To
//          Special through its own command (which refuses while an object holds
//          the selection).

import React, { useCallback, useEffect, useState } from "react";
import type { DialogProps } from "@api/uiTypes";
import { useDialogWindow } from "@api/dialogWindow";
import { restoreFocusToGrid } from "@api";
import { CommandRegistry, ExtensionCommands } from "@api/commands";
import { goToReference, listGoToTargets, recentLocations } from "../lib/goTo";

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
    width: 340,
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
  body: { padding: "12px 16px", display: "flex", flexDirection: "column" as const, gap: 6, flex: 1, minHeight: 0 },
  list: {
    flex: 1,
    minHeight: 140,
    overflowY: "auto" as const,
    border: "1px solid var(--border-default, #3c3c3c)",
    borderRadius: 3,
    background: "var(--input-bg, #2a2a2a)",
  },
  row: { padding: "2px 8px", cursor: "pointer", whiteSpace: "nowrap" as const },
  rowSelected: { background: "var(--accent-bg, #0078d4)", color: "#ffffff" },
  input: {
    padding: "4px 6px",
    background: "var(--input-bg, #2a2a2a)",
    color: "var(--text-primary, #ccc)",
    border: "1px solid var(--border-default, #3c3c3c)",
    borderRadius: 3,
    fontSize: 13,
  },
  error: { color: "var(--text-error, #f48771)", fontSize: 12 },
  footer: {
    display: "flex",
    justifyContent: "space-between",
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

export function GoToDialog({ isOpen, onClose }: DialogProps): React.ReactElement | null {
  const win = useDialogWindow({ minWidth: 300, minHeight: 300 });
  const [targets, setTargets] = useState<string[]>(() => [...recentLocations()]);
  const [selected, setSelected] = useState<number | null>(null);
  // Excel puts the location you came from in the box, so F5 then Enter is "back".
  const [reference, setReference] = useState<string>(() => recentLocations()[0] ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void listGoToTargets().then((list) => {
      if (!cancelled) setTargets(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const go = useCallback(
    async (text: string) => {
      setBusy(true);
      setError(null);
      try {
        const outcome = await goToReference(text);
        if (outcome.kind === "done") {
          onClose();
          restoreFocusToGrid();
          return;
        }
        if (outcome.kind === "problem") setError(outcome.message);
      } finally {
        setBusy(false);
      }
    },
    [onClose],
  );

  const handleSpecial = useCallback(() => {
    onClose();
    void CommandRegistry.execute(ExtensionCommands.GO_TO_SPECIAL);
  }, [onClose]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        void go(reference);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    },
    [go, reference, onClose],
  );

  if (!isOpen) return null;

  return (
    <div style={styles.backdrop} onClick={onClose}>
      <div
        ref={win.ref}
        role="dialog"
        aria-modal="true"
        aria-label="Go To"
        data-testid="go-to-dialog"
        style={{ ...styles.dialog, position: "relative", ...win.style }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div style={styles.header} onMouseDown={win.onHeaderMouseDown}>
          <span style={styles.title}>Go To</span>
          <button style={styles.closeBtn} onClick={onClose} aria-label="Close">
            x
          </button>
        </div>
        <div style={styles.body}>
          <span id="go-to-list-label">Go to:</span>
          <div style={styles.list} role="listbox" aria-labelledby="go-to-list-label" data-testid="go-to-list">
            {targets.map((target, i) => (
              <div
                key={`${i}:${target}`}
                role="option"
                aria-selected={selected === i}
                data-testid={`go-to-item-${i}`}
                style={{ ...styles.row, ...(selected === i ? styles.rowSelected : null) }}
                onClick={() => {
                  setSelected(i);
                  setReference(target);
                  setError(null);
                }}
                onDoubleClick={() => void go(target)}
              >
                {target}
              </div>
            ))}
          </div>
          <label htmlFor="go-to-reference">Reference:</label>
          <input
            id="go-to-reference"
            style={styles.input}
            value={reference}
            onChange={(e) => {
              setReference(e.target.value);
              setSelected(null);
              setError(null);
            }}
            data-testid="go-to-reference"
            autoFocus
          />
          {error && (
            <div style={styles.error} role="alert" data-testid="go-to-error">
              {error}
            </div>
          )}
        </div>
        <div style={styles.footer}>
          <button style={styles.btn} onClick={handleSpecial} data-testid="go-to-special">
            Special...
          </button>
          <div style={{ display: "flex", gap: 8 }}>
            <button style={styles.btnPrimary} onClick={() => void go(reference)} disabled={busy} data-testid="go-to-ok">
              OK
            </button>
            <button style={styles.btn} onClick={onClose} data-testid="go-to-cancel">
              Cancel
            </button>
          </div>
        </div>
        {win.resizeHandles}
      </div>
    </div>
  );
}
