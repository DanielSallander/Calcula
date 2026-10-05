//! FILENAME: app/extensions/BuiltIn/InsertDeleteCells/components/CellShiftDialog.tsx
// PURPOSE: Excel's Insert and Delete dialogs: four radio choices, OK, Cancel.
// CONTEXT: One component for both, picked by `data.mode` -- the two dialogs
//          differ only in their title and their first two choices (measured on
//          live Excel: "Insert" offers Shift cells right / Shift cells down /
//          Entire row / Entire column, "Delete" offers Shift cells left / Shift
//          cells up / Entire row / Entire column). The opener passes the choice
//          to preselect and `onChoose`, so the dialog itself runs nothing and the
//          one runner in lib/cellShift.ts stays the only place a shift happens.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useDialogWindow } from "@api/dialogWindow";
import type { DialogProps } from "@api/uiTypes";
import {
  CHOICE_LABELS,
  DELETE_CHOICES,
  INSERT_CHOICES,
  type CellShiftChoice,
  type CellShiftMode,
} from "../lib/cellShift";

/** What the opener hands the dialog. */
export interface CellShiftDialogData {
  mode: CellShiftMode;
  /** The radio chosen when the dialog opens. */
  initial: CellShiftChoice;
  /** OK: the choice. Called after the dialog has closed. */
  onChoose: (choice: CellShiftChoice) => void;
}

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
    position: "relative" as const,
    background: "var(--panel-bg, #1e1e1e)",
    border: "1px solid var(--border-default, #3c3c3c)",
    borderRadius: 8,
    boxShadow: "0 12px 40px rgba(0, 0, 0, 0.5)",
    width: 240,
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
    cursor: "move",
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
  body: {
    padding: "12px 16px",
    display: "flex",
    flexDirection: "column" as const,
    gap: 6,
    border: "none",
    margin: 0,
  },
  radioRow: { display: "flex", alignItems: "center", gap: 8, padding: "3px 0", cursor: "pointer" },
  radioInput: { margin: 0, cursor: "pointer" },
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

function readData(data: Record<string, unknown> | undefined): CellShiftDialogData | null {
  const mode = data?.mode;
  const onChoose = data?.onChoose;
  if ((mode !== "insert" && mode !== "delete") || typeof onChoose !== "function") return null;
  return { mode, initial: data?.initial as CellShiftChoice, onChoose: onChoose as CellShiftDialogData["onChoose"] };
}

export function CellShiftDialog({ isOpen, onClose, data }: DialogProps): React.ReactElement | null {
  const win = useDialogWindow({ minWidth: 220, minHeight: 200, resizable: false });
  const parsed = readData(data);
  const choices: readonly CellShiftChoice[] = parsed?.mode === "delete" ? DELETE_CHOICES : INSERT_CHOICES;
  const [choice, setChoice] = useState<CellShiftChoice>(choices[0]);
  const firstRadio = useRef<HTMLInputElement | null>(null);

  // Each opening starts from the opener's preselection, centred.
  useEffect(() => {
    if (!isOpen || !parsed) return;
    setChoice(choices.includes(parsed.initial) ? parsed.initial : choices[0]);
    win.reset();
    // Focus the chosen radio so the arrow keys move the choice at once.
    queueMicrotask(() => {
      const checked = win.ref.current?.querySelector<HTMLInputElement>("input[type=radio]:checked");
      (checked ?? firstRadio.current)?.focus();
    });
    // `win` is stable per mount; re-run only when the dialog (re)opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, parsed?.mode, parsed?.initial]);

  const handleOk = useCallback(() => {
    if (!parsed) return;
    onClose();
    parsed.onChoose(choice);
  }, [parsed, choice, onClose]);

  if (!isOpen || !parsed) return null;
  const title = parsed.mode === "insert" ? "Insert" : "Delete";

  return (
    <div style={styles.backdrop} onClick={onClose}>
      <div
        ref={win.ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cell-shift-dialog-title"
        data-testid={`${parsed.mode}-cells-dialog`}
        style={{ ...styles.dialog, ...win.style }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          } else if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            handleOk();
          }
        }}
      >
        <div style={styles.header} onMouseDown={win.onHeaderMouseDown}>
          <span id="cell-shift-dialog-title" style={styles.title}>
            {title}
          </span>
          <button type="button" style={styles.closeBtn} onClick={onClose} title="Close" aria-label="Close">
            x
          </button>
        </div>
        <fieldset style={styles.body} role="radiogroup" aria-label={title}>
          {choices.map((option, index) => (
            <label key={option} style={styles.radioRow}>
              <input
                ref={index === 0 ? firstRadio : undefined}
                type="radio"
                name={`cell-shift-${parsed.mode}`}
                value={option}
                checked={choice === option}
                onChange={() => setChoice(option)}
                style={styles.radioInput}
                data-testid={`cell-shift-option-${option}`}
              />
              <span>{CHOICE_LABELS[option]}</span>
            </label>
          ))}
        </fieldset>
        <div style={styles.footer}>
          <button type="button" style={styles.btnPrimary} onClick={handleOk} data-testid="cell-shift-ok">
            OK
          </button>
          <button type="button" style={styles.btn} onClick={onClose} data-testid="cell-shift-cancel">
            Cancel
          </button>
        </div>
        {win.resizeHandles}
      </div>
    </div>
  );
}
