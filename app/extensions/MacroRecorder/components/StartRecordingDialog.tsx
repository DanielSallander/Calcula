//! FILENAME: app/extensions/MacroRecorder/components/StartRecordingDialog.tsx
// PURPOSE: Name the macro and choose the runtime, then start capturing.
// CONTEXT: The runtime is asked for UP FRONT rather than inferred later,
//          because the two script surfaces have genuinely different reach and
//          the choice changes what a recording is worth: object scripts can
//          replay formatting/structure/sheets, notebook cells cannot. Saying so
//          before the user records twenty actions is the honest order.

import React, { useEffect, useState } from "react";
import { useDialogWindow } from "@api/dialogWindow";
import type { DialogProps } from "@api/uiTypes";
import { startRecording } from "../lib/actionRecorder";
import { setPendingTarget } from "../lib/flow";
import type { MacroTarget } from "../lib/types";
import { styles } from "./styles";

const TARGETS: Array<{ id: MacroTarget; label: string; hint: string }> = [
  {
    id: "objectScript",
    label: "Object script (recommended)",
    hint:
      "Async `context.api`. Replays values, formatting, rows/columns, merge, freeze, sheets, sort, find & replace — and can be saved straight onto a button.",
  },
  {
    id: "notebook",
    label: "Notebook cell",
    hint:
      "Synchronous `Calcula.*` ops in the QuickJS runtime. Replays values, sheet switches and fills; it has no formatting or structural API.",
  },
];

export function StartRecordingDialog(props: DialogProps): React.ReactElement | null {
  const { isOpen, onClose } = props;
  const win = useDialogWindow({ minWidth: 420, minHeight: 300 });

  const [name, setName] = useState("Macro1");
  const [target, setTarget] = useState<MacroTarget>("objectScript");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      win.reset();
      setName(`Macro${new Date().getHours()}${String(new Date().getMinutes()).padStart(2, "0")}`);
      setError(null);
    }
    // `win` is stable for the dialog's lifetime; re-running on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const start = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Give the macro a name.");
      return;
    }
    try {
      setPendingTarget(target);
      await startRecording(trimmed);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      } else if (e.key === "Enter") {
        e.stopPropagation();
        void start();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  });

  if (!isOpen) return null;

  return (
    <>
      <div style={styles.backdrop} onMouseDown={onClose} />
      <div
        ref={win.ref}
        data-macro-start-dialog=""
        style={{ ...styles.dialog, width: 480, ...win.style }}
      >
        <div style={styles.header} onMouseDown={win.onHeaderMouseDown}>
          <span style={styles.title}>Record Macro</span>
          <button type="button" style={styles.closeBtn} onClick={onClose}>
            X
          </button>
        </div>

        <div style={styles.body}>
          <div>
            <div style={styles.label}>Macro name</div>
            <input
              style={styles.input}
              data-macro-name-input=""
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div>
            <div style={styles.label}>Generate code for</div>
            <div style={{ ...styles.radioRow, flexDirection: "column", gap: 10 }}>
              {TARGETS.map((t) => (
                <label key={t.id} style={styles.radioLabel}>
                  <input
                    type="radio"
                    name="macro-target"
                    data-macro-target={t.id}
                    checked={target === t.id}
                    onChange={() => setTarget(t.id)}
                  />
                  <span>
                    <div>{t.label}</div>
                    <div style={styles.hint}>{t.hint}</div>
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div style={styles.hint}>
            While recording, a red indicator sits in the status bar with Pause,
            Stop and Discard. Undo (Ctrl+Z) removes the last recorded action
            instead of being recorded itself.
          </div>

          {error ? <div style={styles.warning}>{error}</div> : null}
        </div>

        <div style={styles.footer}>
          <button type="button" style={styles.btn} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            data-macro-start-button=""
            style={styles.btnPrimary}
            onClick={() => void start()}
          >
            Start Recording
          </button>
        </div>

        {win.resizeHandles}
      </div>
    </>
  );
}
