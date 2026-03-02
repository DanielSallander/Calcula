//! FILENAME: app/extensions/ScriptEditor/components/MonacoEditorApp.tsx
// PURPOSE: Root component for the Advanced Script Editor window.
// CONTEXT: Renders a Monaco editor with IntelliSense, console output, a Run button,
//          and a module navigation pane for managing multiple script modules.
//          This is mounted as a standalone React app in a separate Tauri window.

import React, { useState, useCallback, useRef, useEffect } from "react";
import Editor, { type OnMount, loader } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import { runScript, getScript, saveScript } from "../lib/scriptApi";
import type { RunScriptResponse } from "../types";
import {
  onOpenWithCode,
  emitGridNeedsRefresh,
  emitEditorClosed,
} from "../lib/crossWindowEvents";
import { useModuleStore } from "../lib/useModuleStore";
import { ModuleNavigationPane } from "./ModuleNavigationPane";
// Vite ?raw import: loads the .d.ts file content as a plain string
import calculaDts from "../calcula.d.ts?raw";

// ============================================================================
// Monaco Worker Setup (local, no CDN)
// ============================================================================

self.MonacoEnvironment = {
  getWorker(_: string, label: string) {
    if (label === "typescript" || label === "javascript") {
      return new tsWorker();
    }
    return new editorWorker();
  },
};

// Use the locally bundled monaco-editor module instead of CDN
loader.config({ monaco });

// ============================================================================
// Styles
// ============================================================================

const appContainerStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  width: "100%",
  height: "100%",
  backgroundColor: "#1E1E1E",
  color: "#CCCCCC",
  fontFamily: "'Segoe UI', Tahoma, sans-serif",
  fontSize: 13,
};

const toolbarStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "6px 12px",
  backgroundColor: "#252526",
  borderBottom: "1px solid #3C3C3C",
  flexShrink: 0,
};

const toolbarLeftStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
};

const toolbarRightStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
};

const toggleNavButtonStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 28,
  height: 24,
  border: "1px solid #555",
  borderRadius: 3,
  backgroundColor: "transparent",
  color: "#BBBBBB",
  fontSize: 14,
  cursor: "pointer",
};

const toggleNavButtonActiveStyle: React.CSSProperties = {
  ...toggleNavButtonStyle,
  backgroundColor: "#094771",
  borderColor: "#094771",
  color: "#FFFFFF",
};

const runButtonStyle: React.CSSProperties = {
  padding: "5px 16px",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  border: "none",
  borderRadius: 3,
  backgroundColor: "#0E639C",
  color: "#FFFFFF",
};

const runButtonDisabledStyle: React.CSSProperties = {
  ...runButtonStyle,
  opacity: 0.5,
  cursor: "not-allowed",
};

const mainContentStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "row",
  flex: 1,
  minHeight: 0,
  overflow: "hidden",
};

const editorPanelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
};

const editorContainerStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: "hidden",
};

const consoleContainerStyle: React.CSSProperties = {
  height: 200,
  minHeight: 80,
  display: "flex",
  flexDirection: "column",
  borderTop: "1px solid #3C3C3C",
  flexShrink: 0,
};

const consoleHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "4px 12px",
  backgroundColor: "#252526",
  borderBottom: "1px solid #3C3C3C",
  fontSize: 12,
  color: "#888",
  flexShrink: 0,
};

const consoleOutputStyle: React.CSSProperties = {
  flex: 1,
  overflow: "auto",
  padding: "6px 12px",
  fontFamily: "Consolas, 'Courier New', monospace",
  fontSize: 12,
  lineHeight: "1.5",
  backgroundColor: "#1E1E1E",
  color: "#D4D4D4",
};

const clearButtonStyle: React.CSSProperties = {
  padding: "2px 8px",
  fontSize: 11,
  cursor: "pointer",
  border: "1px solid #555",
  borderRadius: 2,
  backgroundColor: "transparent",
  color: "#999",
};

const shortcutHintStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#666",
};

const statusTextStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#888",
};

const activeModuleNameStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#999",
  fontStyle: "italic",
};

// ============================================================================
// Console Line Component
// ============================================================================

interface ConsoleEntry {
  text: string;
  type: "output" | "error" | "info";
}

function ConsoleLine({
  text,
  type,
}: {
  text: string;
  type: "output" | "error" | "info";
}): React.ReactElement {
  const color =
    type === "error" ? "#F48771" : type === "info" ? "#569CD6" : "#D4D4D4";

  return React.createElement(
    "div",
    { style: { color, whiteSpace: "pre-wrap", wordBreak: "break-all" } },
    text,
  );
}

// ============================================================================
// MonacoEditorApp Component
// ============================================================================

export function MonacoEditorApp(): React.ReactElement {
  const [source, setSource] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [consoleLines, setConsoleLines] = useState<ConsoleEntry[]>([]);
  const [lastRunInfo, setLastRunInfo] = useState<string>("");
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof monaco | null>(null);
  const consoleEndRef = useRef<HTMLDivElement>(null);
  const handleRunRef = useRef<() => void>(() => {});

  // Module store
  const {
    modules,
    activeModuleId,
    loaded,
    navPaneVisible,
    toggleNavPane,
    loadModules,
    markDirty,
  } = useModuleStore();

  // Map of module ID -> Monaco model URI, for per-module undo history
  const modelMapRef = useRef<Map<string, monaco.Uri>>(new Map());

  // Track last saved source per module to detect dirty state
  const savedSourceRef = useRef<Map<string, string>>(new Map());

  // Active module name for toolbar display
  const activeModuleName = modules.find((m) => m.id === activeModuleId)?.name ?? "";

  // ---- Load modules on mount ----
  useEffect(() => {
    loadModules();
  }, [loadModules]);

  // ---- Load active module source when activeModuleId changes ----
  useEffect(() => {
    if (!activeModuleId || !loaded) return;

    const loadSource = async (): Promise<void> => {
      try {
        const script = await getScript(activeModuleId);
        const newSource = script.source;
        setSource(newSource);
        savedSourceRef.current.set(activeModuleId, newSource);

        // Switch or create Monaco model for this module
        if (editorRef.current && monacoRef.current) {
          const m = monacoRef.current;
          let modelUri = modelMapRef.current.get(activeModuleId);
          let model: editor.ITextModel | null = null;

          if (modelUri) {
            model = m.editor.getModel(modelUri);
          }

          if (!model) {
            // Create a new model for this module
            modelUri = m.Uri.parse(`file:///${activeModuleId}.js`);
            model = m.editor.createModel(newSource, "javascript", modelUri);
            modelMapRef.current.set(activeModuleId, modelUri);
          } else {
            // Model exists — update its content only if different
            const currentModelValue = model.getValue();
            if (currentModelValue !== newSource) {
              model.setValue(newSource);
            }
          }

          editorRef.current.setModel(model);
          editorRef.current.focus();
        }
      } catch (err) {
        console.error("[MonacoEditorApp] Failed to load module:", err);
      }
    };

    loadSource();
  }, [activeModuleId, loaded]);

  // Auto-scroll console to bottom on new output
  useEffect(() => {
    consoleEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [consoleLines]);

  // Listen for code transfer from main window
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    onOpenWithCode((payload) => {
      if (payload.source) {
        setSource(payload.source);
        editorRef.current?.setValue(payload.source);
      }
    }).then((fn) => {
      unlisten = fn;
    });

    // Notify main window when this window closes
    const handleBeforeUnload = (): void => {
      // Auto-save current module before closing
      if (activeModuleId) {
        const currentSource = editorRef.current?.getValue() ?? source;
        const mod = modules.find((m) => m.id === activeModuleId);
        if (mod) {
          saveScript({
            id: activeModuleId,
            name: mod.name,
            description: null,
            source: currentSource,
          });
        }
      }
      emitEditorClosed();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      unlisten?.();
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [activeModuleId, modules, source]);

  // ---- Save current module (helper for before-switch and before-run) ----
  const saveCurrentModule = useCallback(async () => {
    if (!activeModuleId) return;
    const currentSource = editorRef.current?.getValue() ?? source;
    const mod = modules.find((m) => m.id === activeModuleId);
    if (!mod) return;

    await saveScript({
      id: activeModuleId,
      name: mod.name,
      description: null,
      source: currentSource,
    });
    savedSourceRef.current.set(activeModuleId, currentSource);

    // Mark clean in store
    const { markClean } = useModuleStore.getState();
    markClean(activeModuleId);
  }, [activeModuleId, source, modules]);

  // Run script handler
  const handleRun = useCallback(async () => {
    const code = editorRef.current?.getValue() ?? source;
    if (isRunning || !code.trim()) return;

    // Auto-save before running
    await saveCurrentModule();

    setIsRunning(true);
    setLastRunInfo("");
    setConsoleLines((prev) => [
      ...prev,
      { text: `--- Running ${activeModuleName || "script"} ---`, type: "info" },
    ]);

    try {
      const result: RunScriptResponse = await runScript(
        code,
        activeModuleName || "script.js",
      );

      if (result.type === "success") {
        const newLines: ConsoleEntry[] = result.output.map((line) => ({
          text: line,
          type: "output" as const,
        }));

        newLines.push({
          text: `--- Done (${result.durationMs}ms, ${result.cellsModified} cell(s) modified) ---`,
          type: "info",
        });

        setConsoleLines((prev) => [...prev, ...newLines]);
        setLastRunInfo(
          `${result.durationMs}ms, ${result.cellsModified} cell(s) modified`,
        );

        // Notify main window to refresh grid if cells were modified
        if (result.cellsModified > 0) {
          await emitGridNeedsRefresh(result.cellsModified);
        }
      } else {
        const newLines: ConsoleEntry[] = result.output.map((line) => ({
          text: line,
          type: "output" as const,
        }));
        newLines.push({
          text: `Error: ${result.message}`,
          type: "error",
        });
        setConsoleLines((prev) => [...prev, ...newLines]);
        setLastRunInfo("Error");
      }
    } catch (err) {
      setConsoleLines((prev) => [
        ...prev,
        {
          text: `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
          type: "error",
        },
      ]);
      setLastRunInfo("Error");
    } finally {
      setIsRunning(false);
    }
  }, [source, isRunning, activeModuleName, saveCurrentModule]);

  // Keep ref in sync for Monaco keybinding
  useEffect(() => {
    handleRunRef.current = handleRun;
  }, [handleRun]);

  const handleClearConsole = useCallback(() => {
    setConsoleLines([]);
    setLastRunInfo("");
  }, []);

  // Monaco editor mount callback
  const handleEditorMount: OnMount = (ed, m) => {
    editorRef.current = ed;
    monacoRef.current = m;

    // Register Calcula API types for IntelliSense
    m.languages.typescript.javascriptDefaults.addExtraLib(
      calculaDts,
      "calcula.d.ts",
    );

    // Configure JavaScript language service
    m.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: false,
      noSyntaxValidation: false,
    });

    m.languages.typescript.javascriptDefaults.setCompilerOptions({
      target: m.languages.typescript.ScriptTarget.ESNext,
      allowNonTsExtensions: true,
      allowJs: true,
      checkJs: true,
    });

    // Ctrl+Enter keybinding to run script
    ed.addAction({
      id: "calcula.runScript",
      label: "Run Script",
      keybindings: [m.KeyMod.CtrlCmd | m.KeyCode.Enter],
      run: () => {
        handleRunRef.current();
      },
    });

    // Ctrl+S to save current module
    ed.addAction({
      id: "calcula.saveModule",
      label: "Save Module",
      keybindings: [m.KeyMod.CtrlCmd | m.KeyCode.KeyS],
      run: () => {
        saveCurrentModule();
      },
    });

    // If we already have an activeModuleId loaded, create/set the model now
    const currentActiveId = useModuleStore.getState().activeModuleId;
    if (currentActiveId && source) {
      const modelUri = m.Uri.parse(`file:///${currentActiveId}.js`);
      let model = m.editor.getModel(modelUri);
      if (!model) {
        model = m.editor.createModel(source, "javascript", modelUri);
        modelMapRef.current.set(currentActiveId, modelUri);
      }
      ed.setModel(model);
    }

    // Focus editor on mount
    ed.focus();
  };

  // ---- Editor onChange: track dirty state ----
  const handleEditorChange = useCallback(
    (value: string | undefined) => {
      if (value === undefined) return;
      setSource(value);

      if (activeModuleId) {
        const saved = savedSourceRef.current.get(activeModuleId);
        if (saved !== undefined && value !== saved) {
          markDirty(activeModuleId);
        }
      }
    },
    [activeModuleId, markDirty],
  );

  // ---- Navigation pane callbacks ----
  const handleModuleSelect = useCallback(
    (_moduleId: string) => {
      // The store already updated activeModuleId.
      // The useEffect on activeModuleId will load the source.
    },
    [],
  );

  const handleBeforeSwitch = useCallback(async () => {
    await saveCurrentModule();
  }, [saveCurrentModule]);

  // ---- Render ----

  return React.createElement(
    "div",
    { style: appContainerStyle },

    // Toolbar
    React.createElement(
      "div",
      { style: toolbarStyle },
      React.createElement(
        "div",
        { style: toolbarLeftStyle },
        // Toggle nav pane button
        React.createElement(
          "button",
          {
            style: navPaneVisible
              ? toggleNavButtonActiveStyle
              : toggleNavButtonStyle,
            onClick: toggleNavPane,
            title: navPaneVisible ? "Hide Modules" : "Show Modules",
          },
          // Simple sidebar icon using text
          "\u2261", // hamburger-like icon
        ),
        React.createElement(
          "span",
          { style: { fontWeight: 600, fontSize: 14, color: "#E0E0E0" } },
          "Calcula Script Editor",
        ),
        // Active module name
        activeModuleName
          ? React.createElement(
              "span",
              { style: activeModuleNameStyle },
              `- ${activeModuleName}`,
            )
          : null,
      ),
      React.createElement(
        "div",
        { style: toolbarRightStyle },
        lastRunInfo
          ? React.createElement("span", { style: statusTextStyle }, lastRunInfo)
          : null,
        React.createElement(
          "span",
          { style: shortcutHintStyle },
          "Ctrl+Enter",
        ),
        React.createElement(
          "button",
          {
            style: isRunning ? runButtonDisabledStyle : runButtonStyle,
            onClick: handleRun,
            disabled: isRunning,
            title: "Run script (Ctrl+Enter)",
          },
          isRunning ? "Running..." : "Run",
        ),
      ),
    ),

    // Main content: Navigation Pane + Editor/Console
    React.createElement(
      "div",
      { style: mainContentStyle },

      // Navigation Pane (conditionally rendered)
      navPaneVisible && loaded
        ? React.createElement(ModuleNavigationPane, {
            onModuleSelect: handleModuleSelect,
            onBeforeSwitch: handleBeforeSwitch,
          })
        : null,

      // Editor + Console panel
      React.createElement(
        "div",
        { style: editorPanelStyle },

        // Monaco Editor
        React.createElement(
          "div",
          { style: editorContainerStyle },
          React.createElement(Editor, {
            defaultLanguage: "javascript",
            defaultValue: source,
            theme: "vs-dark",
            onMount: handleEditorMount,
            onChange: handleEditorChange,
            options: {
              fontSize: 14,
              fontFamily: "Consolas, 'Courier New', monospace",
              minimap: { enabled: true },
              scrollBeyondLastLine: false,
              wordWrap: "on",
              tabSize: 2,
              automaticLayout: true,
              suggestOnTriggerCharacters: true,
              quickSuggestions: true,
              lineNumbers: "on",
              renderLineHighlight: "all",
              bracketPairColorization: { enabled: true },
              padding: { top: 8 },
            },
          }),
        ),

        // Console Output Panel
        React.createElement(
          "div",
          { style: consoleContainerStyle },
          React.createElement(
            "div",
            { style: consoleHeaderStyle },
            React.createElement("span", null, "Console Output"),
            React.createElement(
              "button",
              {
                style: clearButtonStyle,
                onClick: handleClearConsole,
                title: "Clear console",
              },
              "Clear",
            ),
          ),
          React.createElement(
            "div",
            { style: consoleOutputStyle },
            consoleLines.map((entry, i) =>
              React.createElement(ConsoleLine, {
                key: i,
                text: entry.text,
                type: entry.type,
              }),
            ),
            React.createElement("div", { ref: consoleEndRef }),
          ),
        ),
      ),
    ),
  );
}
