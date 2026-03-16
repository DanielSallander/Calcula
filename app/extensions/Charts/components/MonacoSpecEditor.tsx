//! FILENAME: app/extensions/Charts/components/MonacoSpecEditor.tsx
// PURPOSE: Shared Monaco-based JSON editor for ChartSpec with IntelliSense.
// CONTEXT: Used by both SpecTab (dialog) and ChartSpecEditorApp (standalone window).
//          Provides autocomplete, hover docs, and validation from the JSON Schema.

import React, { useRef, useCallback, useEffect } from "react";
import Editor, { type OnMount, loader } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import { chartSpecJsonSchema } from "../lib/chartSpecSchema";

// ============================================================================
// Monaco Worker Setup (local, no CDN)
// ============================================================================

self.MonacoEnvironment = {
  getWorker(_: string, label: string) {
    if (label === "json") {
      return new jsonWorker();
    }
    return new editorWorker();
  },
};

loader.config({ monaco });

// Register the ChartSpec schema once
let schemaRegistered = false;
function registerSchema() {
  if (schemaRegistered) return;
  schemaRegistered = true;

  monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
    validate: true,
    allowComments: false,
    trailingCommas: "error",
    schemas: [
      {
        uri: "calcula://chartspec-schema",
        fileMatch: ["*"],
        schema: chartSpecJsonSchema as Record<string, unknown>,
      },
    ],
  });
}

// ============================================================================
// Props
// ============================================================================

export interface MonacoSpecEditorProps {
  /** Current JSON text content. */
  value: string;
  /** Called when the user edits the content. */
  onChange: (value: string) => void;
  /** Called when the editor loses focus. */
  onBlur?: () => void;
  /** Optional height CSS value. Default: "100%". */
  height?: string;
  /** Whether to show the minimap. Default: false. */
  minimap?: boolean;
  /** Read-only mode. Default: false. */
  readOnly?: boolean;
}

// ============================================================================
// Component
// ============================================================================

export function MonacoSpecEditor({
  value,
  onChange,
  onBlur,
  height = "100%",
  minimap = false,
  readOnly = false,
}: MonacoSpecEditorProps): React.ReactElement {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);

  const handleEditorMount: OnMount = useCallback((editorInstance, m) => {
    editorRef.current = editorInstance;

    // Register schema for IntelliSense
    registerSchema();

    // Focus the editor
    editorInstance.focus();

    // Add format keybinding (Shift+Alt+F)
    editorInstance.addAction({
      id: "format-json",
      label: "Format Document",
      keybindings: [m.KeyMod.Shift | m.KeyMod.Alt | m.KeyCode.KeyF],
      run: (ed) => {
        ed.getAction("editor.action.formatDocument")?.run();
      },
    });
  }, []);

  const handleChange = useCallback((val: string | undefined) => {
    if (val !== undefined) {
      onChange(val);
    }
  }, [onChange]);

  // Handle blur via editor event
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed || !onBlur) return;
    const disposable = ed.onDidBlurEditorWidget(() => {
      onBlur();
    });
    return () => disposable.dispose();
  }, [onBlur]);

  return (
    <Editor
      height={height}
      language="json"
      theme="vs-dark"
      value={value}
      onChange={handleChange}
      onMount={handleEditorMount}
      options={{
        fontSize: 12,
        fontFamily: "'Cascadia Code', 'Consolas', 'Courier New', monospace",
        lineNumbers: "on",
        minimap: { enabled: minimap },
        scrollBeyondLastLine: false,
        automaticLayout: true,
        tabSize: 2,
        wordWrap: "on",
        readOnly,
        quickSuggestions: true,
        suggestOnTriggerCharacters: true,
        formatOnPaste: true,
        renderLineHighlight: "gutter",
        scrollbar: {
          verticalScrollbarSize: 10,
          horizontalScrollbarSize: 10,
        },
      }}
    />
  );
}

/**
 * Programmatically format JSON in a Monaco editor instance.
 * Call from parent components to trigger formatting.
 */
export function formatMonacoEditor(editorRef: React.RefObject<editor.IStandaloneCodeEditor | null>): void {
  editorRef.current?.getAction("editor.action.formatDocument")?.run();
}
