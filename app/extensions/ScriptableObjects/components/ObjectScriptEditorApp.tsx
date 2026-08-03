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
import { getWorkbookScript, saveWorkbookScript } from "@api/workbookScripts";
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
import type { MacroDebugMount } from "../lib/debugger";
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
  // A recorded MACRO opened for editing. Unlike a draft it IS a real, saved
  // record — but in the MODULE store (`save_script`), not the object-script
  // store — so it needs its own doc-kind: Save routes to `saveWorkbookScript`,
  // and debug/run mount it transiently under a synthetic unlocked `workbook`
  // object-script definition. `description` carries the runtime marker verbatim,
  // so the macro keeps routing correctly after a round-trip through the editor.
  const [macroDoc, setMacroDoc] = useState<
    { macroId: string; script: ObjectScriptDefinition; description: string | null } | null
  >(null);
  // Authoring language for the OPEN script. Stored scripts are always
  // JavaScript (that is the only thing the worker can import), so this always
  // starts at "javascript"; switching to TypeScript is an authoring decision
  // that lasts until the next save compiles the text back down.
  const [language, setLanguage] = useState<ScriptAuthoringLanguage>("javascript");
  const [isDirty, setIsDirty] = useState(false);
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

  // Initial load
  useEffect(() => {
    loadScripts();
  }, [loadScripts]);

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
    const openWithMacroReady = onOpenWithModuleMacro((payload) => {
      if (cancelled) return;
      void (async () => {
        let name = payload.name;
        let source = payload.source;
        let description = payload.description;
        try {
          const record = await getWorkbookScript(payload.macroId);
          name = record.name;
          source = record.source;
          description = record.description ?? null;
        } catch (e) {
          console.warn("[ObjectScriptEditorApp] Could not re-read macro; using preview:", e);
        }
        if (cancelled) return;
        const script: ObjectScriptDefinition = {
          id: payload.macroId,
          name,
          objectType: "workbook",
          instanceId: null,
          source,
          accessLevel: "unlocked",
        };
        setMacroDoc({ macroId: payload.macroId, script, description });
        setActiveScriptId(payload.macroId);
        setSource(source);
        setLanguage("javascript");
        setIsDirty(false);
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

    // Notify main window on close
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

  // When activeScriptId or scripts change, load source.
  // If no script is selected but scripts exist, auto-select the first one.
  useEffect(() => {
    if (!activeScriptId && scripts.length > 0) {
      setActiveScriptId(scripts[0].id);
      setSource(scripts[0].source);
      setIsDirty(false);
      return;
    }
    if (!activeScriptId) return;
    const script = scripts.find((s) => s.id === activeScriptId);
    if (script) {
      setSource(script.source);
      setIsDirty(false);
      return;
    }
    // The draft is not in `scripts`, so it needs its own restore path — without
    // it, selecting the draft again from the dropdown would show whatever text
    // the previous script left behind.
    if (draftDoc && draftDoc.script.id === activeScriptId) {
      setSource(draftDoc.script.source);
      setIsDirty(false);
      return;
    }
    // Same for a recorded macro: it is not in the object-script list either.
    if (macroDoc && macroDoc.macroId === activeScriptId) {
      setSource(macroDoc.script.source);
      setIsDirty(false);
    }
  }, [activeScriptId, scripts, draftDoc, macroDoc]);

  // Auto-scroll console
  useEffect(() => {
    consoleEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [consoleEntries]);

  const savedScript = scripts.find((s) => s.id === activeScriptId) ?? null;
  /** True while the document in front of the author is an unsaved AI draft. */
  const isDraft =
    savedScript === null && draftDoc !== null && draftDoc.script.id === activeScriptId;
  /** True while the document in front of the author is a recorded MACRO (module script). */
  const isMacro =
    savedScript === null &&
    !isDraft &&
    macroDoc !== null &&
    macroDoc.macroId === activeScriptId;
  const activeScript =
    savedScript ?? (isDraft ? draftDoc!.script : isMacro ? macroDoc!.script : null);
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

  // Push one line into the editor console and reveal it.
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
    // spurious object script). Keep the edits in the macro doc — Save is the only
    // thing that persists them, and coming back shows what was being read.
    if (isMacro && macroDoc) {
      setMacroDoc({ ...macroDoc, script: { ...macroDoc.script, source } });
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
  }, [isDirty, isDraft, draftDoc, isMacro, macroDoc, activeScript, source, reportToConsole]);

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
      setMacroDoc({
        ...macroDoc,
        script: { ...macroDoc.script, source: storedSource },
      });
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

  const debug = useDebugSession(activeScriptId ?? null);
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

  // The synthetic transient mount a macro is debugged/run under — the unlocked
  // `workbook` object-script shape, carrying the CURRENT (saved) buffer so Run
  // reflects what the author sees. undefined for an ordinary object script,
  // which is already mounted from its own saved source.
  const macroMountFor = useCallback((): MacroDebugMount | undefined => {
    if (!isMacro || !macroDoc) return undefined;
    return {
      scriptId: macroDoc.macroId,
      name: macroDoc.script.name,
      source,
      objectType: "workbook",
      instanceId: null,
      accessLevel: "unlocked",
    };
  }, [isMacro, macroDoc, source]);

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
    const outcome = await runAtCursor(activeScript.id, source, line, macroMountFor());
    if (outcome.status === "ran") {
      reportToConsole(`Running ${outcome.functionName}()…`, activeScript.id, "info");
    } else {
      reportToConsole(outcome.message, activeScript.id);
    }
  }, [activeScript, isDraft, isReadOnly, isDirty, source, macroMountFor, reportToConsole]);
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
          {scripts.length === 0 && !draftDoc && !macroDoc && <option value="">No scripts</option>}
          {draftDoc && (
            <option value={draftDoc.script.id}>
              AI DRAFT — {draftDoc.script.name} ({draftDoc.script.objectType})
            </option>
          )}
          {macroDoc && (
            <option value={macroDoc.macroId}>
              MACRO — {macroDoc.script.name}
            </option>
          )}
          {scripts.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.objectType}{s.instanceId ? ` #${s.instanceId.slice(0, 8)}` : ""})
            </option>
          ))}
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
