//! FILENAME: app/extensions/ScriptableObjects/components/CodeEditorDialog.tsx
// PURPOSE: Monaco-based code editor dialog for editing object scripts.
// CONTEXT: Opened when a user clicks "Edit Script" on any object or from the
//          Developer > Object Scripts menu. Provides IntelliSense, scaffold templates,
//          and a documentation sidebar.

import React, { useState, useCallback, useRef, useEffect } from "react";
import Editor, { type OnMount, loader } from "@monaco-editor/react";
import type { editor as monacoEditor } from "monaco-editor";
import * as monaco from "monaco-editor";
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Monaco 0.52+ moved typescript to top-level; languages.typescript still works at runtime
const monacoTs = (monaco.languages as any).typescript;
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
// Vite ?raw import: loads .d.ts as a plain string for Monaco type registration
import objectContextsDts from "../objectContexts.d.ts?raw";

import {
  ObjectScriptManager,
  saveObjectScript,
  getScaffoldTemplate,
  getContextDocumentation,
  showToast,
} from "@api";
import { onAppEvent } from "@api/events";
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
import { clearBreakpoints, shiftBreakpoints } from "../lib/debugger";
import {
  breakpointShift,
  DebugPanel,
  DebugToolbar,
  injectDebugStyles,
  useDebugSession,
  type DebugDecoration,
} from "./DebugPanel";
import type { ObjectScriptDefinition, ScriptableObjectType, ScriptAccessLevel } from "@api/scriptableObjects";
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

// ============================================================================
// Monaco Worker Setup
// ============================================================================

const prevGetWorker = self.MonacoEnvironment?.getWorker;
self.MonacoEnvironment = {
  getWorker(_: string, label: string) {
    if (label === "typescript" || label === "javascript") {
      return new tsWorker();
    }
    if (prevGetWorker) {
      return prevGetWorker(_, label);
    }
    return new editorWorker();
  },
};

loader.config({ monaco });

// Inject CSS for breakpoint glyph markers + window styling
(function injectEditorStyles() {
  const id = "code-editor-dialog-styles";
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

    .ose-toolbar-btn {
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
    .ose-toolbar-btn:hover {
      background: rgba(255,255,255,0.08);
      color: #fff;
    }
    .ose-toolbar-btn:active {
      background: rgba(255,255,255,0.12);
    }
    .ose-toolbar-btn[disabled] {
      opacity: 0.4;
      cursor: default;
      pointer-events: none;
    }
    .ose-toolbar-btn.primary {
      background: #0078D4;
      color: #fff;
      border-color: #0078D4;
    }
    .ose-toolbar-btn.primary:hover {
      background: #106EBE;
      border-color: #106EBE;
    }
    .ose-toolbar-btn.primary[disabled] {
      background: #0078D4;
      opacity: 0.4;
    }
    .ose-toolbar-btn.danger {
      color: #F48771;
    }
    .ose-toolbar-btn.danger:hover {
      background: rgba(244,135,113,0.12);
      color: #F48771;
    }

    .ose-toolbar-select {
      padding: 4px 8px;
      font-size: 11px;
      font-family: 'Segoe UI', Tahoma, sans-serif;
      border: 1px solid #444;
      border-radius: 3px;
      background: #2D2D2D;
      color: #ccc;
      cursor: pointer;
      outline: none;
      transition: border-color 0.15s;
      max-width: 220px;
    }
    .ose-toolbar-select:hover {
      border-color: #0078D4;
    }
    .ose-toolbar-select:focus {
      border-color: #0078D4;
      box-shadow: 0 0 0 1px rgba(0,120,212,0.3);
    }

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
    .ose-sidebar-method:hover {
      background: rgba(79,193,255,0.1);
    }

    .ose-resize-handle {
      position: absolute;
      z-index: 10;
    }
    .ose-resize-n, .ose-resize-s { height: 5px; left: 8px; right: 8px; cursor: ns-resize; }
    .ose-resize-e, .ose-resize-w { width: 5px; top: 8px; bottom: 8px; cursor: ew-resize; }
    .ose-resize-n { top: -2px; }
    .ose-resize-s { bottom: -2px; }
    .ose-resize-e { right: -2px; }
    .ose-resize-w { left: -2px; }
    .ose-resize-ne, .ose-resize-nw, .ose-resize-se, .ose-resize-sw {
      width: 10px; height: 10px;
    }
    .ose-resize-ne { top: -2px; right: -2px; cursor: nesw-resize; }
    .ose-resize-nw { top: -2px; left: -2px; cursor: nwse-resize; }
    .ose-resize-se { bottom: -2px; right: -2px; cursor: nwse-resize; }
    .ose-resize-sw { bottom: -2px; left: -2px; cursor: nesw-resize; }

    .ose-win-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 24px;
      border: none;
      background: transparent;
      color: #999;
      cursor: pointer;
      font-size: 14px;
      transition: background 0.1s, color 0.1s;
    }
    .ose-win-btn:hover {
      background: rgba(255,255,255,0.08);
      color: #fff;
    }
    .ose-win-btn.close:hover {
      background: #E81123;
      color: #fff;
    }

    .ose-console-line {
      margin-bottom: 1px;
      white-space: pre-wrap;
      word-break: break-all;
    }

    .ose-splitter {
      height: 4px;
      cursor: ns-resize;
      background: #252526;
      border-top: 1px solid #333;
      flex-shrink: 0;
      transition: background 0.15s;
    }
    .ose-splitter:hover {
      background: #0078D4;
    }
  `;
  document.head.appendChild(style);
})();

// Register the GENERATED type definitions on both language services. The
// per-script `ObjectScriptContext` alias is published separately, whenever the
// edited script changes (see the effect in the component below) — without it
// the interfaces are unreachable, because a script's context is a parameter of
// `setup(context)` and nothing binds it.
configureObjectScriptTypings(monacoTs, objectContextsDts);
// ...and claim the object-script share of the shared language services, so the
// merged configuration (not whichever extension was imported last) is what is
// live. Without this, CustomFunctions' fragment settings switched validation
// off for this editor too and the generated typings produced completions but
// never a single diagnostic.
registerJavascriptLane(monacoTs, objectContextsDts);

// ============================================================================
// Drag & Resize Hook
// ============================================================================

interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function useWindowDragResize(initialRect: WindowRect) {
  const [rect, setRect] = useState<WindowRect>(initialRect);
  const [isMaximized, setIsMaximized] = useState(false);
  const preMaxRef = useRef<WindowRect>(initialRect);
  const dragRef = useRef<{ startX: number; startY: number; startRect: WindowRect } | null>(null);
  const resizeRef = useRef<{ startX: number; startY: number; startRect: WindowRect; edges: string } | null>(null);

  const onTitleBarMouseDown = useCallback((e: React.MouseEvent) => {
    if (isMaximized) return;
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startY: e.clientY, startRect: { ...rect } };

    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const dx = ev.clientX - dragRef.current.startX;
      const dy = ev.clientY - dragRef.current.startY;
      setRect({
        ...dragRef.current.startRect,
        x: dragRef.current.startRect.x + dx,
        y: Math.max(0, dragRef.current.startRect.y + dy),
      });
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [rect, isMaximized]);

  const onResizeMouseDown = useCallback((edges: string, e: React.MouseEvent) => {
    if (isMaximized) return;
    e.preventDefault();
    e.stopPropagation();
    resizeRef.current = { startX: e.clientX, startY: e.clientY, startRect: { ...rect }, edges };

    const onMove = (ev: MouseEvent) => {
      if (!resizeRef.current) return;
      const { startX, startY, startRect, edges: ed } = resizeRef.current;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      const minW = 520;
      const minH = 360;
      let { x, y, width, height } = startRect;

      if (ed.includes("e")) width = Math.max(minW, startRect.width + dx);
      if (ed.includes("w")) {
        const newW = Math.max(minW, startRect.width - dx);
        x = startRect.x + (startRect.width - newW);
        width = newW;
      }
      if (ed.includes("s")) height = Math.max(minH, startRect.height + dy);
      if (ed.includes("n")) {
        const newH = Math.max(minH, startRect.height - dy);
        y = Math.max(0, startRect.y + (startRect.height - newH));
        height = newH;
      }
      setRect({ x, y, width, height });
    };
    const onUp = () => {
      resizeRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [rect, isMaximized]);

  const toggleMaximize = useCallback(() => {
    if (isMaximized) {
      setRect(preMaxRef.current);
      setIsMaximized(false);
    } else {
      preMaxRef.current = { ...rect };
      setRect({ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight });
      setIsMaximized(true);
    }
  }, [isMaximized, rect]);

  return { rect, isMaximized, onTitleBarMouseDown, onResizeMouseDown, toggleMaximize };
}

// Console entry type
interface ConsoleEntry {
  id: number;
  level: "log" | "warn" | "error" | "info";
  message: string;
  scriptId?: string;
  timestamp: number;
}

// ============================================================================
// Component
// ============================================================================

import type { DialogProps } from "@api/uiTypes";

// SVG icons as small inline components
function IconPlay() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
      <path d="M4 2l10 6-10 6V2z" />
    </svg>
  );
}

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

export default function CodeEditorDialog({ onClose, data }: DialogProps): React.ReactElement {
  const initScriptId = data?.scriptId as string | undefined;
  const editorRef = useRef<monacoEditor.IStandaloneCodeEditor | null>(null);

  // Window drag/resize
  const initWidth = Math.min(1100, window.innerWidth - 80);
  const initHeight = Math.min(720, window.innerHeight - 60);
  const { rect, isMaximized, onTitleBarMouseDown, onResizeMouseDown, toggleMaximize } =
    useWindowDragResize({
      x: Math.round((window.innerWidth - initWidth) / 2),
      y: Math.round((window.innerHeight - initHeight) / 2),
      width: initWidth,
      height: initHeight,
    });

  // Script list and current script
  const [scripts, setScripts] = useState<ObjectScriptDefinition[]>([]);
  const [activeScriptId, setActiveScriptId] = useState<string | null>(initScriptId ?? null);
  const [source, setSource] = useState("");
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

  // Listen for console output and errors from object scripts
  useEffect(() => {
    const unsubConsole = onAppEvent("objectscript:console", (detail) => {
      const d = detail as { scriptId: string; level: string; args: unknown[] };
      const message = d.args.map((a) => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
      setConsoleEntries((prev) => [
        ...prev,
        {
          id: ++consoleIdRef.current,
          level: (d.level as ConsoleEntry["level"]) || "log",
          message,
          scriptId: d.scriptId,
          timestamp: Date.now(),
        },
      ]);
    });

    const unsubError = onAppEvent("objectscript:error", (detail) => {
      const d = detail as { scriptId: string; scriptName: string; error: string; stack?: string };
      const message = `[${d.scriptName}] Error: ${d.error}${d.stack ? "\n" + d.stack : ""}`;
      setConsoleEntries((prev) => [
        ...prev,
        {
          id: ++consoleIdRef.current,
          level: "error",
          message,
          scriptId: d.scriptId,
          timestamp: Date.now(),
        },
      ]);
      // Auto-show console on error
      setShowConsole(true);
    });

    return () => { unsubConsole(); unsubError(); };
  }, []);

  // Auto-scroll console to bottom
  useEffect(() => {
    consoleEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [consoleEntries]);

  // Load scripts
  useEffect(() => {
    const allScripts = ObjectScriptManager.getAllScripts();
    setScripts(allScripts);

    if (initScriptId) {
      const script = allScripts.find((s) => s.id === initScriptId);
      if (script) {
        setSource(script.source);
        setActiveScriptId(script.id);
      }
    } else if (allScripts.length > 0) {
      setSource(allScripts[0].source);
      setActiveScriptId(allScripts[0].id);
    }

    const unsub = ObjectScriptManager.onScriptChange(() => {
      setScripts(ObjectScriptManager.getAllScripts());
    });
    return unsub;
  }, [initScriptId]);

  const activeScript = scripts.find((s) => s.id === activeScriptId) ?? null;
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
  const reportToConsole = useCallback((message: string, scriptId?: string) => {
    setConsoleEntries((prev) => [
      ...prev,
      {
        id: ++consoleIdRef.current,
        level: "error",
        message,
        scriptId,
        timestamp: Date.now(),
      },
    ]);
    setShowConsole(true);
  }, []);

  // Switch active script
  const handleSelectScript = useCallback(async (scriptId: string) => {
    // Auto-save current. The same gate as the Save button: an auto-save is
    // still a save, and un-runnable text must never reach the store just
    // because the author clicked another script in the list.
    if (isDirty && activeScript) {
      const gate = await gateObjectScriptSave(source, activeScript.name, hostValidateScript);
      if (!gate.ok) {
        reportToConsole(gate.detail, activeScript.id);
        showToast(`${gate.message} Staying on "${activeScript.name}".`, { type: "error" });
        return;
      }
      const updated = { ...activeScript, source: gate.javascript };
      ObjectScriptManager.registerScript(updated);
      saveObjectScript(updated).catch(console.error);
    }

    const script = scripts.find((s) => s.id === scriptId);
    if (script) {
      setActiveScriptId(scriptId);
      setSource(script.source);
      setLanguage("javascript");
      setIsDirty(false);
    }
  }, [isDirty, activeScript, source, scripts, reportToConsole]);

  // Save
  const handleSave = useCallback(async () => {
    if (!activeScript) return;

    // THE GATE. Compile (TypeScript in, JavaScript out; JavaScript passes
    // through byte for byte) and parse the result in a scratch worker —
    // nothing user-authored executes. A failure here BLOCKS the save: the
    // store feeds the runtime, the source hash behind every capability grant,
    // the transparency panel and .calp distribution, so it must never hold
    // text that cannot run.
    const gate = await gateObjectScriptSave(source, activeScript.name, hostValidateScript);
    if (!gate.ok) {
      reportToConsole(gate.detail, activeScript.id);
      showToast(gate.message, { type: "error" });
      return;
    }

    // From here on, ONE artifact: the JavaScript that will run.
    const storedSource = gate.javascript;
    const updated = { ...activeScript, source: storedSource };
    ObjectScriptManager.registerScript(updated);

    // Remount to apply. Debug instrumentation is NOT baked into what we store
    // or mount here: the host applies it inside the worker, only for a script
    // the user opened a session on, and re-applies it on this very remount — so
    // Save & Apply keeps you in the debugger without the stored source ever
    // differing from the source that runs.
    if (ObjectScriptManager.isScriptMounted(updated.id)) {
      ObjectScriptManager.unmountScript(updated.id);
    }
    await ObjectScriptManager.mountScript(updated.id);

    try {
      await saveObjectScript(updated);
      setIsDirty(false);
      if (gate.transformed) {
        // Show the author exactly what was stored. The alternative — keeping
        // the TypeScript on screen while the store holds something else —
        // would put the editor out of step with the text that runs, is
        // hashed for consent and is shown to whoever reviews this workbook.
        setSource(storedSource);
        setLanguage("javascript");
        showToast("TypeScript compiled. The stored script is the JavaScript now shown.", { type: "success" });
      } else {
        showToast("Script saved and applied.", { type: "success" });
      }
    } catch (e) {
      showToast(`Failed to save: ${e}`, { type: "error" });
    }
  }, [activeScript, source, reportToConsole]);

  // Toggle access level
  const handleToggleAccess = useCallback(() => {
    if (!activeScript) return;
    const newLevel: ScriptAccessLevel = activeScript.accessLevel === "restricted" ? "unlocked" : "restricted";
    const updated = { ...activeScript, accessLevel: newLevel };
    ObjectScriptManager.registerScript(updated);
    setScripts(ObjectScriptManager.getAllScripts());
    saveObjectScript(updated).catch(console.error);
  }, [activeScript]);

  // Add new primitive script
  const handleAddScript = useCallback((objectType: ScriptableObjectType) => {
    const existing = ObjectScriptManager.getScript(objectType, null);
    if (existing) {
      setActiveScriptId(existing.id);
      setSource(existing.source);
      setLanguage("javascript");
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
    ObjectScriptManager.registerScript(script);
    saveObjectScript(script).catch(console.error);
    setActiveScriptId(id);
    setSource(script.source);
    setLanguage("javascript");
    setIsDirty(false);
  }, []);

  // ---- Debugging (task H1) -------------------------------------------------
  // The session lives in the host; this is a view of it plus the gutter.
  const debug = useDebugSession(activeScriptId ?? null);
  const debugRef = useRef(debug);
  debugRef.current = debug;
  const activeScriptIdRef = useRef<string | null>(activeScriptId ?? null);
  activeScriptIdRef.current = activeScriptId ?? null;
  const debugDecorationsRef = useRef<string[]>([]);
  const breakpointLines = debug.breakpointLines;

  useEffect(() => {
    injectDebugStyles();
  }, []);

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

  // Re-paint the gutter whenever breakpoints or the session state change.
  useEffect(() => {
    const ed = editorRef.current;
    if (ed) applyDebugDecorations(ed, debug.decorations);
  }, [debug.decorations, applyDebugDecorations]);

  // Bring the paused statement into view — a debugger that stops off-screen
  // is indistinguishable from one that did not stop.
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
      id: "objectScript.debug.continue",
      label: "Debug: Continue",
      keybindings: [monaco.KeyCode.F5],
      run: () => debugRef.current.send("continue"),
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

    // Toggle breakpoints on gutter click
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
  }, [handleSave, applyDebugDecorations]);

  // Source change
  const handleChange = useCallback((val: string | undefined) => {
    if (val !== undefined) {
      setSource(val);
      setIsDirty(true);
    }
  }, []);

  // Insert method name into editor
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

  // Save current script as template
  const handleSaveAsTemplate = useCallback(async () => {
    if (!activeScript) return;
    const name = prompt("Template name:", `${activeScript.name} Template`);
    if (!name) return;

    // A template is stamped straight into a new script, so it is subject to the
    // same rule: only JavaScript that compiles may be stored.
    const gate = await gateObjectScriptSave(source, activeScript.name, hostValidateScript);
    if (!gate.ok) {
      reportToConsole(gate.detail, activeScript.id);
      showToast(`Template not saved: ${gate.message}`, { type: "error" });
      return;
    }

    const template = createTemplateFromScript(
      { ...activeScript, source: gate.javascript },
      name,
    );
    await saveTemplate(template);
    setTemplates(await listTemplates());
    showToast(`Saved template "${name}"`, { type: "success" });
  }, [activeScript, source, reportToConsole]);

  // Create script from template
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
      showToast(`Template "${template.name}" does not compile — nothing was created.`, { type: "error" });
      return;
    }
    const created = { ...stamped, source: gate.javascript };
    ObjectScriptManager.registerScript(created);
    await saveObjectScript(created);
    setActiveScriptId(created.id);
    setSource(created.source);
    setLanguage("javascript");
    setIsDirty(false);
    showToast(`Created from template "${template.name}"`, { type: "success" });
  }, [activeScript, reportToConsole]);

  // Delete template
  const handleDeleteTemplate = useCallback(async (templateId: string) => {
    await deleteTemplate(templateId);
    setTemplates(await listTemplates());
    showToast("Template deleted", { type: "info" });
  }, []);

  const primitiveTypes: ScriptableObjectType[] = ["workbook", "sheet", "cell", "row", "column"];

  const errorCount = consoleEntries.filter((e) => e.level === "error").length;

  // Title bar double-click to maximize/restore
  const handleTitleBarDoubleClick = useCallback(() => {
    toggleMaximize();
  }, [toggleMaximize]);

  return (
    <div style={{
      position: "fixed",
      top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: "rgba(0,0,0,0.45)",
      zIndex: 9000,
    }}>
      {/* Window */}
      <div style={{
        position: "absolute",
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
        display: "flex",
        flexDirection: "column",
        fontFamily: "'Segoe UI', Tahoma, sans-serif",
        fontSize: 12,
        backgroundColor: "#1E1E1E",
        borderRadius: isMaximized ? 0 : 6,
        overflow: "hidden",
        boxShadow: isMaximized ? "none" : "0 12px 48px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.06)",
      }}>

        {/* Resize handles */}
        {!isMaximized && (
          <>
            <div className="ose-resize-handle ose-resize-n" onMouseDown={(e) => onResizeMouseDown("n", e)} />
            <div className="ose-resize-handle ose-resize-s" onMouseDown={(e) => onResizeMouseDown("s", e)} />
            <div className="ose-resize-handle ose-resize-e" onMouseDown={(e) => onResizeMouseDown("e", e)} />
            <div className="ose-resize-handle ose-resize-w" onMouseDown={(e) => onResizeMouseDown("w", e)} />
            <div className="ose-resize-handle ose-resize-ne" onMouseDown={(e) => onResizeMouseDown("ne", e)} />
            <div className="ose-resize-handle ose-resize-nw" onMouseDown={(e) => onResizeMouseDown("nw", e)} />
            <div className="ose-resize-handle ose-resize-se" onMouseDown={(e) => onResizeMouseDown("se", e)} />
            <div className="ose-resize-handle ose-resize-sw" onMouseDown={(e) => onResizeMouseDown("sw", e)} />
          </>
        )}

        {/* Title bar */}
        <div
          onMouseDown={onTitleBarMouseDown}
          onDoubleClick={handleTitleBarDoubleClick}
          style={{
            display: "flex",
            alignItems: "center",
            height: 30,
            backgroundColor: "#2D2D2D",
            borderBottom: "1px solid #3C3C3C",
            flexShrink: 0,
            userSelect: "none",
            cursor: isMaximized ? "default" : "move",
          }}
        >
          {/* Icon + title */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, paddingLeft: 10, color: "#aaa", fontSize: 12 }}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="#569CD6">
              <path d="M1 2.5A1.5 1.5 0 012.5 1h11A1.5 1.5 0 0115 2.5v11a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 13.5v-11zM3 4v2h4V4H3zm0 3v2h4V7H3zm0 3v2h4v-2H3zm5-6v2h5V4H8zm0 3v2h5V7H8zm0 3v2h5v-2H8z" />
            </svg>
            <span>Object Script Editor</span>
            {activeScript && (
              <span style={{ color: "#666", fontSize: 11, marginLeft: 4 }}>
                - {activeScript.name}
                {isDirty && <span style={{ color: "#E8AB53" }}> (modified)</span>}
              </span>
            )}
          </div>
          <div style={{ flex: 1 }} />
          {/* Window controls */}
          <button className="ose-win-btn" onClick={toggleMaximize} title={isMaximized ? "Restore" : "Maximize"}>
            {isMaximized ? "\u2752" : "\u25A1"}
          </button>
          <button className="ose-win-btn close" onClick={onClose} title="Close">
            \u2715
          </button>
        </div>

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
            className="ose-toolbar-select"
            value={activeScriptId ?? ""}
            onChange={(e) => { void handleSelectScript(e.target.value); }}
          >
            {scripts.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.objectType}{s.instanceId ? ` #${s.instanceId.slice(0, 8)}` : ""})
              </option>
            ))}
          </select>

          {/* Add script dropdown */}
          <select
            className="ose-toolbar-select"
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
              className="ose-toolbar-select"
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

          {activeScript && (
            <button className="ose-toolbar-btn" onClick={handleSaveAsTemplate} title="Save current script as a reusable template">
              <IconTemplate /> Template
            </button>
          )}

          <div style={{ flex: 1 }} />

          {/* Right side controls */}
          {activeScript && !isReadOnly && (
            <button
              className="ose-toolbar-btn"
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

          {activeScript && (
            <button className="ose-toolbar-btn" onClick={handleToggleAccess}
              title={`Access level: ${activeScript.accessLevel}. Click to toggle.`}>
              {activeScript.accessLevel === "restricted" ? <><IconLock /> Restricted</> : <><IconUnlock /> Unlocked</>}
            </button>
          )}

          {/* Separator */}
          <div style={{ width: 1, height: 18, backgroundColor: "#444", margin: "0 2px" }} />

          <button
            className="ose-toolbar-btn"
            onClick={() => setShowConsole(!showConsole)}
            style={errorCount > 0 && !showConsole ? { color: "#F48771" } : undefined}
          >
            <IconTerminal /> Console
            {errorCount > 0 && <span style={{
              background: "#D13438",
              color: "#fff",
              borderRadius: 8,
              padding: "0 5px",
              fontSize: 10,
              fontWeight: 600,
              marginLeft: 2,
            }}>{errorCount}</span>}
          </button>

          <button className="ose-toolbar-btn" onClick={() => setShowSidebar(!showSidebar)}>
            <IconBook /> Docs
          </button>

          {/* Separator */}
          <div style={{ width: 1, height: 18, backgroundColor: "#444", margin: "0 2px" }} />

          {/* Step debugging. Only for an APPLIED script: a session instruments
              the source at mount, so there has to be a mount. */}
          {activeScript && (
            <DebugToolbar
              state={debug}
              disabled={!activeScript || isDirty}
              buttonClassName="ose-toolbar-btn"
            />
          )}

          {activeScript && breakpointLines.length > 0 && !debug.session && (
            <button
              className="ose-toolbar-btn"
              onClick={() => activeScriptId && clearBreakpoints(activeScriptId)}
              title={`Remove ${breakpointLines.length} breakpoint(s) from this script`}
            >
              Clear {breakpointLines.length} BP
            </button>
          )}

          {/* Separator */}
          <div style={{ width: 1, height: 18, backgroundColor: "#444", margin: "0 2px" }} />

          <button
            className="ose-toolbar-btn primary"
            onClick={handleSave}
            disabled={!isDirty || isReadOnly}
            title={isReadOnly ? "Distributed scripts are read-only" : "Save and apply the script (Ctrl+S)"}
          >
            <IconSave />
            {isReadOnly ? "Read Only" : "Save & Apply"}
          </button>
        </div>

        {/* Main area: editor + sidebar */}
        <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
          {/* Editor + Console (vertical split) */}
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
            {/* Monaco Editor */}
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

            {/* Console splitter + panel */}
            {showConsole && (
              <>
                <div className="ose-splitter" onMouseDown={onConsoleSplitterMouseDown} />
                <div style={{
                  height: consoleHeight,
                  display: "flex",
                  flexDirection: "column",
                  flexShrink: 0,
                }}>
                  <div style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "3px 10px",
                    backgroundColor: "#252526",
                    borderBottom: "1px solid #333",
                    fontSize: 11,
                    color: "#999",
                    flexShrink: 0,
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
                    <button className="ose-toolbar-btn" style={{ padding: "1px 6px", fontSize: 10 }}
                      onClick={() => setConsoleEntries([])}>
                      Clear
                    </button>
                  </div>
                  <div style={{
                    flex: 1,
                    overflow: "auto",
                    padding: "6px 12px",
                    fontFamily: "'Cascadia Code', Consolas, monospace",
                    fontSize: 11,
                    lineHeight: "1.6",
                    backgroundColor: "#1E1E1E",
                    color: "#D4D4D4",
                  }}>
                    {consoleEntries.length === 0 && (
                      <div style={{ color: "#555", fontStyle: "italic" }}>
                        Script output will appear here...
                      </div>
                    )}
                    {consoleEntries.map((entry) => (
                      <div
                        key={entry.id}
                        className="ose-console-line"
                        style={
                          entry.level === "error" ? { color: "#F48771" }
                          : entry.level === "warn" ? { color: "#CCA700" }
                          : undefined
                        }
                      >
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

          {/* Documentation sidebar */}
          {showSidebar && (
            <div style={{
              width: 230,
              borderLeft: "1px solid #333",
              backgroundColor: "#252526",
              overflowY: "auto",
              padding: "10px 12px",
              fontSize: 11,
            }}>
              <div style={{
                fontWeight: 600,
                fontSize: 12,
                marginBottom: 8,
                color: "#ccc",
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}>
                <IconBook />
                API Reference
              </div>
              {activeScript && (
                <div style={{
                  fontSize: 10,
                  color: "#569CD6",
                  marginBottom: 12,
                  fontFamily: "'Cascadia Code', Consolas, monospace",
                  padding: "3px 6px",
                  background: "rgba(86,156,214,0.08)",
                  borderRadius: 3,
                  display: "inline-block",
                }}>
                  {activeScript.objectType.charAt(0).toUpperCase() + activeScript.objectType.slice(1)}Context
                </div>
              )}
              {docs.map((cat) => (
                <div key={cat.category}>
                  <div style={{
                    fontWeight: 600,
                    fontSize: 10,
                    color: "#888",
                    marginBottom: 4,
                    marginTop: 12,
                    textTransform: "uppercase",
                    letterSpacing: "0.5px",
                  }}>
                    {cat.category}
                  </div>
                  {cat.methods.map((m) => (
                    <div key={m.name}>
                      <div
                        className="ose-sidebar-method"
                        onClick={() => handleInsertMethod(m.name)}
                        title={`Click to insert "${m.name}" at cursor`}
                      >
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
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "3px 12px",
          borderTop: "1px solid #333",
          backgroundColor: "#007ACC",
          fontSize: 11,
          color: "#fff",
          flexShrink: 0,
          height: 22,
        }}>
          <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {activeScript
              ? <>
                  <span>{activeScript.objectType}</span>
                  <span style={{ opacity: 0.7 }}>|</span>
                  <span>{activeScript.accessLevel}</span>
                  {isReadOnly && (
                    <><span style={{ opacity: 0.7 }}>|</span><span>distributed (read-only)</span></>
                  )}
                  {activeScript.packageName && (
                    <><span style={{ opacity: 0.7 }}>|</span><span>from "{activeScript.packageName}"</span></>
                  )}
                </>
              : <span>No script selected</span>
            }
          </span>
          <span style={{ display: "flex", gap: 12, alignItems: "center" }}>
            {errorCount > 0 && (
              <span style={{ background: "rgba(255,255,255,0.15)", padding: "0 6px", borderRadius: 3 }}>
                {errorCount} error{errorCount !== 1 && "s"}
              </span>
            )}
            <span>{isDirty ? "Modified" : "Saved"}</span>
          </span>
        </div>
      </div>
    </div>
  );
}
