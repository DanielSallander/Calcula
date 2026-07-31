//! FILENAME: app/extensions/MacroRecorder/components/RecordedMacroDialog.tsx
// PURPOSE: Review the generated source and complete the loop — copy it, drop it
//          into a notebook cell, or bind it to a new button.
// CONTEXT: The "read" and "edit" halves of record -> read -> edit. The source is
//          shown in an editable box on purpose: reading and then tweaking the
//          generated code is the step that turns a recorder into a way to LEARN
//          the scripting API, which is the whole reason this feature matters.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useDialogWindow } from "@api/dialogWindow";
import type { DialogProps } from "@api/uiTypes";
import { showToast } from "@api/notifications";
import { requestMacroToNotebook } from "@api/lib";
import { getCachedLocale } from "@api/locale";
import { generateMacroSource } from "../lib/actionCodegen";
import { getAnchorCell, getFinishedRecording } from "../lib/flow";
import { saveAsButtonScript } from "../lib/buttonScript";
import { formatA1, parseA1 } from "../lib/a1";
import type { MacroTarget, MacroWrapper } from "../lib/types";
import { styles } from "./styles";

export function RecordedMacroDialog(props: DialogProps): React.ReactElement | null {
  const { isOpen, onClose } = props;
  const win = useDialogWindow({ minWidth: 560, minHeight: 420 });

  const recording = isOpen ? getFinishedRecording() : null;

  const [target, setTarget] = useState<MacroTarget>("objectScript");
  const [wrapper, setWrapper] = useState<MacroWrapper>("bare");
  const [edited, setEdited] = useState<string | null>(null);
  const [anchor, setAnchor] = useState("A1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset every time the dialog opens on a fresh recording.
  useEffect(() => {
    if (!isOpen) return;
    win.reset();
    const rec = getFinishedRecording();
    const initialTarget = rec?.target ?? "objectScript";
    setTarget(initialTarget);
    setWrapper(initialTarget === "notebook" ? "notebookCell" : "bare");
    setEdited(null);
    setError(null);
    const cell = getAnchorCell();
    setAnchor(formatA1(cell.row, cell.col));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const generated = useMemo(() => {
    if (!recording) return { source: "", unsupported: [] as string[] };
    try {
      return generateMacroSource(recording.actions, {
        target,
        wrapper,
        name: recording.name,
        decimalSeparator: getCachedLocale()?.decimalSeparator ?? ".",
        recordedAt: new Date().toISOString(),
      });
    } catch (e) {
      return {
        source: `// ${e instanceof Error ? e.message : String(e)}\n`,
        unsupported: [] as string[],
      };
    }
  }, [recording, target, wrapper]);

  const source = edited ?? generated.source;

  const switchTarget = useCallback((next: MacroTarget) => {
    setTarget(next);
    setWrapper(next === "notebook" ? "notebookCell" : "bare");
    setEdited(null); // regenerated code replaces hand edits; say so by clearing
    setError(null);
  }, []);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(source);
      showToast("Macro source copied.", { type: "success" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [source]);

  const toNotebook = useCallback(() => {
    if (!recording) return;
    requestMacroToNotebook({ source, name: recording.name });
    showToast(`Added "${recording.name}" as a notebook cell.`, { type: "success" });
    onClose();
  }, [recording, source, onClose]);

  const toButton = useCallback(async () => {
    if (!recording) return;
    const cell = parseA1(anchor);
    if (!cell) {
      setError(`"${anchor}" is not a cell reference.`);
      return;
    }
    // The button entry point lives in the buttonScript wrapper; generate it
    // fresh rather than hoping the user's edits still define setup().
    const wrapped =
      wrapper === "buttonScript" && edited !== null
        ? source
        : generateMacroSource(recording.actions, {
            target: "objectScript",
            wrapper: "buttonScript",
            name: recording.name,
            decimalSeparator: getCachedLocale()?.decimalSeparator ?? ".",
            recordedAt: new Date().toISOString(),
          }).source;

    setBusy(true);
    setError(null);
    try {
      const result = await saveAsButtonScript({
        name: recording.name,
        source: wrapped,
        sheetIndex: getAnchorCell().sheetIndex,
        row: cell.row,
        col: cell.col,
      });
      showToast(
        result.mounted
          ? `Button created at ${anchor} — click it to replay "${recording.name}".`
          : `Button created at ${anchor}. It runs after the workbook is reloaded.`,
        { type: "success" },
      );
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [recording, anchor, wrapper, edited, source, onClose]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  if (!recording) {
    return (
      <>
        <div style={styles.backdrop} onMouseDown={onClose} />
        <div ref={win.ref} style={{ ...styles.dialog, width: 420, ...win.style }}>
          <div style={styles.header} onMouseDown={win.onHeaderMouseDown}>
            <span style={styles.title}>Recorded Macro</span>
            <button type="button" style={styles.closeBtn} onClick={onClose}>
              X
            </button>
          </div>
          <div style={styles.body}>
            <div>Nothing has been recorded yet.</div>
          </div>
          <div style={styles.footer}>
            <button type="button" style={styles.btnPrimary} onClick={onClose}>
              Close
            </button>
          </div>
          {win.resizeHandles}
        </div>
      </>
    );
  }

  return (
    <>
      <div style={styles.backdrop} onMouseDown={onClose} />
      <div
        ref={win.ref}
        style={{ ...styles.dialog, width: 720, height: 600, ...win.style }}
      >
        <div style={styles.header} onMouseDown={win.onHeaderMouseDown}>
          <span style={styles.title}>
            Recorded Macro — {recording.name} ({recording.actions.length}{" "}
            {recording.actions.length === 1 ? "action" : "actions"})
          </span>
          <button type="button" style={styles.closeBtn} onClick={onClose}>
            X
          </button>
        </div>

        <div style={styles.body}>
          <div style={styles.radioRow}>
            <label style={styles.radioLabel}>
              <input
                type="radio"
                name="macro-out-target"
                checked={target === "objectScript"}
                onChange={() => switchTarget("objectScript")}
              />
              <span>Object script</span>
            </label>
            <label style={styles.radioLabel}>
              <input
                type="radio"
                name="macro-out-target"
                checked={target === "notebook"}
                onChange={() => switchTarget("notebook")}
              />
              <span>Notebook cell</span>
            </label>

            {target === "objectScript" ? (
              <>
                <span style={{ ...styles.label, alignSelf: "center" }}>|</span>
                <label style={styles.radioLabel}>
                  <input
                    type="radio"
                    name="macro-out-wrapper"
                    checked={wrapper === "bare"}
                    onChange={() => {
                      setWrapper("bare");
                      setEdited(null);
                    }}
                  />
                  <span>Standalone function</span>
                </label>
                <label style={styles.radioLabel}>
                  <input
                    type="radio"
                    name="macro-out-wrapper"
                    checked={wrapper === "buttonScript"}
                    onChange={() => {
                      setWrapper("buttonScript");
                      setEdited(null);
                    }}
                  />
                  <span>Button click handler</span>
                </label>
              </>
            ) : null}
          </div>

          {generated.unsupported.length > 0 ? (
            <div style={styles.warning}>
              {generated.unsupported.length} recorded action
              {generated.unsupported.length === 1 ? "" : "s"} cannot run on this
              runtime and {generated.unsupported.length === 1 ? "is" : "are"}{" "}
              left in the source as comments. Switch to the object-script target
              for formatting and structural actions.
            </div>
          ) : null}

          <textarea
            style={styles.code}
            value={source}
            spellCheck={false}
            onChange={(e) => setEdited(e.target.value)}
          />

          {target === "objectScript" ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={styles.label}>Place the button at</span>
              <input
                style={{ ...styles.input, width: 90 }}
                value={anchor}
                onChange={(e) => setAnchor(e.target.value)}
              />
              <span style={styles.hint}>
                on the sheet the selection is on. The script is bound to that
                cell's control id.
              </span>
            </div>
          ) : null}

          {error ? <div style={styles.warning}>{error}</div> : null}
        </div>

        <div style={styles.footer}>
          <button type="button" style={styles.btn} onClick={onClose}>
            Close
          </button>
          <button type="button" style={styles.btn} onClick={() => void copy()}>
            Copy
          </button>
          {target === "notebook" ? (
            <button type="button" style={styles.btnPrimary} onClick={toNotebook}>
              Add as Notebook Cell
            </button>
          ) : (
            <button
              type="button"
              style={styles.btnPrimary}
              disabled={busy}
              onClick={() => void toButton()}
            >
              {busy ? "Saving…" : "Save as Button Script"}
            </button>
          )}
        </div>

        {win.resizeHandles}
      </div>
    </>
  );
}
