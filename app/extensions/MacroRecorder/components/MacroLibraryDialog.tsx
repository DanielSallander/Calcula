//! FILENAME: app/extensions/MacroRecorder/components/MacroLibraryDialog.tsx
// PURPOSE: Developer ▸ Macros… — the place a saved macro can actually be FOUND,
//          read, RUN, edited, renamed, attached to a button, and deleted.
// CONTEXT: Recording auto-saves into the workbook's module-script store. Saving
//          into a store with no UI on top of it would be the same failure the
//          recorder just had — code that exists with nothing reaching it — so
//          this window is part of the fix, not a follow-up. It lists EVERY
//          module script in the workbook, not only recorder-authored ones,
//          because the workbook only has one module store and hiding half of it
//          would just move the invisibility somewhere else.
//
// "RUN" RUNS. IT DOES NOT NEGOTIATE.
// The workbook module store's own runtime is the isolated Rust QuickJS
// interpreter, whose vocabulary is `Calcula.*`. A macro recorded for the
// OBJECT-SCRIPT target is written against the async `api`, which does not exist
// there. The previous answer to that was to DISABLE Run for such macros — and
// because these dialogs style buttons with inline CSS that overrides the UA's
// disabled appearance, the disabled Run rendered exactly like an enabled one.
// The user clicked a normal-looking primary button and nothing happened at all:
// no event, no message, no error. That is a worse bug than the one it replaced.
//
// Run now ROUTES instead of refusing (see macroLibrary.runMacroModule): a
// `Calcula.*` module goes to `run_script`, an `api.*` module is mounted as a
// transient unlocked object script — the same mount a button uses — and the
// label plus the note under the editor say which, before it is pressed. When a
// control genuinely cannot act it is greyed out AND says why, on screen.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useDialogWindow } from "@api/dialogWindow";
import type { DialogProps } from "@api/uiTypes";
import { showToast } from "@api/notifications";
import { hasButtonControlProvider } from "@api/buttonControlService";
import {
  refreshGridData,
} from "@api/grid";
import {
  deleteMacroModule,
  describeMacroRuntime,
  describeRunRoute,
  listMacroModules,
  loadMacroModule,
  macroRunRoute,
  runMacroModule,
  updateMacroModule,
  type MacroModuleEntry,
} from "../lib/macroLibrary";
import {
  describeMountFailure,
  designModeHint,
  saveAsButtonScript,
  saveAsInlineButton,
} from "../lib/buttonScript";
import { getAnchorCell, resolveAnchorSheetIndex } from "../lib/flow";
import { formatA1, parseA1 } from "../lib/a1";
import { disabledIf, styles } from "./styles";

interface LoadedModule {
  id: string;
  name: string;
  description: string | null;
  source: string;
}

export function MacroLibraryDialog(props: DialogProps): React.ReactElement | null {
  const { isOpen, onClose } = props;
  const win = useDialogWindow({ minWidth: 640, minHeight: 420 });

  const [entries, setEntries] = useState<MacroModuleEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<LoadedModule | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftSource, setDraftSource] = useState("");
  const [anchor, setAnchor] = useState("A1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [output, setOutput] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<MacroModuleEntry[]> => {
    const next = await listMacroModules();
    setEntries(next);
    return next;
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    win.reset();
    setError(null);
    setOutput(null);
    setSelectedId(null);
    setLoaded(null);
    const cell = getAnchorCell();
    setAnchor(formatA1(cell.row, cell.col));
    void refresh().catch((e) =>
      setError(e instanceof Error ? e.message : String(e)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Load the selected module's source.
  useEffect(() => {
    if (!isOpen || !selectedId) {
      setLoaded(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const script = await loadMacroModule(selectedId);
        if (cancelled) return;
        const next: LoadedModule = {
          id: script.id,
          name: script.name,
          description: script.description ?? null,
          source: script.source,
        };
        setLoaded(next);
        setDraftName(next.name);
        setDraftSource(next.source);
        setError(null);
        setOutput(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, selectedId]);

  const selectedEntry = useMemo(
    () => entries.find((e) => e.id === selectedId) ?? null,
    [entries, selectedId],
  );

  const dirty =
    loaded !== null && (draftName !== loaded.name || draftSource !== loaded.source);

  const save = useCallback(async () => {
    if (!loaded) return;
    const name = draftName.trim();
    if (!name) {
      setError("Give the macro a name.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await updateMacroModule({
        id: loaded.id,
        name,
        source: draftSource,
        description: loaded.description,
      });
      setLoaded({ ...loaded, name, source: draftSource });
      await refresh();
      showToast(`Saved "${name}".`, { type: "success" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [loaded, draftName, draftSource, refresh]);

  const run = useCallback(async () => {
    if (!loaded) return;
    setBusy(true);
    setError(null);
    setOutput(null);
    try {
      const result = await runMacroModule({
        id: loaded.id,
        name: loaded.name,
        source: draftSource,
        description: loaded.description,
      });
      if (result.type === "error") {
        setError(result.message);
        setOutput(result.output.join("\n") || null);
        showToast(`"${loaded.name}" failed: ${result.message}`, { type: "error" });
      } else {
        // The canvas does not watch the backend: without this, a macro that
        // wrote cells leaves the grid showing the OLD values until something
        // else happens to refetch. Every other run-a-script caller in the app
        // does this; this dialog was the one that did not.
        refreshGridData();
        setOutput(
          [
            ...result.output,
            result.cellsModified < 0
              ? `[OK] Finished in ${result.durationMs} ms (the object-script runtime does not count cells).`
              : `[OK] ${result.cellsModified} cell(s) changed in ${result.durationMs} ms.`,
          ].join("\n"),
        );
        showToast(`Ran "${loaded.name}".`, { type: "success" });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      showToast(`"${loaded.name}" could not run: ${message}`, { type: "error" });
    } finally {
      setBusy(false);
    }
  }, [loaded, draftSource]);

  const remove = useCallback(async () => {
    if (!loaded) return;
    if (!window.confirm(`Delete "${loaded.name}"? This cannot be undone.`)) return;
    setBusy(true);
    setError(null);
    try {
      await deleteMacroModule(loaded.id);
      setSelectedId(null);
      setLoaded(null);
      await refresh();
      showToast(`Deleted "${loaded.name}".`, { type: "success" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [loaded, refresh]);

  const addButton = useCallback(async () => {
    if (!loaded) return;
    const cell = parseA1(anchor);
    if (!cell) {
      setError(`"${anchor}" is not a cell reference.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const sheetIndex = await resolveAnchorSheetIndex();
      // Two runtimes, two binding mechanisms — see the note in buttonScript.ts.
      // Object-script macros mount as an object script on the control's
      // instanceId; QuickJS modules run inline from the control's own onSelect.
      if (selectedEntry?.runtime === "objectScript") {
        // The stored module IS the button script: its `setup(context)` wires
        // `context.onClick` when the context is a button. Nothing is appended
        // here, so there is no second source to drift from this one.
        const result = await saveAsButtonScript({
          name: loaded.name,
          source: draftSource,
          sheetIndex,
          row: cell.row,
          col: cell.col,
        });
        if (result.mounted) {
          showToast(
            `Button created at ${anchor} — click it to run "${loaded.name}".` +
              designModeHint(),
            { type: "success" },
          );
        } else {
          const message = describeMountFailure(
            anchor,
            loaded.name,
            result.mountError ?? "the script host gave no reason.",
          );
          setError(message);
          showToast(message, { type: "error", duration: 0 });
        }
      } else {
        await saveAsInlineButton({
          name: loaded.name,
          source: draftSource,
          sheetIndex,
          row: cell.row,
          col: cell.col,
        });
        showToast(
          `Button created at ${anchor} — click it to run "${loaded.name}".` +
            designModeHint(),
          { type: "success" },
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [loaded, draftSource, anchor, selectedEntry]);

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

  // The route is derived from the module the user is LOOKING at, not from the
  // list row, so an edited description takes effect the moment it is saved.
  const route = macroRunRoute(loaded?.description ?? selectedEntry?.description);
  const routeNote = describeRunRoute(loaded?.description ?? selectedEntry?.description);
  const buttonsAvailable = hasButtonControlProvider();

  const runDisabled = busy || !loaded;
  const deleteDisabled = busy || !loaded;
  const addButtonDisabled = busy || !loaded || !buttonsAvailable;
  const saveDisabled = busy || !dirty;

  return (
    <>
      <div style={styles.backdrop} onMouseDown={onClose} />
      <div
        ref={win.ref}
        data-macro-library-dialog=""
        style={{ ...styles.dialog, width: 860, height: 620, ...win.style }}
      >
        <div style={styles.header} onMouseDown={win.onHeaderMouseDown}>
          <span style={styles.title}>
            Macros &amp; Script Modules ({entries.length})
          </span>
          <button type="button" style={styles.closeBtn} onClick={onClose}>
            X
          </button>
        </div>

        <div style={{ ...styles.body, flexDirection: "row", gap: 14 }}>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
              width: 260,
              minWidth: 200,
            }}
          >
            <div style={styles.label}>Saved in this workbook</div>
            <div style={styles.list} data-macro-library-list="">
              {entries.length === 0 ? (
                <div style={{ ...styles.hint, padding: 10 }}>
                  No script modules yet. Record one with Developer ▸ Record
                  Macro… (Ctrl+Shift+R) — it is saved here automatically.
                </div>
              ) : (
                entries.map((entry) => (
                  <div
                    key={entry.id}
                    data-macro-library-item={entry.id}
                    style={
                      entry.id === selectedId ? styles.listRowSelected : styles.listRow
                    }
                    onClick={() => setSelectedId(entry.id)}
                  >
                    <span
                      style={{
                        flex: 1,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {entry.name}
                    </span>
                    <span style={styles.badge}>
                      {entry.loadError
                        ? "unreadable"
                        : entry.runtime
                          ? describeMacroRuntime(entry.runtime)
                          : "Module"}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 10,
              flex: 1,
              minWidth: 0,
            }}
          >
            {!loaded ? (
              <div style={styles.hint}>
                Select a module to read, run or edit it.
              </div>
            ) : (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={styles.label}>Name</span>
                  <input
                    style={{ ...styles.input, flex: 1 }}
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value)}
                  />
                </div>

                {selectedEntry?.loadError ? (
                  <div style={styles.error} data-macro-load-error="">
                    This module&apos;s record could not be read:{" "}
                    {selectedEntry.loadError} Its runtime is therefore unknown,
                    and Run will use the workbook script runtime.
                  </div>
                ) : null}

                {selectedEntry?.description ? (
                  <div style={styles.hint}>{selectedEntry.description}</div>
                ) : null}

                <textarea
                  style={styles.code}
                  value={draftSource}
                  spellCheck={false}
                  onChange={(e) => setDraftSource(e.target.value)}
                />

                <div style={styles.hint} data-macro-run-route={route}>
                  {routeNote}
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={styles.label}>Place a button at</span>
                  <input
                    style={{ ...styles.input, width: 90 }}
                    data-macro-anchor-input=""
                    value={anchor}
                    onChange={(e) => setAnchor(e.target.value)}
                  />
                  <span style={styles.hint}>on the active sheet.</span>
                </div>

                {!buttonsAvailable ? (
                  <div style={styles.warning} data-macro-no-buttons="">
                    Buttons are unavailable: the Controls extension is not
                    loaded, so &quot;Add Button&quot; is switched off. Enable it
                    to bind this macro to a button.
                  </div>
                ) : null}

                {output ? (
                  <div style={styles.output} data-macro-output="">
                    {output}
                  </div>
                ) : null}
                {error ? (
                  <div style={styles.error} data-macro-error="">
                    {error}
                  </div>
                ) : null}
              </>
            )}
          </div>
        </div>

        <div style={styles.footer}>
          <button type="button" style={styles.btn} onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            style={disabledIf(styles.btn, deleteDisabled)}
            disabled={deleteDisabled}
            onClick={() => void remove()}
          >
            Delete
          </button>
          <button
            type="button"
            data-macro-add-button=""
            style={disabledIf(styles.btn, addButtonDisabled)}
            disabled={addButtonDisabled}
            title={
              buttonsAvailable
                ? "Create a button on the grid that runs this macro"
                : "Buttons are unavailable: the Controls extension is not loaded."
            }
            onClick={() => void addButton()}
          >
            Add Button
          </button>
          <button
            type="button"
            style={disabledIf(styles.btn, saveDisabled)}
            disabled={saveDisabled}
            onClick={() => void save()}
          >
            {busy ? "Working…" : "Save"}
          </button>
          <button
            type="button"
            data-macro-run-button=""
            style={disabledIf(styles.btnPrimary, runDisabled)}
            disabled={runDisabled}
            title={routeNote}
            onClick={() => void run()}
          >
            {route === "objectScript" ? "Run (object script)" : "Run"}
          </button>
        </div>

        {win.resizeHandles}
      </div>
    </>
  );
}
