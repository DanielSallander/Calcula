//! FILENAME: app/extensions/MacroRecorder/components/MacroLibraryDialog.tsx
// PURPOSE: Developer ▸ Macros… — the place a saved macro can actually be FOUND,
//          read, run, edited, renamed, attached to a button, and deleted.
// CONTEXT: Recording auto-saves into the workbook's module-script store. Saving
//          into a store with no UI on top of it would be the same failure the
//          recorder just had — code that exists with nothing reaching it — so
//          this window is part of the fix, not a follow-up. It lists EVERY
//          module script in the workbook, not only recorder-authored ones,
//          because the workbook only has one module store and hiding half of it
//          would just move the invisibility somewhere else.
//
// WHY "RUN" IS NOT ALWAYS OFFERED. The module store's runtime is the isolated
// Rust QuickJS interpreter (`run_script`), whose vocabulary is `Calcula.*`. A
// macro recorded for the OBJECT-SCRIPT target is written against the async
// object-script `api`, which does not exist there — running it would throw a
// ReferenceError every time. Such a macro gets "Add Button" instead, which mounts
// it as an object script on a real button, the runtime it was written for. An
// enabled button that always fails is worse than an honest one that is not there.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useDialogWindow } from "@api/dialogWindow";
import type { DialogProps } from "@api/uiTypes";
import { showToast } from "@api/notifications";
import { hasButtonControlProvider } from "@api/buttonControlService";
import {
  deleteMacroModule,
  describeMacroRuntime,
  listMacroModules,
  loadMacroModule,
  runMacroModule,
  updateMacroModule,
  type MacroModuleEntry,
} from "../lib/macroLibrary";
import {
  designModeHint,
  saveAsButtonScript,
  saveAsInlineButton,
} from "../lib/buttonScript";
import { getAnchorCell } from "../lib/flow";
import { formatA1, parseA1 } from "../lib/a1";
import { styles } from "./styles";

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
      });
      if (result.type === "error") {
        setError(result.message);
        setOutput(result.output.join("\n") || null);
      } else {
        setOutput(
          [
            ...result.output,
            `[OK] ${result.cellsModified} cell(s) changed in ${result.durationMs} ms.`,
          ].join("\n"),
        );
        showToast(`Ran "${loaded.name}".`, { type: "success" });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
      const sheetIndex = getAnchorCell().sheetIndex;
      // Two runtimes, two binding mechanisms — see the note in buttonScript.ts.
      // Object-script macros mount as an object script on the control's
      // instanceId; QuickJS modules run inline from the control's own onSelect.
      if (selectedEntry?.runtime === "objectScript") {
        const result = await saveAsButtonScript({
          name: loaded.name,
          // The stored module is the standalone function; the click entry point
          // is appended here so the module itself stays readable and editable.
          source: buttonEntryPoint(draftSource, loaded.name),
          sheetIndex,
          row: cell.row,
          col: cell.col,
        });
        showToast(
          (result.mounted
            ? `Button created at ${anchor} — click it to run "${loaded.name}".`
            : `Button created at ${anchor}. It runs after the workbook is reloaded.`) +
            designModeHint(),
          { type: "success" },
        );
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

  const runnable = selectedEntry?.runnable ?? true;
  const objectScript = selectedEntry?.runtime === "objectScript";

  return (
    <>
      <div style={styles.backdrop} onMouseDown={onClose} />
      <div
        ref={win.ref}
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
                      {entry.runtime ? describeMacroRuntime(entry.runtime) : "Module"}
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

                {selectedEntry?.description ? (
                  <div style={styles.hint}>{selectedEntry.description}</div>
                ) : null}

                <textarea
                  style={styles.code}
                  value={draftSource}
                  spellCheck={false}
                  onChange={(e) => setDraftSource(e.target.value)}
                />

                {objectScript ? (
                  <div style={styles.hint}>
                    This macro is written for the object-script runtime
                    (<code>api.*</code>), which only exists inside a mounted
                    object script — so it cannot be run from here. Attach it to a
                    button and click that instead.
                  </div>
                ) : null}

                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={styles.label}>Place a button at</span>
                  <input
                    style={{ ...styles.input, width: 90 }}
                    value={anchor}
                    onChange={(e) => setAnchor(e.target.value)}
                  />
                  <span style={styles.hint}>
                    on the sheet the selection is on.
                  </span>
                </div>

                {output ? <div style={styles.output}>{output}</div> : null}
                {error ? <div style={styles.error}>{error}</div> : null}
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
            style={styles.btn}
            disabled={busy || !loaded}
            onClick={() => void remove()}
          >
            Delete
          </button>
          <button
            type="button"
            style={styles.btn}
            disabled={busy || !loaded || !hasButtonControlProvider()}
            title={
              hasButtonControlProvider()
                ? "Create a button on the grid that runs this macro"
                : "Buttons are unavailable: the Controls extension is not loaded."
            }
            onClick={() => void addButton()}
          >
            Add Button
          </button>
          <button
            type="button"
            style={styles.btn}
            disabled={busy || !dirty}
            onClick={() => void save()}
          >
            {busy ? "Working…" : "Save"}
          </button>
          <button
            type="button"
            style={styles.btnPrimary}
            disabled={busy || !loaded || !runnable}
            title={
              runnable
                ? "Run this module in the workbook script runtime"
                : "Object-script macros run from a button, not from here."
            }
            onClick={() => void run()}
          >
            Run
          </button>
        </div>

        {win.resizeHandles}
      </div>
    </>
  );
}

/**
 * The identifier of the macro function a stored object-script module defines, so
 * a generated `setup(button)` can call it.
 *
 * The recorder emits exactly one top-level `async function <name>(api)`, so the
 * first such declaration is the entry point. The macro name is the fallback for
 * a module the user has since rewritten by hand — better a call the user can see
 * and fix in the object-script editor than a silent no-op.
 */
export function functionNameOf(source: string, fallbackName: string): string {
  const match = /\basync\s+function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/.exec(source);
  if (match) return match[1];
  const plain = /\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/.exec(source);
  if (plain) return plain[1];
  const sanitized = fallbackName.replace(/[^A-Za-z0-9_$]/g, "");
  return /^[A-Za-z_$]/.test(sanitized) ? sanitized : "recordedMacro";
}

/** An object-script module plus the `setup(button)` that runs it on click. */
export function buttonEntryPoint(source: string, macroName: string): string {
  const fn = functionNameOf(source, macroName);
  return [
    source.replace(/\s*$/, ""),
    "",
    "function setup(button) {",
    "  button.onClick(async () => {",
    "    if (!button.api) {",
    '      button.notify("This macro needs an unlocked script.", "error");',
    "      return;",
    "    }",
    "    try {",
    `      await ${fn}(button.api);`,
    "    } catch (e) {",
    '      button.notify(String(e && e.message ? e.message : e), "error");',
    "    }",
    "  });",
    "}",
    "",
  ].join("\n");
}
