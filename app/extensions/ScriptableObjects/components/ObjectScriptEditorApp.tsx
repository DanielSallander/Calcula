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
  listTemplates,
  saveTemplate,
  createTemplateFromScript,
  stampFromTemplate,
  loadTemplate,
  deleteTemplate,
} from "../lib/templateManager";
import type { TemplateSummary } from "../lib/templateManager";
import { validateScript } from "../lib/scriptWorker";
import { getBreakpoints, toggleBreakpoint, instrumentSource } from "../lib/debugger";
import type { ObjectScriptDefinition, ScriptableObjectType, ScriptAccessLevel } from "@api/scriptableObjects";
import {
  emitSaveAndApply,
  emitRegisterScript,
  emitToggleAccess,
  emitEditorClosed,
  onOpenWithScript,
  onConsoleOutput,
  onScriptError,
  onScriptsChanged,
} from "../lib/crossWindowEvents";

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

// Register type definitions for IntelliSense
(function registerObjectScriptTypes() {
  monacoTs.javascriptDefaults.addExtraLib(
    objectContextsDts,
    "objectContexts.d.ts",
  );
  monacoTs.javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
  });
  monacoTs.javascriptDefaults.setCompilerOptions({
    target: monacoTs.ScriptTarget.ESNext,
    allowNonTsExtensions: true,
    allowJs: true,
    checkJs: true,
  });
})();

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

    // Open with specific script — set activeScriptId and reload scripts
    // from backend to ensure we have the latest (including newly created scripts).
    onOpenWithScript(async (payload) => {
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
    }
  }, [activeScriptId, scripts]);

  // Auto-scroll console
  useEffect(() => {
    consoleEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [consoleEntries]);

  const activeScript = scripts.find((s) => s.id === activeScriptId) ?? null;
  const isReadOnly = activeScript?.provenance === "distributed";
  const docs = activeScript ? getContextDocumentation(activeScript.objectType) : [];

  // Switch active script
  const handleSelectScript = useCallback((scriptId: string) => {
    // Auto-save current
    if (isDirty && activeScript) {
      const updated = { ...activeScript, source };
      saveObjectScript(updated).catch(console.error);
      emitRegisterScript(updated).catch(console.error);
    }
    setActiveScriptId(scriptId);
  }, [isDirty, activeScript, source]);

  // Save & Apply
  const handleSave = useCallback(async () => {
    if (!activeScript) return;

    // Validate script
    const validation = await validateScript(activeScript.id, source);
    if (!validation.valid) {
      setConsoleEntries((prev) => [
        ...prev,
        {
          id: ++consoleIdRef.current,
          level: "error",
          message: `Compilation error: ${validation.error}${validation.stack ? "\n" + validation.stack : ""}`,
          scriptId: activeScript.id,
          timestamp: Date.now(),
        },
      ]);
      setShowConsole(true);

      // Still save source so user doesn't lose edits
      const updated = { ...activeScript, source };
      try { await saveObjectScript(updated); } catch { /* ignore */ }
      setIsDirty(false);
      return;
    }

    // Save to backend
    const updated = { ...activeScript, source };
    try {
      await saveObjectScript(updated);

      // Instrument for breakpoints if needed
      const instrumentedSource = instrumentSource(activeScript.id, source);
      const execution = { ...updated, source: instrumentedSource };

      // Tell main window to register + remount
      await emitSaveAndApply(execution);

      setIsDirty(false);
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
  }, [activeScript, source]);

  // Toggle access level
  const handleToggleAccess = useCallback(() => {
    if (!activeScript) return;
    const newLevel: ScriptAccessLevel = activeScript.accessLevel === "restricted" ? "unlocked" : "restricted";
    const updated = { ...activeScript, accessLevel: newLevel };
    saveObjectScript(updated).catch(console.error);
    emitToggleAccess(updated).catch(console.error);
    setScripts((prev) => prev.map((s) => s.id === updated.id ? updated : s));
  }, [activeScript]);

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
      source: getScaffoldTemplate(objectType),
      accessLevel: "restricted",
    };
    await saveObjectScript(script);
    await emitRegisterScript(script);
    setScripts((prev) => [...prev, script]);
    setActiveScriptId(id);
    setSource(script.source);
    setIsDirty(false);
  }, [scripts]);

  // Breakpoint state
  const [breakpointLines, setBreakpointLines] = useState<number[]>([]);
  const breakpointDecorationsRef = useRef<string[]>([]);

  const updateBreakpointDecorations = useCallback((ed: monacoEditor.IStandaloneCodeEditor, lines: number[]) => {
    const decorations = lines.map((line) => ({
      range: new monaco.Range(line, 1, line, 1),
      options: {
        isWholeLine: true,
        glyphMarginClassName: "breakpoint-glyph",
        glyphMarginHoverMessage: { value: `Breakpoint at line ${line}` },
        linesDecorationsClassName: "breakpoint-line-decoration",
      },
    }));
    breakpointDecorationsRef.current = ed.deltaDecorations(
      breakpointDecorationsRef.current,
      decorations,
    );
  }, []);

  // Monaco mount
  const handleMount: OnMount = useCallback((ed) => {
    editorRef.current = ed;
    ed.addAction({
      id: "objectScript.save",
      label: "Save Script",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => handleSave(),
    });

    ed.onMouseDown((e) => {
      if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && activeScriptId) {
        const line = e.target.position?.lineNumber;
        if (line) {
          const bps = toggleBreakpoint(activeScriptId, line);
          const lines = bps.filter((bp) => bp.enabled).map((bp) => bp.line);
          setBreakpointLines(lines);
          updateBreakpointDecorations(ed, lines);
        }
      }
    });

    if (activeScriptId) {
      const bps = getBreakpoints(activeScriptId);
      const lines = bps.filter((bp) => bp.enabled).map((bp) => bp.line);
      setBreakpointLines(lines);
      updateBreakpointDecorations(ed, lines);
    }

    ed.focus();
  }, [handleSave, activeScriptId, updateBreakpointDecorations]);

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
    const template = createTemplateFromScript({ ...activeScript, source }, name);
    await saveTemplate(template);
    setTemplates(await listTemplates());
  }, [activeScript, source]);

  const handleNewFromTemplate = useCallback(async (templateId: string) => {
    const template = await loadTemplate(templateId);
    if (!template) return;
    const instanceId = activeScript?.instanceId || null;
    const stamped = stampFromTemplate(template, instanceId || crypto.randomUUID());
    await saveObjectScript(stamped);
    await emitRegisterScript(stamped);
    setScripts((prev) => [...prev, stamped]);
    setActiveScriptId(stamped.id);
    setSource(stamped.source);
    setIsDirty(false);
  }, [activeScript]);

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
          onChange={(e) => handleSelectScript(e.target.value)}
        >
          {scripts.length === 0 && <option value="">No scripts</option>}
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

        {activeScript && (
          <button className="ose-btn" onClick={handleSaveAsTemplate} title="Save as reusable template">
            <IconTemplate /> Template
          </button>
        )}

        <div style={{ flex: 1 }} />

        {/* Right side */}
        {activeScript && (
          <button className="ose-btn" onClick={handleToggleAccess}
            title={`Access level: ${activeScript.accessLevel}. Click to toggle.`}>
            {activeScript.accessLevel === "restricted" ? <><IconLock /> Restricted</> : <><IconUnlock /> Unlocked</>}
          </button>
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

        <button className="ose-btn primary" onClick={handleSave}
          disabled={!isDirty || isReadOnly}
          title={isReadOnly ? "Distributed scripts are read-only" : "Save and apply (Ctrl+S)"}>
          <IconSave />
          {isReadOnly ? "Read Only" : "Save & Apply"}
        </button>
      </div>

      {/* Main area */}
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {/* Editor + Console */}
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          <div style={{ flex: 1, minHeight: 0 }}>
            <Editor
              height="100%"
              language="javascript"
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
          <span>{isDirty ? "Modified" : "Saved"}</span>
        </span>
      </div>
    </div>
  );
}
