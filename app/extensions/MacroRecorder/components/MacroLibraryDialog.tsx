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
//
// EDITING A PUBLISHER'S MACRO FORKS IT.
// A `.calp` may ship module scripts, and this textarea can edit them. The Rust
// consent gate is CONTENT-KEYED — it looks for a stored module whose source is
// exactly the source being run — so editing one character used to make a
// publisher's macro unrecognisable to it and it ran with no package consent at
// all. Writing the edit back in place is no better: the stamp is sticky, so the
// stored record would keep the application's name while no longer matching its
// consent hash, leaving the user a macro that can never run again.
// So a source edit to a distributed macro does not write back: Save becomes
// "Save as my copy" and creates a genuinely LOCAL module (new id, no stamp),
// which is the escape hatch `distributed_module_refusal` already documents. A
// RENAME still writes back — it changes no byte that executes — and carries the
// stamp with it, because a rename that dropped it would launder the record just
// as thoroughly as the run did.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useDialogWindow } from "@api/dialogWindow";
import type { DialogProps } from "@api/uiTypes";
import { showToast } from "@api/notifications";
import { hasButtonControlProvider } from "@api/buttonControlService";
import {
  hasScriptEditorProvider,
  requireScriptEditorProvider,
} from "@api/scriptEditorService";
import {
  refreshGridData,
} from "@api/grid";
import {
  deleteMacroModule,
  describeMacroProvenance,
  describeMacroRuntime,
  describeForkRequirement,
  describeRunRoute,
  forkMacroModule,
  listMacroModules,
  loadMacroModule,
  macroEditDisposition,
  macroProvenanceTag,
  macroRunRoute,
  runMacroModule,
  updateMacroModule,
  type MacroEditDisposition,
  type MacroModuleEntry,
} from "../lib/macroLibrary";
import type { ScriptScope } from "@api";
import { designModeHint, linkMacroButton } from "../lib/buttonScript";
import {
  describeMacroDeletion,
  listControlsReferencingMacro,
} from "../lib/linkedButtons";
import { getAnchorCell, resolveAnchorSheetIndex } from "../lib/flow";
import { formatA1, parseA1 } from "../lib/a1";
import { disabledIf, styles } from "./styles";
import { confirmAsync } from "@api/dialogs";

interface LoadedModule {
  id: string;
  name: string;
  description: string | null;
  /** The bytes the STORE holds. The textarea holds the draft; this is the
   *  published artifact every provenance decision is made against. */
  source: string;
  /** The application this record arrived in; null for the user's own code. */
  sourcePackage: string | null;
  /**
   * The scope this record was READ with — workbook-wide, or one sheet.
   *
   * Held so every write from this dialog can send it back unchanged. Both
   * writes used to send a hard-coded `{ type: "workbook" }`, so renaming a
   * sheet-scoped macro moved it to the whole workbook without a word.
   */
  scope: ScriptScope | undefined;
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
  //
  // A FAILED LOAD LEAVES NOTHING LOADED. This used to set `error` and return,
  // keeping the PREVIOUS module in `loaded` — so the list highlighted the row
  // the user had just clicked while Run, Delete and Save all still acted on the
  // one before it. Delete is the one that cannot be taken back: the user reads
  // "could not be read", presses Delete to clear the broken entry, and destroys
  // a different, working macro. Everything this dialog does is keyed off
  // `loaded`, so clearing it refuses all five actions at once rather than each
  // of them separately.
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
          sourcePackage: script.sourcePackage ?? null,
          scope: script.scope,
        };
        setLoaded(next);
        setDraftName(next.name);
        setDraftSource(next.source);
        setError(null);
        setOutput(null);
      } catch (e) {
        if (cancelled) return;
        setLoaded(null);
        setDraftName("");
        setDraftSource("");
        setOutput(null);
        setError(
          `"${entries.find((entry) => entry.id === selectedId)?.name ?? selectedId}" ` +
            `could not be read: ${e instanceof Error ? e.message : String(e)}. ` +
            "Nothing is loaded, so Run, Delete, Save and Add Button act on nothing — " +
            "they would otherwise act on the module you were looking at before this one.",
        );
      }
    })();
    return () => {
      cancelled = true;
    };
    // `entries` is read only to NAME the failure; re-running this load because a
    // background refresh replaced the array would re-fetch the record for no
    // reason (and, mid-edit, throw the user's draft away).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, selectedId]);

  const selectedEntry = useMemo(
    () => entries.find((e) => e.id === selectedId) ?? null,
    [entries, selectedId],
  );

  const dirty =
    loaded !== null && (draftName !== loaded.name || draftSource !== loaded.source);

  /**
   * What saving this buffer must DO — write it back, or fork it.
   *
   * Provenance comes from the loaded RECORD, never from the draft: editing a
   * publisher's macro in the textarea does not make it yours, so the answer to
   * "whose code is this" cannot be a function of what the user typed.
   */
  // ONLY FROM A LOADED RECORD. While a selection is still being read, the
  // textarea still holds the PREVIOUS module's text — judging "edited" against a
  // record that has not arrived would flash the refusal at a user who has typed
  // nothing. No record, nothing to fork.
  const disposition: MacroEditDisposition = useMemo(
    () =>
      loaded
        ? macroEditDisposition({
            sourcePackage: loaded.sourcePackage,
            storedSource: loaded.source,
            draftSource,
          })
        : { kind: "inPlace" },
    [loaded, draftSource],
  );

  /**
   * Open another module — ASKING FIRST when that would throw away work.
   *
   * Selecting a row replaced the textarea's contents outright. For an ordinary
   * macro that is a lost edit; for a macro that arrived in an application it is
   * worse, because THIS TEXTAREA IS THE ONLY ROUTE WE OFFER for adapting one.
   * The Object Script Editor is read-only for a publisher's module and sends the
   * user here; the banner beside it says to edit the text and press "Save as my
   * copy". A user who does exactly that, then clicks another row to compare
   * something, loses the work on the one path the product told them to take.
   *
   * Resolves true when the caller may proceed — the double-click route opens the
   * editor only if the selection was actually allowed to change. `confirmAsync`
   * (never `window.confirm`, which returns a Promise under Tauri and is truthy
   * for both answers) fails CLOSED: a dialog that cannot be shown keeps the
   * user's edits.
   */
  const selectModule = useCallback(
    async (id: string): Promise<boolean> => {
      if (id === selectedId) return true;
      if (dirty && loaded) {
        const keeping =
          disposition.kind === "fork"
            ? `Press "Save as my copy" first — that is the only way to keep this text, because ` +
              `"${loaded.name}" belongs to the application "${disposition.packageName}" and is ` +
              "never written back."
            : "Press Save first to keep them.";
        const confirmed = await confirmAsync(
          `"${loaded.name}" has unsaved edits in this window. Opening another module ` +
            `discards them.\n\n${keeping}\n\nDiscard the edits and open the other module?`,
          { kind: "warning" },
        );
        if (!confirmed) return false;
      }
      setSelectedId(id);
      return true;
    },
    [selectedId, dirty, loaded, disposition],
  );

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
      // THE FORK. The publisher's record is not written at all: the user's text
      // becomes a NEW local module, with its own id and no package stamp, and
      // the library selects it so the next Run is unambiguously theirs.
      if (disposition.kind === "fork") {
        const copy = await forkMacroModule({
          packageName: disposition.packageName,
          name,
          source: draftSource,
          description: loaded.description,
          // The publisher record's own scope. A fork differs from its original
          // in an id and a stamp, and in nothing else the user did not type.
          scope: loaded.scope,
        });
        await refresh();
        setSelectedId(copy.id);
        setOutput(null);
        showToast(
          `Saved as "${copy.name}" — your own macro. "${loaded.name}" is unchanged.`,
          { type: "success" },
        );
        return;
      }
      await updateMacroModule({
        id: loaded.id,
        name,
        source: draftSource,
        description: loaded.description,
        // The record's OWN stamp, read from the store. A rename must not be a
        // way to turn a publisher's macro into the user's own code.
        sourcePackage: loaded.sourcePackage,
        // ...and the record's OWN scope, for the same reason. A rename must not
        // be a way to move a sheet-scoped macro to the whole workbook.
        scope: loaded.scope,
      });
      setLoaded({ ...loaded, name, source: draftSource });
      await refresh();
      showToast(`Saved "${name}".`, { type: "success" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [loaded, draftName, draftSource, disposition, refresh]);

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
        // From the loaded RECORD, which is the store's answer — never from the
        // editor draft, which the user can change without changing whose code
        // it is. `runObjectScriptOnce` re-derives this from the store anyway;
        // sending it keeps the request and the artifact in agreement.
        sourcePackage: loaded.sourcePackage,
        // ...and what the store actually holds, so a run of EDITED publisher
        // text is refused rather than slipping past the content-keyed gate.
        storedSource: loaded.source,
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
    // Warn about buttons that LINK this macro before deleting it. Deleting is
    // still allowed (the user may re-point them), but silently orphaning a
    // button is the recurring failure this feature has fought — so the confirm
    // names each linking button by sheet + A1 anchor.
    let confirmMessage = `Delete "${loaded.name}"? This cannot be undone.`;
    try {
      const linking = await listControlsReferencingMacro(loaded.id);
      const warning = describeMacroDeletion(loaded.name, linking);
      if (warning) confirmMessage = warning;
    } catch {
      // If the link scan fails, fall back to the plain confirm rather than
      // blocking a delete on a diagnostic query.
    }
    // Via confirmAsync (awaits AND fails closed). This site was patched once
    // already for the async-confirm defect; the wrapper is what keeps the fix
    // from being undone by the next edit, because the raw global is now a lint
    // error everywhere except the wrapper itself.
    const confirmed = await confirmAsync(confirmMessage, { kind: "warning" });
    if (!confirmed) return;
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
      // LINK, not copy. The button carries only this macro's id; a click runs
      // the CURRENT macro through @api/macroRunService, in whichever runtime its
      // marker names. Uniform for both runtimes — there is no second source to
      // drift from the canonical macro, and editing the macro is reflected here
      // with no re-save of the button.
      await linkMacroButton({
        macroId: loaded.id,
        name: loaded.name,
        sheetIndex,
        row: cell.row,
        col: cell.col,
      });
      showToast(
        `Button created at ${anchor} — click it to run "${loaded.name}".` +
          designModeHint(),
        { type: "success" },
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [loaded, anchor]);

  /**
   * Open a macro in the full Object Script Editor window (Track A's editor,
   * reached through the @api/scriptEditorService seam — the Facade Rule forbids
   * MacroRecorder importing ScriptableObjects internals). Used by both the
   * double-click on a row and the explicit "Edit in Object Script Editor"
   * button, so they cannot diverge.
   */
  const openInEditor = useCallback(async (macroId: string) => {
    setError(null);
    try {
      await requireScriptEditorProvider().openMacroInEditor(macroId);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      showToast(message, { type: "error" });
    }
  }, []);

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
  // Provenance comes from the stored RECORD, never from the editor draft:
  // editing a publisher's macro in the textarea does not make it yours, and the
  // tier it runs at does not change because the text did.
  const sourcePackage = loaded?.sourcePackage ?? selectedEntry?.sourcePackage ?? null;
  const description = loaded?.description ?? selectedEntry?.description;
  const routeNote = describeRunRoute(description, sourcePackage);
  const provenanceNote = describeMacroProvenance(sourcePackage, description);
  const buttonsAvailable = hasButtonControlProvider();
  const editorAvailable = hasScriptEditorProvider();

  // A FORK IS OWED, SO RUN IS REFUSED — visibly, with the way out beside it.
  // `runMacroModule` refuses this too; disabling the control is what stops the
  // user pressing a button that can only ever answer "no".
  const forkRequired = disposition.kind === "fork";
  const forkNote = forkRequired
    ? describeForkRequirement(disposition.packageName, loaded?.name ?? "this macro")
    : null;

  const runDisabled = busy || !loaded || forkRequired;
  const deleteDisabled = busy || !loaded;
  const addButtonDisabled = busy || !loaded || !buttonsAvailable;
  const editDisabled = busy || !loaded || !editorAvailable;
  const saveDisabled = busy || !dirty;
  const saveLabel = busy ? "Working…" : forkRequired ? "Save as my copy" : "Save";

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
                    onClick={() => void selectModule(entry.id)}
                    onDoubleClick={() => {
                      // The editor opens only if the selection was allowed to
                      // move. A refused discard must not send the user to the
                      // other window and leave this one on the module they kept.
                      void selectModule(entry.id).then((moved) => {
                        if (moved) void openInEditor(entry.id);
                      });
                    }}
                    title="Double-click to edit in the Object Script Editor"
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
                    {macroProvenanceTag(entry.sourcePackage) ? (
                      <span
                        style={styles.provenanceBadge}
                        data-macro-source-package={entry.sourcePackage ?? ""}
                        title={`From the application "${entry.sourcePackage}" — you did not write this macro.`}
                      >
                        {macroProvenanceTag(entry.sourcePackage)}
                      </span>
                    ) : null}
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
              <div style={styles.hint} data-macro-nothing-loaded="">
                {selectedId
                  ? "That module could not be read, so nothing is loaded here. Every action " +
                    "in this dialog acts on the loaded module, so they are all switched off."
                  : "Select a module to read, run or edit it."}
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

                {provenanceNote ? (
                  <div style={styles.warning} data-macro-provenance="">
                    {provenanceNote}
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

                {/* The edit that cannot be written back, and what to press
                    instead. On screen, not in a tooltip: Run is greyed out and
                    a control that refuses without saying why is the failure
                    this dialog has already shipped once. */}
                {forkNote ? (
                  <div style={styles.warning} data-macro-fork-required="">
                    {forkNote}
                  </div>
                ) : null}

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
              </>
            )}

            {/* OUTSIDE the "is something loaded" branch, deliberately: the one
                error the user most needs to read is the one that explains why
                NOTHING is loaded, and while it lived inside that branch a failed
                load rendered no message at all — a dialog that silently kept
                showing the previous macro. */}
            {error ? (
              <div style={styles.error} data-macro-error="">
                {error}
              </div>
            ) : null}
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
            data-macro-edit-in-editor=""
            style={disabledIf(styles.btn, editDisabled)}
            disabled={editDisabled}
            // THE TWO SURFACES AGREE ABOUT WHAT THAT WINDOW WILL DO. The Object
            // Script Editor opens a module that arrived in an application
            // READ-ONLY — it may be read, run and stepped through there, but not
            // changed, because an edit stored under the application's name stops
            // matching the code the user consented to and the macro can never
            // run again. This textarea, and "Save as my copy" beside it, is where
            // adapting one happens. Sending someone to a window that will refuse
            // their keystrokes without saying so is the same class of small lie
            // this dialog exists to stop telling.
            title={
              !editorAvailable
                ? "The Object Script Editor is unavailable: the ScriptableObjects extension is not loaded."
                : sourcePackage !== null
                  ? "Open this macro in the full Object Script Editor to read, run and step " +
                    `through it. It is READ-ONLY there: it belongs to "${sourcePackage}". ` +
                    'Edit it here and press "Save as my copy" to make a local macro you can change.'
                  : "Open this macro in the full Object Script Editor (debugger, run-at-cursor)"
            }
            onClick={() => loaded && void openInEditor(loaded.id)}
          >
            Edit in Object Script Editor
          </button>
          <button
            type="button"
            data-macro-save-button=""
            data-macro-save-mode={forkRequired ? "fork" : "inPlace"}
            style={disabledIf(styles.btn, saveDisabled)}
            disabled={saveDisabled}
            title={
              forkRequired
                ? `Make a local macro of your own from this text. "${loaded?.name ?? ""}" ` +
                  "belongs to an application and is left exactly as it arrived."
                : "Store this name and code back into the module"
            }
            onClick={() => void save()}
          >
            {saveLabel}
          </button>
          <button
            type="button"
            data-macro-run-button=""
            style={disabledIf(styles.btnPrimary, runDisabled)}
            disabled={runDisabled}
            title={forkNote ?? routeNote}
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
