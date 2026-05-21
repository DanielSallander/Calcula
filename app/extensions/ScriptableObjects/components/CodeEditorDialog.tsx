//! FILENAME: app/extensions/ScriptableObjects/components/CodeEditorDialog.tsx
// PURPOSE: Monaco-based code editor dialog for editing object scripts.
// CONTEXT: Opened when a user clicks "Edit Script" on any object or from the
//          Developer > Object Scripts menu. Provides IntelliSense, scaffold templates,
//          and a documentation sidebar.

import React, { useState, useCallback, useRef, useEffect } from "react";
import Editor, { type OnMount, loader } from "@monaco-editor/react";
import type { editor as monacoEditor } from "monaco-editor";
import * as monaco from "monaco-editor";
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
import { validateScript } from "../lib/scriptWorker";
import { getBreakpoints, toggleBreakpoint, clearBreakpoints, instrumentSource } from "../lib/debugger";
import type { ObjectScriptDefinition, ScriptableObjectType, ScriptAccessLevel } from "@api/scriptableObjects";

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

// Inject CSS for breakpoint glyph markers
(function injectBreakpointStyles() {
  const style = document.createElement("style");
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
  `;
  document.head.appendChild(style);
})();

// Register object context type definitions for IntelliSense
(function registerObjectScriptTypes() {
  monaco.languages.typescript.javascriptDefaults.addExtraLib(
    objectContextsDts,
    "objectContexts.d.ts",
  );

  monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
  });

  monaco.languages.typescript.javascriptDefaults.setCompilerOptions({
    target: monaco.languages.typescript.ScriptTarget.ESNext,
    allowNonTsExtensions: true,
    allowJs: true,
    checkJs: true,
  });
})();

// ============================================================================
// Styles
// ============================================================================

const dialogStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  fontFamily: "'Segoe UI', Tahoma, sans-serif",
  fontSize: 12,
  backgroundColor: "#FAFAFA",
};

const toolbarStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 12px",
  borderBottom: "1px solid #E0E0E0",
  backgroundColor: "#FFF",
  flexShrink: 0,
};

const mainStyle: React.CSSProperties = {
  display: "flex",
  flex: 1,
  minHeight: 0,
};

const editorPaneStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
};

const sidebarStyle: React.CSSProperties = {
  width: 220,
  borderLeft: "1px solid #E0E0E0",
  backgroundColor: "#FFF",
  overflowY: "auto",
  padding: "8px 10px",
  fontSize: 11,
};

const sidebarHeaderStyle: React.CSSProperties = {
  fontWeight: 600,
  fontSize: 11,
  color: "#333",
  marginBottom: 6,
  marginTop: 10,
};

const sidebarItemStyle: React.CSSProperties = {
  fontFamily: "'Cascadia Code', Consolas, monospace",
  fontSize: 10,
  color: "#0066CC",
  marginBottom: 2,
  cursor: "pointer",
};

const sidebarDescStyle: React.CSSProperties = {
  fontSize: 10,
  color: "#777",
  marginBottom: 6,
  marginLeft: 8,
};

const statusBarStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "4px 12px",
  borderTop: "1px solid #E0E0E0",
  backgroundColor: "#F5F5F5",
  fontSize: 11,
  color: "#666",
  flexShrink: 0,
};

const btnStyle: React.CSSProperties = {
  padding: "4px 12px",
  fontSize: 11,
  border: "1px solid #CCC",
  borderRadius: 3,
  backgroundColor: "#FFF",
  cursor: "pointer",
};

const btnPrimaryStyle: React.CSSProperties = {
  ...btnStyle,
  backgroundColor: "#0078D4",
  color: "#FFF",
  borderColor: "#0078D4",
};

const selectStyle: React.CSSProperties = {
  padding: "3px 8px",
  fontSize: 11,
  border: "1px solid #CCC",
  borderRadius: 3,
  backgroundColor: "#FFF",
};

// Console styles
const consolePanelStyle: React.CSSProperties = {
  height: 150,
  minHeight: 60,
  display: "flex",
  flexDirection: "column",
  borderTop: "1px solid #E0E0E0",
  flexShrink: 0,
};

const consoleHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "3px 10px",
  backgroundColor: "#F5F5F5",
  borderBottom: "1px solid #E8E8E8",
  fontSize: 11,
  color: "#666",
  flexShrink: 0,
};

const consoleOutputStyle: React.CSSProperties = {
  flex: 1,
  overflow: "auto",
  padding: "4px 10px",
  fontFamily: "'Cascadia Code', Consolas, monospace",
  fontSize: 11,
  lineHeight: "1.5",
  backgroundColor: "#1E1E1E",
  color: "#D4D4D4",
};

const consoleEntryStyle: React.CSSProperties = {
  marginBottom: 1,
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
};

const consoleErrorStyle: React.CSSProperties = {
  ...consoleEntryStyle,
  color: "#F48771",
};

const consoleWarnStyle: React.CSSProperties = {
  ...consoleEntryStyle,
  color: "#CCA700",
};

const consoleClearBtnStyle: React.CSSProperties = {
  padding: "1px 6px",
  fontSize: 10,
  border: "1px solid #CCC",
  borderRadius: 2,
  backgroundColor: "transparent",
  color: "#666",
  cursor: "pointer",
};

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

interface CodeEditorDialogProps {
  data?: {
    scriptId?: string;
    objectType?: ScriptableObjectType;
    instanceId?: string | null;
  };
}

export default function CodeEditorDialog({ data }: CodeEditorDialogProps): React.ReactElement {
  const editorRef = useRef<monacoEditor.IStandaloneCodeEditor | null>(null);

  // Script list and current script
  const [scripts, setScripts] = useState<ObjectScriptDefinition[]>([]);
  const [activeScriptId, setActiveScriptId] = useState<string | null>(data?.scriptId ?? null);
  const [source, setSource] = useState("");
  const [isDirty, setIsDirty] = useState(false);
  const [showSidebar, setShowSidebar] = useState(true);
  const [showConsole, setShowConsole] = useState(true);
  const [consoleEntries, setConsoleEntries] = useState<ConsoleEntry[]>([]);
  const consoleEndRef = useRef<HTMLDivElement>(null);
  const consoleIdRef = useRef(0);

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

    if (data?.scriptId) {
      const script = allScripts.find((s) => s.id === data.scriptId);
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
  }, [data?.scriptId]);

  const activeScript = scripts.find((s) => s.id === activeScriptId) ?? null;
  const isReadOnly = activeScript?.provenance === "distributed";
  const docs = activeScript ? getContextDocumentation(activeScript.objectType) : [];

  // Switch active script
  const handleSelectScript = useCallback((scriptId: string) => {
    // Auto-save current
    if (isDirty && activeScript) {
      const updated = { ...activeScript, source };
      ObjectScriptManager.registerScript(updated);
      saveObjectScript(updated).catch(console.error);
    }

    const script = scripts.find((s) => s.id === scriptId);
    if (script) {
      setActiveScriptId(scriptId);
      setSource(script.source);
      setIsDirty(false);
    }
  }, [isDirty, activeScript, source, scripts]);

  // Save
  const handleSave = useCallback(async () => {
    if (!activeScript) return;

    // Validate script in Web Worker before mounting
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
      showToast("Script has errors. Check the console.", { type: "error" });
      // Still save the source (so user doesn't lose edits)
      const updated = { ...activeScript, source };
      ObjectScriptManager.registerScript(updated);
      try { await saveObjectScript(updated); } catch { /* ignore */ }
      setIsDirty(false);
      return;
    }

    // Save the original source
    const updated = { ...activeScript, source };
    ObjectScriptManager.registerScript(updated);

    // If breakpoints are set, instrument the source for execution
    const instrumentedSource = instrumentSource(activeScript.id, source);
    const execution = { ...updated, source: instrumentedSource };

    // Remount script to apply changes (using instrumented source if breakpoints exist)
    if (ObjectScriptManager.isScriptMounted(updated.id)) {
      ObjectScriptManager.unmountScript(updated.id);
    }
    // Temporarily register with instrumented source for mounting, then restore original
    ObjectScriptManager.registerScript(execution);
    await ObjectScriptManager.mountScript(updated.id);
    ObjectScriptManager.registerScript(updated); // Restore original for persistence

    try {
      await saveObjectScript(updated);
      setIsDirty(false);
      showToast("Script saved and applied.", { type: "success" });
    } catch (e) {
      showToast(`Failed to save: ${e}`, { type: "error" });
    }
  }, [activeScript, source]);

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
    ObjectScriptManager.registerScript(script);
    saveObjectScript(script).catch(console.error);
    setActiveScriptId(id);
    setSource(script.source);
    setIsDirty(false);
  }, []);

  // Breakpoint state
  const [breakpointLines, setBreakpointLines] = useState<number[]>([]);
  const breakpointDecorationsRef = useRef<string[]>([]);

  // Update breakpoint decorations in the editor
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

    // Toggle breakpoints on gutter click
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

    // Load existing breakpoints
    if (activeScriptId) {
      const bps = getBreakpoints(activeScriptId);
      const lines = bps.filter((bp) => bp.enabled).map((bp) => bp.line);
      setBreakpointLines(lines);
      updateBreakpointDecorations(ed, lines);
    }
  }, [handleSave, activeScriptId, updateBreakpointDecorations]);

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

    const template = createTemplateFromScript(
      { ...activeScript, source },
      name,
    );
    await saveTemplate(template);
    setTemplates(await listTemplates());
    showToast(`Saved template "${name}"`, { type: "success" });
  }, [activeScript, source]);

  // Create script from template
  const handleNewFromTemplate = useCallback(async (templateId: string) => {
    const template = await loadTemplate(templateId);
    if (!template) return;

    const instanceId = activeScript?.instanceId || null;
    const stamped = stampFromTemplate(template, instanceId || crypto.randomUUID());
    ObjectScriptManager.registerScript(stamped);
    await saveObjectScript(stamped);
    setActiveScriptId(stamped.id);
    setSource(stamped.source);
    setIsDirty(false);
    showToast(`Created from template "${template.name}"`, { type: "success" });
  }, [activeScript]);

  // Delete template
  const handleDeleteTemplate = useCallback(async (templateId: string) => {
    await deleteTemplate(templateId);
    setTemplates(await listTemplates());
    showToast("Template deleted", { type: "info" });
  }, []);

  const primitiveTypes: ScriptableObjectType[] = ["workbook", "sheet", "cell", "row", "column"];

  return (
    <div style={dialogStyle}>
      {/* Toolbar */}
      <div style={toolbarStyle}>
        <select
          style={selectStyle}
          value={activeScriptId ?? ""}
          onChange={(e) => handleSelectScript(e.target.value)}
        >
          {scripts.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.objectType}{s.instanceId ? ` #${s.instanceId.slice(0, 8)}` : ""})
            </option>
          ))}
        </select>

        {/* Add primitive script dropdown */}
        <select
          style={selectStyle}
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

        <div style={{ flex: 1 }} />

        {/* Template controls */}
        {templates.length > 0 && (
          <select
            style={selectStyle}
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
          <button
            style={btnStyle}
            onClick={handleSaveAsTemplate}
            title="Save current script as a reusable template"
          >
            Save as Template
          </button>
        )}

        {activeScript && (
          <button
            style={btnStyle}
            onClick={handleToggleAccess}
            title={`Access level: ${activeScript.accessLevel}. Click to toggle.`}
          >
            {activeScript.accessLevel === "restricted" ? "Restricted" : "Unlocked"}
          </button>
        )}

        <button
          style={{
            ...btnStyle,
            ...(consoleEntries.some((e) => e.level === "error") ? { color: "#D13438", borderColor: "#D13438" } : {}),
          }}
          onClick={() => setShowConsole(!showConsole)}
        >
          {showConsole ? "Hide Console" : "Show Console"}
          {!showConsole && consoleEntries.some((e) => e.level === "error") && " (!)"}
        </button>

        <button
          style={btnStyle}
          onClick={() => setShowSidebar(!showSidebar)}
        >
          {showSidebar ? "Hide Docs" : "Show Docs"}
        </button>

        <button
          style={btnPrimaryStyle}
          onClick={handleSave}
          disabled={!isDirty || isReadOnly}
          title={isReadOnly ? "Distributed scripts are read-only" : "Save and apply the script"}
        >
          {isReadOnly ? "Read Only" : "Save & Apply"}
        </button>
      </div>

      {/* Main area: editor + sidebar */}
      <div style={mainStyle}>
        {/* Editor + Console (vertical split) */}
        <div style={editorPaneStyle}>
          {/* Monaco Editor */}
          <div style={{ flex: 1, minHeight: 0 }}>
            <Editor
              height="100%"
              language="javascript"
              theme="vs"
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
              }}
            />
          </div>

          {/* Console Output Panel */}
          {showConsole && (
            <div style={consolePanelStyle}>
              <div style={consoleHeaderStyle}>
                <span>
                  Console
                  {consoleEntries.filter((e) => e.level === "error").length > 0 && (
                    <span style={{ color: "#D13438", marginLeft: 6 }}>
                      {consoleEntries.filter((e) => e.level === "error").length} error(s)
                    </span>
                  )}
                </span>
                <button
                  style={consoleClearBtnStyle}
                  onClick={() => setConsoleEntries([])}
                >
                  Clear
                </button>
              </div>
              <div style={consoleOutputStyle}>
                {consoleEntries.length === 0 && (
                  <div style={{ color: "#666", fontStyle: "italic" }}>
                    Script output will appear here...
                  </div>
                )}
                {consoleEntries.map((entry) => (
                  <div
                    key={entry.id}
                    style={
                      entry.level === "error" ? consoleErrorStyle
                      : entry.level === "warn" ? consoleWarnStyle
                      : consoleEntryStyle
                    }
                  >
                    <span style={{ color: "#666", marginRight: 6 }}>
                      {new Date(entry.timestamp).toLocaleTimeString()}
                    </span>
                    {entry.message}
                  </div>
                ))}
                <div ref={consoleEndRef} />
              </div>
            </div>
          )}
        </div>

        {/* Documentation sidebar */}
        {showSidebar && (
          <div style={sidebarStyle}>
            <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 8 }}>
              API Reference
            </div>
            {activeScript && (
              <div style={{ fontSize: 10, color: "#999", marginBottom: 10 }}>
                {activeScript.objectType.charAt(0).toUpperCase() + activeScript.objectType.slice(1)}Context
              </div>
            )}
            {docs.map((cat) => (
              <div key={cat.category}>
                <div style={sidebarHeaderStyle}>{cat.category}</div>
                {cat.methods.map((m) => (
                  <div key={m.name}>
                    <div
                      style={sidebarItemStyle}
                      onClick={() => handleInsertMethod(m.name)}
                      title={`Click to insert "${m.name}" at cursor`}
                    >
                      {m.signature}
                    </div>
                    <div style={sidebarDescStyle}>{m.description}</div>
                  </div>
                ))}
              </div>
            ))}
            {docs.length === 0 && (
              <div style={{ color: "#999", fontSize: 11, fontStyle: "italic" }}>
                No script selected
              </div>
            )}
          </div>
        )}
      </div>

      {/* Status bar */}
      <div style={statusBarStyle}>
        <span>
          {activeScript
            ? `${activeScript.objectType} | ${activeScript.accessLevel} mode${isReadOnly ? " | distributed (read-only)" : ""}${activeScript.packageName ? ` | from "${activeScript.packageName}"` : ""}`
            : "No script selected"
          }
        </span>
        <span style={{ display: "flex", gap: 12, alignItems: "center" }}>
          {consoleEntries.filter((e) => e.level === "error").length > 0 && (
            <span style={{ color: "#D13438" }}>
              {consoleEntries.filter((e) => e.level === "error").length} error(s)
            </span>
          )}
          <span>{isDirty ? "Modified" : "Saved"}</span>
        </span>
      </div>
    </div>
  );
}
