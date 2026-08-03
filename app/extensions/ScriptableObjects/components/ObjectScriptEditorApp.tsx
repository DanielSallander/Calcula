//! FILENAME: app/extensions/ScriptableObjects/components/ObjectScriptEditorApp.tsx
// PURPOSE: Root component for the standalone Object Script Editor window.
// CONTEXT: Mounted in a separate Tauri window. Communicates with the main window
//          via Tauri events for script mounting/unmounting. Calls backend directly
//          for CRUD operations.

import React, { useState, useCallback, useRef, useEffect } from "react";
import Editor, { type OnMount, loader } from "@monaco-editor/react";
import type { editor as monacoEditor } from "monaco-editor";
import * as monaco from "monaco-editor";
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Monaco 0.52+ moved typescript to top-level; languages.typescript still works at runtime
const monacoTs = (monaco.languages as any).typescript;
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import objectContextsDts from "../objectContexts.d.ts?raw";

import {
  getScaffoldTemplate,
  getContextDocumentation,
} from "@api";
import {
  loadAllObjectScripts,
  saveObjectScript,
} from "@api/objectScriptBackend";
import {
  getWorkbookScript,
  listWorkbookScriptRecords,
  onWorkbookScriptsChanged,
  parseModuleScriptRuntime,
  saveWorkbookScript,
} from "@api/workbookScripts";
import type { ModuleScriptRuntime, WorkbookScriptRecord } from "@api/workbookScripts";
import {
  listTemplates,
  saveTemplate,
  createTemplateFromScript,
  stampFromTemplate,
  loadTemplate,
  deleteTemplate,
} from "../lib/templateManager";
import type { TemplateSummary } from "../lib/templateManager";
import { hostValidateScript } from "@api";
import { prefetchScriptTranspiler } from "@api/scriptTranspile";
import {
  clearBreakpoints,
  shiftBreakpoints,
  subscribeRemoteDebugState,
  setRemoteDebugTransport,
  runAtCursor,
} from "../lib/debugger";
import {
  breakpointShift,
  DebugPanel,
  DebugToolbar,
  injectDebugStyles,
  useDebugSession,
  type DebugDecoration,
} from "./DebugPanel";
import {
  configureObjectScriptTypings,
  setActiveContextType,
  annotateScaffold,
} from "../lib/monacoTypings";
import {
  objectScriptModelPath,
  registerJavascriptLane,
  registerTypescriptLane,
  gateObjectScriptSave,
  type ScriptAuthoringLanguage,
} from "../lib/authoringLanguage";
import type { ObjectScriptDefinition, ScriptableObjectType, ScriptAccessLevel } from "@api/scriptableObjects";
import {
  emitSaveAndApply,
  emitRegisterScript,
  emitToggleAccess,
  emitEditorClosed,
  emitEditorReady,
  onOpenWithScript,
  onOpenWithDraft,
  onOpenWithModuleMacro,
  onConsoleOutput,
  onScriptError,
  onScriptsChanged,
} from "../lib/crossWindowEvents";
import type { ScriptDraft } from "../lib/crossWindowEvents";
import { draftToScriptDefinition } from "../lib/scriptDrafts";

// ============================================================================
// Monaco Worker Setup
// ============================================================================

self.MonacoEnvironment = {
  getWorker(_: string, label: string) {
    if (label === "typescript" || label === "javascript") {
      return new tsWorker();
    }
    return new editorWorker();
  },
};

loader.config({ monaco });

// Inject CSS
(function injectStyles() {
  const id = "objscript-editor-styles";
  if (document.getElementById(id)) return;
  const style = document.createElement("style");
  style.id = id;
  style.textContent = `
    .breakpoint-glyph {
      background: #E51400;
      border-radius: 50%;
      width: 10px !important;
      height: 10px !important;
      margin-left: 4px;
      margin-top: 5px;
    }
    .breakpoint-line-decoration {
      background: rgba(229, 20, 0, 0.1);
    }

    .ose-btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 4px 10px;
      font-size: 11px;
      font-family: 'Segoe UI', Tahoma, sans-serif;
      border: 1px solid transparent;
      border-radius: 3px;
      background: transparent;
      color: #ccc;
      cursor: pointer;
      white-space: nowrap;
      transition: background 0.15s, border-color 0.15s, color 0.15s;
    }
    .ose-btn:hover { background: rgba(255,255,255,0.08); color: #fff; }
    .ose-btn:active { background: rgba(255,255,255,0.12); }
    .ose-btn[disabled] { opacity: 0.4; cursor: default; pointer-events: none; }
    .ose-btn.primary { background: #0078D4; color: #fff; border-color: #0078D4; }
    .ose-btn.primary:hover { background: #106EBE; border-color: #106EBE; }
    .ose-btn.primary[disabled] { background: #0078D4; opacity: 0.4; }

    .ose-select {
      padding: 4px 8px;
      font-size: 11px;
      font-family: 'Segoe UI', Tahoma, sans-serif;
      border: 1px solid #444;
      border-radius: 3px;
      background: #2D2D2D;
      color: #ccc;
      cursor: pointer;
      outline: none;
      max-width: 220px;
      transition: border-color 0.15s;
    }
    .ose-select:hover { border-color: #0078D4; }
    .ose-select:focus { border-color: #0078D4; box-shadow: 0 0 0 1px rgba(0,120,212,0.3); }

    .ose-sidebar-method {
      font-family: 'Cascadia Code', Consolas, monospace;
      font-size: 11px;
      color: #4FC1FF;
      margin-bottom: 1px;
      cursor: pointer;
      padding: 2px 4px;
      border-radius: 2px;
      transition: background 0.1s;
    }
    .ose-sidebar-method:hover { background: rgba(79,193,255,0.1); }

    .ose-splitter {
      height: 4px;
      cursor: ns-resize;
      background: #252526;
      border-top: 1px solid #333;
      flex-shrink: 0;
      transition: background 0.15s;
    }
    .ose-splitter:hover { background: #0078D4; }

    .ose-console-line {
      margin-bottom: 1px;
      white-space: pre-wrap;
      word-break: break-all;
    }
  `;
  document.head.appendChild(style);
})();

// Register the GENERATED type definitions on both language services. The
// per-script `ObjectScriptContext` alias is published separately, whenever the
// edited script changes (see the effect in the component below) — without it
// the interfaces below are unreachable, because a script's context is a
// parameter of `setup(context)` and nothing binds it.
configureObjectScriptTypings(monacoTs, objectContextsDts);
// ...and claim the object-script share of the shared language services, so the
// merged configuration (not whichever extension was imported last) is what is
// live. Without this, another surface's fragment settings switched validation
// off here too and the generated typings produced completions but never a
// single diagnostic.
registerJavascriptLane(monacoTs, objectContextsDts);

// ============================================================================
// Console entry type
// ============================================================================

interface ConsoleEntry {
  id: number;
  level: "log" | "warn" | "error" | "info";
  message: string;
  scriptId?: string;
  timestamp: number;
}

// ============================================================================
// SVG Icons
// ============================================================================

function IconSave() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
      <path d="M13.353 1.146l1.5 1.5A.5.5 0 0115 3v11.5a.5.5 0 01-.5.5h-13a.5.5 0 01-.5-.5v-13A.5.5 0 011.5 1H12a.5.5 0 01.353.146zM2 2v12h12V3.207L12.793 2H11v4H4V2H2zm3 0v3h5V2H5z" />
    </svg>
  );
}

function IconTemplate() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
      <path d="M14 1H2a1 1 0 00-1 1v12a1 1 0 001 1h12a1 1 0 001-1V2a1 1 0 00-1-1zM2 2h12v3H2V2zm0 4h5v8H2V6zm6 8V6h6v8H8z" />
    </svg>
  );
}

function IconLock() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
      <path d="M11 5V4a3 3 0 00-6 0v1H4v7h8V5h-1zM6 4a2 2 0 014 0v1H6V4z" />
    </svg>
  );
}

function IconUnlock() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
      <path d="M11 5h1v7H4V5h5V4a2 2 0 00-4 0v1H4V4a3 3 0 016 0v1z" />
    </svg>
  );
}

function IconTerminal() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
      <path d="M1 3v10h14V3H1zm13 9H2V4h12v8zM5.146 5.146l.708.708L3.707 8l2.147 2.146-.708.708L2.293 8l2.853-2.854zM8 10h4v1H8v-1z" />
    </svg>
  );
}

function IconBook() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
      <path d="M14.5 2H9c-.69 0-1.25.56-1.25 1.25v9.5A1.25 1.25 0 019 14h5.5a.5.5 0 00.5-.5V2.5a.5.5 0 00-.5-.5zM14 13H9a.25.25 0 01-.25-.25v-9.5A.25.25 0 019 3h5v10zM7.25 3.25C7.25 2.56 6.69 2 6 2H1.5a.5.5 0 00-.5.5v11a.5.5 0 00.5.5H6c.69 0 1.25-.56 1.25-1.25v-9.5zM6 13H2V3h4a.25.25 0 01.25.25v9.5A.25.25 0 016 13z" />
    </svg>
  );
}

// ============================================================================
// Module scripts (recorded macros) as first-class documents
// ============================================================================

/**
 * One MODULE script open in — or merely listed by — this editor.
 *
 * A recorded macro is a module script (`save_script`), not an object script, so
 * `loadAllObjectScripts` cannot see it. The editor used to hold exactly ONE of
 * these, handed to it over the open-with-macro channel, which meant a user with
 * two macros could only ever see the one they navigated to: the second REPLACED
 * the first. Macros are enumerated from the store now, like any other inventory,
 * and this is the per-document state that enumeration produces.
 */
interface MacroDoc {
  macroId: string;
  /** Synthetic object-script shape for the editor chrome. `source` is the LIVE
   *  buffer for this document (stashed on switch-away), not the stored text. */
  script: ObjectScriptDefinition;
  /** The stored description — where the runtime marker lives. Preserved verbatim
   *  across a save so the macro keeps routing correctly. */
  description: string | null;
  /** The source as STORED, so a refresh can tell an external edit from a local one. */
  savedSource: string;
  /** Unsaved edits in this document's buffer. Per-document, so switching between
   *  two macros cannot lose either one's work. */
  dirty: boolean;
  /** Why this module could not be read, or that it has since been deleted. */
  loadError: string | null;
  /** Recorder marker: a marked module is a MACRO, an unmarked one a plain module. */
  runtime: ModuleScriptRuntime | null;
}

function macroDocFromRecord(record: WorkbookScriptRecord): MacroDoc {
  return {
    macroId: record.id,
    script: {
      id: record.id,
      name: record.name,
      objectType: "workbook",
      instanceId: null,
      source: record.source,
      accessLevel: "unlocked",
    },
    description: record.description,
    savedSource: record.source,
    dirty: false,
    loadError: record.loadError,
    runtime: parseModuleScriptRuntime(record.description),
  };
}

/** The dropdown prefix. A recorder-marked module is a MACRO; an unmarked one is
 *  a hand-authored module — both live in the same store and both belong here. */
function macroDocKindLabel(doc: MacroDoc): string {
  return doc.runtime ? "MACRO" : "MODULE";
}

/** What a deleted-but-edited document says about itself. */
const DELETED_WITH_EDITS_NOTE =
  "This module was deleted from the workbook while you had unsaved edits. " +
  "The edits are still here — Save writes it back.";

/**
 * Fold a fresh listing into the documents already open, PRESERVING per-document
 * unsaved edits.
 *
 * The rules, in order:
 *   - a listed module with local unsaved edits keeps its buffer (the record
 *     supplies everything else);
 *   - a listed module with no local edits takes the record wholesale;
 *   - a module that has DISAPPEARED and has unsaved edits stays in the list,
 *     flagged, rather than silently taking the author's work with it;
 *   - a module that has disappeared and is clean simply goes.
 */
export function mergeMacroDocs(
  previous: MacroDoc[],
  records: WorkbookScriptRecord[],
): MacroDoc[] {
  const stale = new Map(previous.map((doc) => [doc.macroId, doc]));
  const next: MacroDoc[] = records.map((record) => {
    const existing = stale.get(record.id);
    stale.delete(record.id);
    const fresh = macroDocFromRecord(record);
    if (!existing || !existing.dirty) return fresh;
    return {
      ...fresh,
      script: { ...fresh.script, source: existing.script.source },
      dirty: true,
    };
  });
  for (const orphan of stale.values()) {
    if (!orphan.dirty) continue;
    next.push({ ...orphan, loadError: DELETED_WITH_EDITS_NOTE });
  }
  // Macros together, in a stable, human order — the list is a menu, not a log.
  return next.sort((a, b) => a.script.name.localeCompare(b.script.name));
}

// ============================================================================
// Component
// ============================================================================

export function ObjectScriptEditorApp(): React.ReactElement {
  const editorRef = useRef<monacoEditor.IStandaloneCodeEditor | null>(null);

  // Script list and current script
  const [scripts, setScripts] = useState<ObjectScriptDefinition[]>([]);
  const [activeScriptId, setActiveScriptId] = useState<string | null>(null);
  const [source, setSource] = useState("");
  // The AI-authored draft under review, if any. It is NOT in `scripts`: it has
  // no backend record, is not registered and is not mounted. Saving it is what
  // turns it into one of `scripts`, through the same gate as typed code.
  const [draftDoc, setDraftDoc] = useState<
    { draft: ScriptDraft; script: ObjectScriptDefinition } | null
  >(null);
  // EVERY recorded macro / module script in the workbook. Unlike a draft these
  // are real, saved records — but in the MODULE store (`save_script`), not the
  // object-script store — so they need their own doc-kind: Save routes to
  // `saveWorkbookScript`, and debug/run mount them transiently under a synthetic
  // unlocked `workbook` definition the HOST builds from the store.
  const [macroDocs, setMacroDocs] = useState<MacroDoc[]>([]);
  const macroDocsRef = useRef<MacroDoc[]>([]);
  macroDocsRef.current = macroDocs;
  // Authoring language for the OPEN script. Stored scripts are always
  // JavaScript (that is the only thing the worker can import), so this always
  // starts at "javascript"; switching to TypeScript is an authoring decision
  // that lasts until the next save compiles the text back down.
  const [language, setLanguage] = useState<ScriptAuthoringLanguage>("javascript");
  const [isDirty, setIsDirty] = useState(false);
  // Live mirrors of the buffer, so the async listeners (a macro arriving on the
  // open channel, a background list refresh) can stash the author's current text
  // into its document instead of reading a stale closure and overwriting it.
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const isDirtyRef = useRef(isDirty);
  isDirtyRef.current = isDirty;
  const activeDocIdRef = useRef<string | null>(activeScriptId);
  activeDocIdRef.current = activeScriptId;
  /** Which document the buffer currently holds. Guards the restore effect so a
   *  background refresh of the macro list can never replace text being typed. */
  const loadedDocIdRef = useRef<string | null>(null);
  const [showSidebar, setShowSidebar] = useState(true);
  const [showConsole, setShowConsole] = useState(true);
  const [consoleEntries, setConsoleEntries] = useState<ConsoleEntry[]>([]);
  const consoleEndRef = useRef<HTMLDivElement>(null);
  const consoleIdRef = useRef(0);

  // Console resize
  const [consoleHeight, setConsoleHeight] = useState(160);
  const consoleDragRef = useRef<{ startY: number; startH: number } | null>(null);

  const onConsoleSplitterMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    consoleDragRef.current = { startY: e.clientY, startH: consoleHeight };
    const onMove = (ev: MouseEvent) => {
      if (!consoleDragRef.current) return;
      const dy = consoleDragRef.current.startY - ev.clientY;
      setConsoleHeight(Math.max(60, Math.min(400, consoleDragRef.current.startH + dy)));
    };
    const onUp = () => {
      consoleDragRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [consoleHeight]);

  // Push one line into the editor console and reveal it. Declared before the
  // loaders because they are the first thing that can need to speak.
  const reportToConsole = useCallback(
    (message: string, scriptId?: string, level: ConsoleEntry["level"] = "error") => {
      setConsoleEntries((prev) => [
        ...prev,
        {
          id: ++consoleIdRef.current,
          level,
          message,
          scriptId,
          timestamp: Date.now(),
        },
      ]);
      setShowConsole(true);
    },
    [],
  );

  // Load scripts from backend
  const loadScripts = useCallback(async () => {
    try {
      const allScripts = await loadAllObjectScripts();
      setScripts(allScripts);
      return allScripts;
    } catch (e) {
      console.error("[ObjectScriptEditorApp] Failed to load scripts:", e);
      return [];
    }
  }, []);

  /**
   * Enumerate the workbook's MODULE scripts — every recorded macro, not just the
   * one this window was navigated to.
   *
   * This is the whole of bug A: the editor used to know about exactly the macro
   * handed to it on the open channel, so a second macro replaced the first.
   * `listWorkbookScriptRecords` is the same door the Macros library lists
   * through, reached through @api rather than by importing the Macro Recorder.
   */
  const loadMacros = useCallback(async () => {
    let records: WorkbookScriptRecord[];
    try {
      records = await listWorkbookScriptRecords();
    } catch (e) {
      // Never a silently empty dropdown: if the store cannot be read, say so.
      reportToConsole(
        `Could not list this workbook's script modules, so recorded macros are missing ` +
          `from the list: ${e instanceof Error ? e.message : String(e)}`,
      );
      return;
    }

    // An external edit to the module the author is LOOKING at, with no local
    // edits of their own, is shown rather than hidden — but it is announced,
    // because text changing under the cursor with no explanation is worse than
    // either outcome.
    const activeId = activeDocIdRef.current;
    if (activeId && !isDirtyRef.current) {
      const record = records.find((r) => r.id === activeId);
      if (record && !record.loadError && record.source !== sourceRef.current) {
        setSource(record.source);
        reportToConsole(
          `"${record.name}" changed in the workbook and has been reloaded here.`,
          record.id,
          "info",
        );
      }
    }

    setMacroDocs((prev) => {
      // Stash the live buffer into the ACTIVE document first. Its edits live in
      // `source`/`isDirty` until a switch moves them, and the merge decides what
      // to keep by looking at `dirty` — without this, a refresh that arrives
      // while the author is typing would judge the document clean and throw the
      // work away (deleted elsewhere) or overwrite it (edited elsewhere).
      const activeId = activeDocIdRef.current;
      const withLiveBuffer = activeId
        ? prev.map((d) =>
            d.macroId === activeId
              ? {
                  ...d,
                  script: { ...d.script, source: sourceRef.current },
                  dirty: isDirtyRef.current,
                }
              : d,
          )
        : prev;
      return mergeMacroDocs(withLiveBuffer, records);
    });
    for (const record of records) {
      if (record.loadError) {
        reportToConsole(
          `"${record.name}" (${record.id}) is listed but could not be read: ${record.loadError}`,
          record.id,
        );
      }
    }
  }, [reportToConsole]);

  // Initial load
  useEffect(() => {
    loadScripts();
    void loadMacros();
  }, [loadScripts, loadMacros]);

  // The list must follow the workbook: a macro recorded, renamed or deleted in
  // the main window while this editor is open changes what belongs here. The
  // module store announces every write it makes (@api/workbookScripts), so this
  // is a subscription, not a poll.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    void onWorkbookScriptsChanged(() => {
      void loadMacros();
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {
        /* no event bus in this environment; the list still loads on open */
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [loadMacros]);

  /**
   * Move the live buffer into the module document it belongs to.
   *
   * The single-macro editor already had the rule that "switching away must not
   * silently write" — a module script must never be auto-saved through the
   * object-script path. That rule is preserved for N documents by KEEPING the
   * edits here instead: nothing is written, and coming back shows exactly what
   * was being read.
   */
  const stashActiveMacroBuffer = useCallback(() => {
    const id = activeDocIdRef.current;
    if (!id) return;
    if (!macroDocsRef.current.some((d) => d.macroId === id)) return;
    const buffer = sourceRef.current;
    const dirty = isDirtyRef.current;
    setMacroDocs((prev) =>
      prev.map((d) =>
        d.macroId === id ? { ...d, script: { ...d.script, source: buffer }, dirty } : d,
      ),
    );
  }, []);
  const stashActiveBufferRef = useRef(stashActiveMacroBuffer);
  stashActiveBufferRef.current = stashActiveMacroBuffer;

  // Listen for Tauri events from main window (registered once on mount)
  useEffect(() => {
    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    // The OPEN-channel registrations. The main window holds delivery of the
    // initial macro/script/draft until this editor says it is ready, and "ready"
    // means exactly these three listeners are live — so READY is emitted only
    // after all three `listen()` round-trips have resolved.
    const openChannelReady: Array<Promise<unknown>> = [];

    // Open with specific script — set activeScriptId and reload scripts
    // from backend to ensure we have the latest (including newly created scripts).
    const openWithScriptReady = onOpenWithScript(async (payload) => {
      if (cancelled) return;
      if (payload.scriptId) {
        setActiveScriptId(payload.scriptId);
        // Always reload from backend to pick up newly created scripts
        try {
          const allScripts = await loadAllObjectScripts();
          if (!cancelled) {
            setScripts(allScripts);
          }
        } catch (e) {
          console.error("[ObjectScriptEditorApp] Failed to reload scripts:", e);
        }
      }
    }).then((fn) => { if (!cancelled) unlisteners.push(fn); else fn(); });
    openChannelReady.push(openWithScriptReady);

    // An AI-authored draft handed over for review. Nothing here saves, registers
    // or mounts it — it is loaded into the editor as text, under a banner that
    // says so, and only the Save button can make it real.
    const openWithDraftReady = onOpenWithDraft((payload) => {
      if (cancelled) return;
      const script = draftToScriptDefinition(payload.draft);
      setDraftDoc({ draft: payload.draft, script });
      setActiveScriptId(script.id);
      setSource(script.source);
      setLanguage("javascript");
      setIsDirty(false);
    }).then((fn) => { if (!cancelled) unlisteners.push(fn); else fn(); });
    openChannelReady.push(openWithDraftReady);

    // A recorded macro (a MODULE script) opened for editing. Re-read the
    // authoritative record here so the editor always shows the live source, not
    // a copy that rode the wire; fall back to the preview if the record has
    // since been deleted, so the window still shows what the caller meant.
    //
    // OPENING IS SELECTING. A macro already in the list is SELECTED, never added
    // a second time, and if the author has unsaved edits in it those edits are
    // what they are shown — re-opening a document must not be a way to throw
    // work away.
    const openWithMacroReady = onOpenWithModuleMacro((payload) => {
      if (cancelled) return;
      void (async () => {
        // Whatever is in the buffer belongs to the document being left. Read the
        // live values here too: re-opening the document that is ALREADY in front
        // of the author must see its unsaved edits, and the stash above is a
        // state update that has not landed yet.
        const leavingId = activeDocIdRef.current;
        const liveBuffer = sourceRef.current;
        const liveDirty = isDirtyRef.current;
        stashActiveBufferRef.current();

        let record: WorkbookScriptRecord | null = null;
        let readError: string | null = null;
        try {
          const live = await getWorkbookScript(payload.macroId);
          record = {
            id: live.id,
            name: live.name,
            description: live.description ?? null,
            source: live.source,
            scope: live.scope,
            sourcePackage: live.sourcePackage ?? null,
            loadError: null,
          };
        } catch (e) {
          readError = e instanceof Error ? e.message : String(e);
        }
        if (cancelled) return;

        const listed = macroDocsRef.current.find((d) => d.macroId === payload.macroId);
        const isReopeningActive = listed !== undefined && listed.macroId === leavingId;
        const existing = listed
          ? {
              dirty: isReopeningActive ? liveDirty : listed.dirty,
              source: isReopeningActive ? liveBuffer : listed.script.source,
            }
          : undefined;
        if (!record) {
          // The record could not be read. Say so — a blank editor with no
          // explanation is the failure mode this whole feature keeps hitting.
          reportToConsole(
            `"${payload.name}" could not be read from the workbook (${readError}). ` +
              (existing
                ? "Showing the copy already open here."
                : "Showing the preview the caller sent; saving will write it back."),
            payload.macroId,
          );
          record = {
            id: payload.macroId,
            name: payload.name,
            description: payload.description,
            source: existing ? existing.source : payload.source,
            sourcePackage: null,
            loadError: readError,
          };
        }

        const fresh = macroDocFromRecord(record);
        const keepBuffer = existing?.dirty === true;
        const doc: MacroDoc = keepBuffer
          ? {
              ...fresh,
              script: { ...fresh.script, source: existing!.source },
              dirty: true,
            }
          : fresh;

        setMacroDocs((prev) => {
          const without = prev.filter((d) => d.macroId !== doc.macroId);
          return [...without, doc].sort((a, b) => a.script.name.localeCompare(b.script.name));
        });
        setActiveScriptId(doc.macroId);
        setSource(doc.script.source);
        setLanguage("javascript");
        setIsDirty(doc.dirty);
        loadedDocIdRef.current = doc.macroId;
        if (keepBuffer) {
          reportToConsole(
            `"${doc.script.name}" was already open here with unsaved edits — those edits are shown, ` +
              "not the stored version.",
            doc.macroId,
            "info",
          );
        }
      })();
    }).then((fn) => { if (!cancelled) unlisteners.push(fn); else fn(); });
    openChannelReady.push(openWithMacroReady);

    // The main window waits for this before delivering the initial open payload.
    // Emitted only once every OPEN listener is registered, so a payload sent in
    // response cannot arrive before this editor can receive it.
    void Promise.all(openChannelReady)
      .then(() => {
        if (!cancelled) void emitEditorReady();
      })
      .catch(() => {
        /* a failed listen registration surfaces elsewhere; the timer fallback
           in the main window still delivers so the window is never left blank */
      });

    // Console output forwarded from main window
    onConsoleOutput((payload) => {
      if (cancelled) return;
      const message = payload.args.map((a) => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
      setConsoleEntries((prev) => [
        ...prev,
        {
          id: ++consoleIdRef.current,
          level: (payload.level as ConsoleEntry["level"]) || "log",
          message,
          scriptId: payload.scriptId,
          timestamp: Date.now(),
        },
      ]);
    }).then((fn) => { if (!cancelled) unlisteners.push(fn); else fn(); });

    // Script errors forwarded from main window
    onScriptError((payload) => {
      if (cancelled) return;
      const message = `[${payload.scriptName}] Error: ${payload.error}${payload.stack ? "\n" + payload.stack : ""}`;
      setConsoleEntries((prev) => [
        ...prev,
        {
          id: ++consoleIdRef.current,
          level: "error",
          message,
          scriptId: payload.scriptId,
          timestamp: Date.now(),
        },
      ]);
      setShowConsole(true);
    }).then((fn) => { if (!cancelled) unlisteners.push(fn); else fn(); });

    // Scripts changed externally
    onScriptsChanged((payload) => {
      if (cancelled) return;
      setScripts(payload.scripts);
    }).then((fn) => { if (!cancelled) unlisteners.push(fn); else fn(); });

    // Announce a RELOAD/navigation of this webview. NOT the window closing:
    // measured under Tauri + WebView2, `beforeunload` does not run when the
    // window is closed, so the authoritative close announcement is made by the
    // MAIN window from `tauri://destroyed` (openObjectScriptWindow.ts). This one
    // covers the case the main window cannot see — the editor's own document
    // going away while the window lives on.
    const handleBeforeUnload = () => {
      emitEditorClosed();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      cancelled = true;
      unlisteners.forEach((fn) => fn());
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, []);

  // When the ACTIVE DOCUMENT changes, load its buffer. If nothing is selected
  // but something exists, auto-select it (object scripts first, then modules —
  // a workbook can hold macros and no object scripts at all).
  //
  // `loadedDocIdRef` guards the whole effect: it re-runs whenever the lists
  // change, and without the guard a background refresh of the macro list would
  // reset the buffer the author is typing in.
  useEffect(() => {
    if (!activeScriptId && scripts.length > 0) {
      setActiveScriptId(scripts[0].id);
      setSource(scripts[0].source);
      setIsDirty(false);
      loadedDocIdRef.current = scripts[0].id;
      return;
    }
    if (!activeScriptId && macroDocs.length > 0) {
      const first = macroDocs[0];
      setActiveScriptId(first.macroId);
      setSource(first.script.source);
      setIsDirty(first.dirty);
      loadedDocIdRef.current = first.macroId;
      return;
    }
    if (!activeScriptId) return;
    if (loadedDocIdRef.current === activeScriptId) return;
    const script = scripts.find((s) => s.id === activeScriptId);
    if (script) {
      setSource(script.source);
      setIsDirty(false);
      loadedDocIdRef.current = activeScriptId;
      return;
    }
    // The draft is not in `scripts`, so it needs its own restore path — without
    // it, selecting the draft again from the dropdown would show whatever text
    // the previous script left behind.
    if (draftDoc && draftDoc.script.id === activeScriptId) {
      setSource(draftDoc.script.source);
      setIsDirty(false);
      loadedDocIdRef.current = activeScriptId;
      return;
    }
    // Same for a module script (a recorded macro): it is not in the
    // object-script list either — and its buffer carries ITS unsaved edits.
    const doc = macroDocs.find((d) => d.macroId === activeScriptId);
    if (doc) {
      setSource(doc.script.source);
      setIsDirty(doc.dirty);
      loadedDocIdRef.current = activeScriptId;
    }
  }, [activeScriptId, scripts, draftDoc, macroDocs]);

  // Auto-scroll console
  useEffect(() => {
    consoleEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [consoleEntries]);

  const savedScript = scripts.find((s) => s.id === activeScriptId) ?? null;
  /** True while the document in front of the author is an unsaved AI draft. */
  const isDraft =
    savedScript === null && draftDoc !== null && draftDoc.script.id === activeScriptId;
  /** The module document in front of the author, if the active one is a module. */
  const macroDoc =
    savedScript === null && !isDraft
      ? macroDocs.find((d) => d.macroId === activeScriptId) ?? null
      : null;
  /** True while the document in front of the author is a recorded MACRO (module script). */
  const isMacro = macroDoc !== null;
  const activeScript =
    savedScript ?? (isDraft ? draftDoc!.script : macroDoc ? macroDoc.script : null);
  const isReadOnly = activeScript?.provenance === "distributed";
  const docs = activeScript ? getContextDocumentation(activeScript.objectType) : [];

  // Point `ObjectScriptContext` at THIS script's context interface, so
  // `@param {ObjectScriptContext} context` resolves to (say) SlicerContext —
  // on BOTH lanes, because JSDoc types only apply to a .js model and real
  // annotations only apply to a .ts one.
  useEffect(() => {
    if (!activeScript) return;
    setActiveContextType(monacoTs, activeScript.objectType, objectContextsDts);
    registerTypescriptLane(monacoTs, activeScript.objectType, objectContextsDts);
  }, [activeScript]);

  // Switch active script
  const handleSelectScript = useCallback(async (scriptId: string) => {
    // A DRAFT is never auto-saved. Switching away from AI-authored code must
    // not be the thing that writes it into the workbook — the whole point of a
    // draft is that only an explicit Save promotes it. Keep the author's edits
    // in the draft instead, so coming back shows what they were reading.
    if (isDraft && draftDoc) {
      setDraftDoc({ ...draftDoc, script: { ...draftDoc.script, source } });
      setLanguage("javascript");
      setActiveScriptId(scriptId);
      return;
    }
    // A MACRO is a real record, but switching away must not silently write the
    // MODULE store from the object-script auto-save path below (it would create a
    // spurious object script). Keep the edits in ITS OWN document — Save is the
    // only thing that persists them, and coming back to that macro (not merely
    // the last one) shows what was being read.
    if (isMacro) {
      stashActiveMacroBuffer();
      setLanguage("javascript");
      setActiveScriptId(scriptId);
      return;
    }
    // Auto-save current. The same gate as the Save button: an auto-save is
    // still a save, and un-runnable text must never reach the store just
    // because the author picked another script from the list.
    if (isDirty && activeScript) {
      const gate = await gateObjectScriptSave(source, activeScript.name, hostValidateScript);
      if (!gate.ok) {
        reportToConsole(gate.detail, activeScript.id);
        return;
      }
      const updated = { ...activeScript, source: gate.javascript };
      saveObjectScript(updated).catch(console.error);
      emitRegisterScript(updated).catch(console.error);
    }
    setLanguage("javascript");
    setActiveScriptId(scriptId);
  }, [
    isDirty,
    isDraft,
    draftDoc,
    isMacro,
    stashActiveMacroBuffer,
    activeScript,
    source,
    reportToConsole,
  ]);

  // Save a recorded MACRO back to the MODULE store (`save_script`) — NOT the
  // object-script store. The macro is the single canonical thing every linking
  // button runs, so editing it here is reflected on every button with no re-save
  // of the button. The description marker (runtime=objectScript) is preserved
  // verbatim so the macro keeps routing correctly. No persistent object script
  // is mounted: buttons run the macro transiently per click, and debug/run mount
  // it transiently under the synthetic definition.
  const handleSaveMacro = useCallback(async () => {
    if (!activeScript || !macroDoc) return;
    const gate = await gateObjectScriptSave(source, activeScript.name, hostValidateScript);
    if (!gate.ok) {
      reportToConsole(gate.detail, activeScript.id);
      return;
    }
    const storedSource = gate.javascript;
    try {
      await saveWorkbookScript({
        id: macroDoc.macroId,
        name: activeScript.name,
        description: macroDoc.description,
        source: storedSource,
        scope: { type: "workbook" },
      });
      setMacroDocs((prev) =>
        prev.map((d) =>
          d.macroId === macroDoc.macroId
            ? {
                ...d,
                script: { ...d.script, source: storedSource },
                savedSource: storedSource,
                dirty: false,
                // A save is also the answer to "this was deleted while you had
                // edits": it exists again, so the warning must go.
                loadError: null,
              }
            : d,
        ),
      );
      setIsDirty(false);
      if (gate.transformed) {
        setSource(storedSource);
        setLanguage("javascript");
        reportToConsole(
          "TypeScript compiled to JavaScript. The stored macro is the JavaScript now shown.",
          macroDoc.macroId,
          "info",
        );
      }
      reportToConsole(
        `Macro "${activeScript.name}" saved. Every button that links it runs this version now.`,
        macroDoc.macroId,
        "info",
      );
    } catch (e) {
      reportToConsole(`Failed to save macro: ${e}`, macroDoc.macroId, "error");
    }
  }, [activeScript, macroDoc, source, reportToConsole]);

  // Save & Apply
  const handleSave = useCallback(async () => {
    if (!activeScript) return;
    // A macro routes to the MODULE store, never the object-script store.
    if (isMacro) {
      await handleSaveMacro();
      return;
    }

    // THE GATE. Compile (TypeScript in, JavaScript out; JavaScript passes
    // through byte for byte) and parse the result in a scratch worker —
    // nothing user-authored executes. A failure here BLOCKS the save: the
    // store feeds the runtime, the source hash behind every capability grant,
    // the transparency panel and .calp distribution, so it must never hold
    // text that cannot run. The author's edit stays in the editor.
    const gate = await gateObjectScriptSave(source, activeScript.name, hostValidateScript);
    if (!gate.ok) {
      reportToConsole(gate.detail, activeScript.id);
      return;
    }

    // From here on, ONE artifact: the JavaScript that will run.
    const storedSource = gate.javascript;
    const updated = { ...activeScript, source: storedSource };
    try {
      await saveObjectScript(updated);

      // Tell main window to register + remount. What is sent is exactly what was
      // stored: debug instrumentation is applied by the HOST, inside the worker,
      // only for a script the user opened a session on — never baked into the
      // artifact that is persisted, hashed for consent or distributed.
      await emitSaveAndApply(updated);

      setIsDirty(false);
      if (isDraft) {
        // The draft has become a real, saved, mounted script — it belongs in
        // the script list now, and the review banner must go away with it.
        setScripts((prev) => [...prev, updated]);
        setDraftDoc(null);
        reportToConsole(
          `AI draft "${updated.name}" saved as a local object script and mounted. ` +
            "It runs from now on; delete it if that is not what you wanted.",
          updated.id,
          "info",
        );
      }
      if (gate.transformed) {
        // Show the author exactly what was stored: the editor must never be
        // out of step with the text that runs, is hashed for consent and is
        // shown to whoever reviews this workbook.
        setSource(storedSource);
        setLanguage("javascript");
        reportToConsole(
          "TypeScript compiled to JavaScript. The stored script is the JavaScript now shown.",
          updated.id,
          "info",
        );
      }
      // Update local state
      setScripts((prev) => prev.map((s) => s.id === updated.id ? updated : s));
    } catch (e) {
      setConsoleEntries((prev) => [
        ...prev,
        {
          id: ++consoleIdRef.current,
          level: "error",
          message: `Failed to save: ${e}`,
          scriptId: activeScript.id,
          timestamp: Date.now(),
        },
      ]);
      setShowConsole(true);
    }
  }, [activeScript, isDraft, isMacro, handleSaveMacro, source, reportToConsole]);

  // Toggle access level. The backend is authoritative: distributed scripts
  // cannot be escalated, so the local state and the cross-window event are
  // only updated AFTER the save succeeds — otherwise a rejected escalation
  // would still mount with the unlocked API for the session.
  const handleToggleAccess = useCallback(async () => {
    if (!activeScript) return;
    // A macro is always run at the unlocked tier (that is the only tier where
    // `context.api` is non-null). There is no per-tier flag in the module store,
    // and routing this through the object-script save path would fabricate an
    // object script. The access control is simply hidden for a macro.
    if (isMacro) return;
    // A draft has no backend record, so there is nothing to persist yet —
    // and persisting it HERE would write AI-authored code into the workbook
    // behind a button the author pressed to read a tier label. Keep the choice
    // in the draft; the Save that promotes it carries the tier with it.
    if (isDraft && draftDoc) {
      const nextLevel: ScriptAccessLevel =
        draftDoc.script.accessLevel === "restricted" ? "unlocked" : "restricted";
      setDraftDoc({ ...draftDoc, script: { ...draftDoc.script, accessLevel: nextLevel } });
      return;
    }
    if (activeScript.provenance === "distributed") {
      setConsoleEntries((prev) => [
        ...prev,
        {
          id: ++consoleIdRef.current,
          level: "error",
          message: "Distributed scripts cannot change access level. Copy the script to a local one to take ownership.",
          scriptId: activeScript.id,
          timestamp: Date.now(),
        },
      ]);
      setShowConsole(true);
      return;
    }
    const newLevel: ScriptAccessLevel = activeScript.accessLevel === "restricted" ? "unlocked" : "restricted";
    const updated = { ...activeScript, accessLevel: newLevel };
    try {
      await saveObjectScript(updated);
    } catch (e) {
      setConsoleEntries((prev) => [
        ...prev,
        {
          id: ++consoleIdRef.current,
          level: "error",
          message: `Failed to change access level: ${e}`,
          scriptId: activeScript.id,
          timestamp: Date.now(),
        },
      ]);
      setShowConsole(true);
      return;
    }
    emitToggleAccess(updated).catch(console.error);
    setScripts((prev) => prev.map((s) => s.id === updated.id ? updated : s));
  }, [activeScript, isDraft, isMacro, draftDoc]);

  // Add new primitive script
  const handleAddScript = useCallback(async (objectType: ScriptableObjectType) => {
    // Check if one already exists
    const existing = scripts.find((s) => s.objectType === objectType && !s.instanceId);
    if (existing) {
      setActiveScriptId(existing.id);
      return;
    }

    const id = crypto.randomUUID();
    const name = objectType.charAt(0).toUpperCase() + objectType.slice(1) + " Script";
    const script: ObjectScriptDefinition = {
      id,
      name,
      objectType,
      instanceId: null,
      // The annotation is what makes `context.` complete; a new script starts
      // with it so an author never has to know the trick.
      source: annotateScaffold(getScaffoldTemplate(objectType)),
      accessLevel: "restricted",
    };
    await saveObjectScript(script);
    await emitRegisterScript(script);
    setScripts((prev) => [...prev, script]);
    setActiveScriptId(id);
    setSource(script.source);
    setLanguage("javascript");
    setIsDirty(false);
  }, [scripts]);

  // ---- Debugging (task H1) -------------------------------------------------
  // This window has no script host of its own: the workers live in the main
  // window, so every command travels over the Tauri bridge and the session
  // state is mirrored back.
  useEffect(() => {
    setRemoteDebugTransport();
    injectDebugStyles();
    return subscribeRemoteDebugState();
  }, []);

  // A MODULE macro has no standing mount by design — buttons run it transiently
  // per click — so Debug must be able to ask the host to mount it FROM THE
  // MODULE STORE. Without this the Debug button threw "Cannot debug a script
  // that is not mounted" on every cold open, and only worked after something
  // else had happened to leave a mount behind.
  const debug = useDebugSession(activeScriptId ?? null, { mountFromModuleStore: isMacro });
  const debugRef = useRef(debug);
  debugRef.current = debug;
  const activeScriptIdRef = useRef<string | null>(activeScriptId ?? null);
  activeScriptIdRef.current = activeScriptId ?? null;
  const debugDecorationsRef = useRef<string[]>([]);
  const breakpointLines = debug.breakpointLines;

  const applyDebugDecorations = useCallback(
    (ed: monacoEditor.IStandaloneCodeEditor, decorations: DebugDecoration[]) => {
      debugDecorationsRef.current = ed.deltaDecorations(
        debugDecorationsRef.current,
        decorations.map((d) => ({
          range: new monaco.Range(d.line, 1, d.line, 1),
          options: {
            isWholeLine: true,
            glyphMarginClassName: d.glyphClassName,
            glyphMarginHoverMessage: { value: d.hover },
            className: d.lineClassName,
            linesDecorationsClassName: d.lineClassName ?? "breakpoint-line-decoration",
          },
        })),
      );
    },
    [],
  );

  useEffect(() => {
    const ed = editorRef.current;
    if (ed) applyDebugDecorations(ed, debug.decorations);
  }, [debug.decorations, applyDebugDecorations]);

  // Run-at-cursor (VBA F5): run the top-level function the cursor is in, through
  // the same fire/exposed-method door the Fire buttons use. Never a wrong-arity
  // call and never a silent no-op — an unresolvable cursor speaks in the console.
  const runFromCursor = useCallback(async () => {
    const ed = editorRef.current;
    if (!ed || !activeScript || isDraft || isReadOnly) return;
    if (isDirty) {
      reportToConsole(
        "Save first — Run uses the saved source so a breakpoint lands where you see it.",
        activeScript.id,
      );
      return;
    }
    const line = ed.getPosition()?.lineNumber ?? 1;
    // A module macro is mounted from the STORE, by id: Run is disabled while the
    // buffer is dirty precisely so "what you see" and "what is stored" are the
    // same text, and the host must never be handed a body by a caller.
    // A throw here is the host refusing (no session, no such trigger, a mount
    // that Script Security blocked). Unhandled it would be an unhandled promise
    // rejection and, on screen, a Run button that did nothing at all — the exact
    // silence this whole feature keeps regressing into. It goes in the console.
    try {
      const outcome = await runAtCursor(activeScript.id, source, line, {
        mountFromModuleStore: isMacro,
      });
      if (outcome.status === "ran") {
        reportToConsole(`Running ${outcome.functionName}()…`, activeScript.id, "info");
      } else {
        reportToConsole(outcome.message, activeScript.id, "error");
      }
    } catch (e) {
      reportToConsole(
        `Run failed: ${e instanceof Error ? e.message : String(e)}`,
        activeScript.id,
        "error",
      );
    }
  }, [activeScript, isDraft, isReadOnly, isDirty, source, isMacro, reportToConsole]);
  const runFromCursorRef = useRef(runFromCursor);
  runFromCursorRef.current = runFromCursor;

  // A debugger that stops off-screen looks exactly like one that did not stop.
  const pausedLine = debug.session?.paused?.line;
  useEffect(() => {
    const ed = editorRef.current;
    if (ed && pausedLine) {
      ed.revealLineInCenterIfOutsideViewport(pausedLine);
      ed.setPosition({ lineNumber: pausedLine, column: 1 });
    }
  }, [pausedLine]);

  // Monaco mount
  const handleMount: OnMount = useCallback((ed) => {
    editorRef.current = ed;
    // Re-assert this surface's share of the shared language services. Module
    // load order decides who configured Monaco first; mount order decides who
    // configured it LAST, and the merged configuration has to win.
    registerJavascriptLane(monacoTs, objectContextsDts);
    // Warm the compiler chunk in the background so the first save is not the
    // moment it is fetched. Fire-and-forget: mounting never waits on it.
    prefetchScriptTranspiler();
    ed.addAction({
      id: "objectScript.save",
      label: "Save Script",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => handleSave(),
    });
    ed.addAction({
      // VBA F5: when paused, F5 CONTINUES; otherwise it RUNS the function the
      // cursor is in. One key, the mental model VBA users already have.
      id: "objectScript.debug.runOrContinue",
      label: "Run / Continue (F5)",
      keybindings: [monaco.KeyCode.F5],
      run: () => {
        if (debugRef.current.isPaused) debugRef.current.send("continue");
        else void runFromCursorRef.current();
      },
    });
    ed.addAction({
      id: "objectScript.debug.stepOver",
      label: "Debug: Step Over",
      keybindings: [monaco.KeyCode.F10],
      run: () => debugRef.current.send("stepOver"),
    });
    ed.addAction({
      id: "objectScript.debug.stepInto",
      label: "Debug: Step Into",
      keybindings: [monaco.KeyCode.F11],
      run: () => debugRef.current.send("stepInto"),
    });
    ed.addAction({
      id: "objectScript.debug.toggleBreakpoint",
      label: "Debug: Toggle Breakpoint",
      keybindings: [monaco.KeyCode.F9],
      run: (editor) => {
        const line = editor.getPosition()?.lineNumber;
        if (line) debugRef.current.toggleLine(line);
      },
    });

    ed.onMouseDown((e) => {
      if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) {
        const line = e.target.position?.lineNumber;
        if (line && activeScriptIdRef.current) debugRef.current.toggleLine(line);
      }
    });

    // Keep breakpoints anchored to their statement across edits.
    ed.onDidChangeModelContent((e) => {
      const scriptId = activeScriptIdRef.current;
      if (!scriptId) return;
      for (const change of e.changes) {
        const shift = breakpointShift(change);
        if (shift) shiftBreakpoints(scriptId, shift.fromLine, shift.delta);
      }
    });

    applyDebugDecorations(ed, debugRef.current.decorations);
    ed.focus();
  }, [handleSave, applyDebugDecorations]);

  const handleChange = useCallback((val: string | undefined) => {
    if (val !== undefined) {
      setSource(val);
      setIsDirty(true);
    }
  }, []);

  const handleInsertMethod = useCallback((methodName: string) => {
    if (editorRef.current) {
      const position = editorRef.current.getPosition();
      if (position) {
        editorRef.current.executeEdits("", [
          {
            range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column),
            text: methodName,
          },
        ]);
        editorRef.current.focus();
      }
    }
  }, []);

  // Template state
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);

  useEffect(() => {
    listTemplates().then(setTemplates).catch(() => {});
  }, []);

  const handleSaveAsTemplate = useCallback(async () => {
    if (!activeScript) return;
    const name = prompt("Template name:", `${activeScript.name} Template`);
    if (!name) return;
    // A template is stamped straight into a new script, so it is subject to the
    // same rule: only JavaScript that compiles may be stored.
    const gate = await gateObjectScriptSave(source, activeScript.name, hostValidateScript);
    if (!gate.ok) {
      reportToConsole(gate.detail, activeScript.id);
      return;
    }
    const template = createTemplateFromScript({ ...activeScript, source: gate.javascript }, name);
    await saveTemplate(template);
    setTemplates(await listTemplates());
  }, [activeScript, source, reportToConsole]);

  const handleNewFromTemplate = useCallback(async (templateId: string) => {
    const template = await loadTemplate(templateId);
    if (!template) return;
    const instanceId = activeScript?.instanceId || null;
    const stamped = stampFromTemplate(template, instanceId || crypto.randomUUID());
    // Templates live on disk and can be hand-edited or copied in from
    // elsewhere, so a stamped script goes through the same gate as typed code.
    const gate = await gateObjectScriptSave(stamped.source, stamped.name, hostValidateScript);
    if (!gate.ok) {
      reportToConsole(gate.detail, stamped.id);
      return;
    }
    const created = { ...stamped, source: gate.javascript };
    await saveObjectScript(created);
    await emitRegisterScript(created);
    setScripts((prev) => [...prev, created]);
    setActiveScriptId(created.id);
    setSource(created.source);
    setLanguage("javascript");
    setIsDirty(false);
  }, [activeScript, reportToConsole]);

  const primitiveTypes: ScriptableObjectType[] = ["workbook", "sheet", "cell", "row", "column"];
  const errorCount = consoleEntries.filter((e) => e.level === "error").length;

  return (
    <div style={{
      display: "flex",
      flexDirection: "column",
      width: "100%",
      height: "100%",
      backgroundColor: "#1E1E1E",
      fontFamily: "'Segoe UI', Tahoma, sans-serif",
      fontSize: 12,
    }}>
      {/* Toolbar */}
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 10px",
        borderBottom: "1px solid #333",
        backgroundColor: "#252526",
        flexShrink: 0,
      }}>
        {/* Script selector */}
        <select
          className="ose-select"
          value={activeScriptId ?? ""}
          onChange={(e) => { void handleSelectScript(e.target.value); }}
        >
          {scripts.length === 0 && !draftDoc && macroDocs.length === 0 && (
            <option value="">No scripts</option>
          )}
          {draftDoc && (
            <option value={draftDoc.script.id}>
              AI DRAFT — {draftDoc.script.name} ({draftDoc.script.objectType})
            </option>
          )}
          {/* Every module script in the workbook, grouped — not just the one this
              window was navigated to. A recorder-marked module is a MACRO; an
              unmarked one is a hand-authored module, and both live here. */}
          {macroDocs.length > 0 && (
            <optgroup label="Macros / modules">
              {macroDocs.map((d) => {
                const dirty = d.macroId === activeScriptId ? isDirty : d.dirty;
                return (
                  <option key={d.macroId} value={d.macroId}>
                    {macroDocKindLabel(d)} — {d.script.name}
                    {dirty ? " •" : ""}
                    {d.loadError ? " (unreadable)" : ""}
                  </option>
                );
              })}
            </optgroup>
          )}
          {scripts.length > 0 && (
            <optgroup label="Object scripts">
              {scripts.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.objectType}{s.instanceId ? ` #${s.instanceId.slice(0, 8)}` : ""})
                </option>
              ))}
            </optgroup>
          )}
        </select>

        {/* Add script dropdown */}
        <select
          className="ose-select"
          value=""
          onChange={(e) => {
            if (e.target.value) {
              handleAddScript(e.target.value as ScriptableObjectType);
              e.target.value = "";
            }
          }}
        >
          <option value="">+ Add Script...</option>
          {primitiveTypes.map((t) => (
            <option key={t} value={t}>
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </option>
          ))}
        </select>

        {/* Separator */}
        <div style={{ width: 1, height: 18, backgroundColor: "#444", margin: "0 2px" }} />

        {/* Template controls */}
        {templates.length > 0 && (
          <select
            className="ose-select"
            value=""
            onChange={(e) => {
              if (e.target.value) {
                handleNewFromTemplate(e.target.value);
                e.target.value = "";
              }
            }}
          >
            <option value="">From Template...</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.objectType})
              </option>
            ))}
          </select>
        )}

        {/* Templates are auto-applied to newly created components, so an
            AI draft must become a script the user approved BEFORE it can be
            stamped into one. Save it first. */}
        {activeScript && !isDraft && !isMacro && (
          <button className="ose-btn" onClick={handleSaveAsTemplate} title="Save as reusable template">
            <IconTemplate /> Template
          </button>
        )}

        <div style={{ flex: 1 }} />

        {/* Right side */}
        {activeScript && !isReadOnly && (
          <button
            className="ose-btn"
            onClick={() => setLanguage((l) => (l === "typescript" ? "javascript" : "typescript"))}
            title={
              language === "typescript"
                ? "Authoring in TypeScript: type annotations are checked here and compiled to JavaScript when you save. The stored script is always the JavaScript."
                : "Authoring in JavaScript with JSDoc types. Switch to TypeScript to use real type annotations (compiled on save)."
            }
          >
            {language === "typescript" ? "TS" : "JS"}
          </button>
        )}

        {activeScript && !isMacro && (
          <button className="ose-btn" onClick={handleToggleAccess}
            title={`Access level: ${activeScript.accessLevel}. Click to toggle.`}>
            {activeScript.accessLevel === "restricted" ? <><IconLock /> Restricted</> : <><IconUnlock /> Unlocked</>}
          </button>
        )}
        {activeScript && isMacro && (
          <span className="ose-btn" style={{ cursor: "default", opacity: 0.85 }}
            title="A recorded macro always runs at the unlocked tier (where context.api is available).">
            <IconUnlock /> Macro
          </span>
        )}

        <div style={{ width: 1, height: 18, backgroundColor: "#444", margin: "0 2px" }} />

        <button className="ose-btn" onClick={() => setShowConsole(!showConsole)}
          style={errorCount > 0 && !showConsole ? { color: "#F48771" } : undefined}>
          <IconTerminal /> Console
          {errorCount > 0 && <span style={{
            background: "#D13438", color: "#fff", borderRadius: 8,
            padding: "0 5px", fontSize: 10, fontWeight: 600, marginLeft: 2,
          }}>{errorCount}</span>}
        </button>

        <button className="ose-btn" onClick={() => setShowSidebar(!showSidebar)}>
          <IconBook /> Docs
        </button>

        <div style={{ width: 1, height: 18, backgroundColor: "#444", margin: "0 2px" }} />

        {/* Step debugging. Only for an APPLIED script: a session instruments
            the source at mount, so there has to be a mount. A draft has none —
            and offering "run it" next to unreviewed AI code would be the one
            control this window must not have. */}
        {activeScript && !isDraft && (
          <DebugToolbar
            state={debug}
            disabled={isDirty}
            buttonClassName="ose-btn"
            onRun={() => void runFromCursor()}
            runDisabled={isDirty || isReadOnly}
            runDisabledTitle={
              isReadOnly
                ? "Distributed scripts are read-only and cannot be run from here."
                : "Save first — Run uses the saved source so a breakpoint lands where you see it."
            }
          />
        )}

        {activeScript && !isDraft && breakpointLines.length > 0 && !debug.session && (
          <button
            className="ose-btn"
            onClick={() => activeScriptId && clearBreakpoints(activeScriptId)}
            title={`Remove ${breakpointLines.length} breakpoint(s) from this script`}
          >
            Clear {breakpointLines.length} BP
          </button>
        )}

        <div style={{ width: 1, height: 18, backgroundColor: "#444", margin: "0 2px" }} />

        <button className="ose-btn primary" onClick={handleSave}
          // A draft has never been saved, so it is savable the moment it
          // arrives — requiring an edit first would leave the only way to
          // accept AI code being to change it.
          disabled={(!isDirty && !isDraft) || isReadOnly}
          title={
            isReadOnly
              ? "Distributed scripts are read-only"
              : isDraft
                ? "Save this AI draft as a real object script and mount it (Ctrl+S)"
                : isMacro
                  ? "Save the macro back to the workbook (Ctrl+S). Every button that links it runs this version."
                  : "Save and apply (Ctrl+S)"
          }>
          <IconSave />
          {isReadOnly ? "Read Only" : isDraft ? "Save as Script" : isMacro ? "Save Macro" : "Save & Apply"}
        </button>
      </div>

      {/* AI draft review banner. The MCP tool tells the agent its draft is
          "queued for the user to review"; this is what the user is shown, and
          it must state the two facts the agent cannot: nothing was saved, and
          nothing has run. */}
      {isDraft && draftDoc && (
        <div
          data-testid="ai-draft-banner"
          style={{
            padding: "8px 12px",
            backgroundColor: "#4A3B00",
            borderBottom: "1px solid #7A6200",
            color: "#FFD666",
            fontSize: 11,
            lineHeight: "1.5",
            flexShrink: 0,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 2 }}>
            AI draft — not saved, not mounted
          </div>
          <div>
            An AI tool wrote this for <strong>{draftDoc.draft.objectType}</strong>
            {draftDoc.draft.instanceId ? ` #${draftDoc.draft.instanceId.slice(0, 8)}` : ""}. None of
            it has run. It exists only in this window until you press{" "}
            <strong>Save as Script</strong>, which stores it, mounts it and lets it run from then
            on.
          </div>
          <div style={{ marginTop: 2 }}>
            Declares:{" "}
            {draftDoc.draft.declaredCapabilities.length === 0
              ? "no capabilities (grid only)"
              : draftDoc.draft.declaredCapabilities.join(", ")}
            {" · "}Tier: {draftDoc.script.accessLevel}
          </div>
          {draftDoc.draft.description && (
            <div style={{ marginTop: 2, opacity: 0.85 }}>{draftDoc.draft.description}</div>
          )}
        </div>
      )}

      {/* A module the store could not give us. The editor still opens ON it —
          hiding it would leave a blank window with no explanation — but it says
          what is wrong and what saving will do. */}
      {macroDoc && macroDoc.loadError && (
        <div
          data-testid="macro-load-error-banner"
          style={{
            padding: "8px 12px",
            backgroundColor: "#3A2323",
            borderBottom: "1px solid #6A3A3A",
            color: "#FF9B9B",
            fontSize: 11,
            lineHeight: "1.5",
            flexShrink: 0,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 2 }}>
            "{macroDoc.script.name}" could not be read from this workbook
          </div>
          <div>{macroDoc.loadError}</div>
          <div style={{ marginTop: 2, opacity: 0.85 }}>
            Debugging and Run need the stored module, so they will fail until this is saved.
          </div>
        </div>
      )}

      {/* Main area */}
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {/* Editor + Console */}
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          <div style={{ flex: 1, minHeight: 0 }}>
            <Editor
              height="100%"
              language={language}
              // The model NAME decides how Monaco's worker parses the text
              // (tsWorker.getScriptKind reads the extension), so the path —
              // not the `language` prop alone — is what makes TypeScript
              // annotations legal. One model per script keeps the squiggles
              // attached to the script in front of the author.
              path={objectScriptModelPath(activeScriptId, language)}
              theme="vs-dark"
              value={source}
              onChange={handleChange}
              onMount={handleMount}
              options={{
                fontSize: 13,
                fontFamily: "'Cascadia Code', 'Consolas', 'Courier New', monospace",
                lineNumbers: "on",
                glyphMargin: true,
                folding: true,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                automaticLayout: true,
                tabSize: 2,
                wordWrap: "on",
                quickSuggestions: true,
                suggestOnTriggerCharacters: true,
                parameterHints: { enabled: true },
                hover: { enabled: true },
                fixedOverflowWidgets: true,
                matchBrackets: "always",
                readOnly: isReadOnly,
                renderLineHighlight: "all",
                cursorBlinking: "smooth",
                smoothScrolling: true,
                padding: { top: 8 },
              }}
            />
          </div>

          {/* Debugger: locals, call stack, and why a breakpoint did not stop */}
          <DebugPanel
            state={debug}
            onRevealLine={(line) => {
              const ed = editorRef.current;
              if (!ed) return;
              ed.revealLineInCenter(line);
              ed.setPosition({ lineNumber: line, column: 1 });
              ed.focus();
            }}
          />

          {/* Console */}
          {showConsole && (
            <>
              <div className="ose-splitter" onMouseDown={onConsoleSplitterMouseDown} />
              <div style={{ height: consoleHeight, display: "flex", flexDirection: "column", flexShrink: 0 }}>
                <div style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "3px 10px", backgroundColor: "#252526",
                  borderBottom: "1px solid #333", fontSize: 11, color: "#999", flexShrink: 0,
                }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ textTransform: "uppercase", fontWeight: 600, fontSize: 10, letterSpacing: "0.5px" }}>
                      Console
                    </span>
                    {errorCount > 0 && (
                      <span style={{ color: "#F48771", fontSize: 10 }}>
                        {errorCount} error{errorCount !== 1 && "s"}
                      </span>
                    )}
                  </span>
                  <button className="ose-btn" style={{ padding: "1px 6px", fontSize: 10 }}
                    onClick={() => setConsoleEntries([])}>
                    Clear
                  </button>
                </div>
                <div style={{
                  flex: 1, overflow: "auto", padding: "6px 12px",
                  fontFamily: "'Cascadia Code', Consolas, monospace",
                  fontSize: 11, lineHeight: "1.6", backgroundColor: "#1E1E1E", color: "#D4D4D4",
                }}>
                  {consoleEntries.length === 0 && (
                    <div style={{ color: "#555", fontStyle: "italic" }}>
                      Script output will appear here...
                    </div>
                  )}
                  {consoleEntries.map((entry) => (
                    <div key={entry.id} className="ose-console-line"
                      style={entry.level === "error" ? { color: "#F48771" }
                        : entry.level === "warn" ? { color: "#CCA700" } : undefined}>
                      <span style={{ color: "#555", marginRight: 8, fontSize: 10 }}>
                        {new Date(entry.timestamp).toLocaleTimeString()}
                      </span>
                      {entry.message}
                    </div>
                  ))}
                  <div ref={consoleEndRef} />
                </div>
              </div>
            </>
          )}
        </div>

        {/* Sidebar */}
        {showSidebar && (
          <div style={{
            width: 230, borderLeft: "1px solid #333", backgroundColor: "#252526",
            overflowY: "auto", padding: "10px 12px", fontSize: 11,
          }}>
            <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 8, color: "#ccc",
              display: "flex", alignItems: "center", gap: 6 }}>
              <IconBook /> API Reference
            </div>
            {activeScript && (
              <div style={{
                fontSize: 10, color: "#569CD6", marginBottom: 12,
                fontFamily: "'Cascadia Code', Consolas, monospace",
                padding: "3px 6px", background: "rgba(86,156,214,0.08)",
                borderRadius: 3, display: "inline-block",
              }}>
                {activeScript.objectType.charAt(0).toUpperCase() + activeScript.objectType.slice(1)}Context
              </div>
            )}
            {docs.map((cat) => (
              <div key={cat.category}>
                <div style={{
                  fontWeight: 600, fontSize: 10, color: "#888",
                  marginBottom: 4, marginTop: 12, textTransform: "uppercase", letterSpacing: "0.5px",
                }}>
                  {cat.category}
                </div>
                {cat.methods.map((m) => (
                  <div key={m.name}>
                    <div className="ose-sidebar-method"
                      onClick={() => handleInsertMethod(m.name)}
                      title={`Click to insert "${m.name}" at cursor`}>
                      {m.signature}
                    </div>
                    <div style={{ fontSize: 10, color: "#666", marginBottom: 6, marginLeft: 6, lineHeight: "1.4" }}>
                      {m.description}
                    </div>
                  </div>
                ))}
              </div>
            ))}
            {docs.length === 0 && (
              <div style={{ color: "#555", fontSize: 11, fontStyle: "italic", marginTop: 16 }}>
                No script selected
              </div>
            )}
          </div>
        )}
      </div>

      {/* Status bar */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "3px 12px", borderTop: "1px solid #333",
        backgroundColor: "#007ACC", fontSize: 11, color: "#fff", flexShrink: 0, height: 22,
      }}>
        <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {activeScript
            ? <>
                <span>{activeScript.objectType}</span>
                <span style={{ opacity: 0.7 }}>|</span>
                <span>{activeScript.accessLevel}</span>
                {isDraft && <><span style={{ opacity: 0.7 }}>|</span><span>AI draft (not saved, not mounted)</span></>}
                {isReadOnly && <><span style={{ opacity: 0.7 }}>|</span><span>distributed (read-only)</span></>}
                {activeScript.packageName && <><span style={{ opacity: 0.7 }}>|</span><span>from "{activeScript.packageName}"</span></>}
              </>
            : <span>No script selected</span>}
        </span>
        <span style={{ display: "flex", gap: 12, alignItems: "center" }}>
          {errorCount > 0 && (
            <span style={{ background: "rgba(255,255,255,0.15)", padding: "0 6px", borderRadius: 3 }}>
              {errorCount} error{errorCount !== 1 && "s"}
            </span>
          )}
          <span>{isDraft ? "Never saved" : isDirty ? "Modified" : "Saved"}</span>
        </span>
      </div>
    </div>
  );
}
