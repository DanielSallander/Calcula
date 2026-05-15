//! FILENAME: app/extensions/JsonView/components/MonacoJsonEditor.tsx
// PURPOSE: Reusable Monaco-based JSON editor with optional schema validation.
// CONTEXT: Generalized from Charts/MonacoSpecEditor. Used by JsonEditorPane,
//          JsonEditorDialog, and Phase C's GUI/JSON toggle.

import React, { useRef, useCallback, useEffect } from "react";
import Editor, { type OnMount, loader } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";

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

// ============================================================================
// Schema Registration
// ============================================================================

const registeredSchemas = new Set<string>();

/**
 * Register a JSON schema for Monaco IntelliSense.
 * Each schemaUri is registered at most once.
 */
function registerSchema(schemaUri: string, schema: Record<string, unknown>): void {
  if (registeredSchemas.has(schemaUri)) return;
  registeredSchemas.add(schemaUri);

  const existing = monaco.languages.json.jsonDefaults.diagnosticsOptions;
  const schemas = [...(existing.schemas || [])];
  schemas.push({
    uri: schemaUri,
    fileMatch: [],
    schema,
  });

  monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
    validate: true,
    allowComments: false,
    trailingCommas: "error",
    schemas,
  });
}

// ============================================================================
// Props
// ============================================================================

export interface MonacoJsonEditorProps {
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
  /** Optional JSON schema for IntelliSense validation. */
  schema?: Record<string, unknown>;
  /** Unique schema URI (required if schema is provided). */
  schemaUri?: string;
}

// ============================================================================
// Component
// ============================================================================

export function MonacoJsonEditor({
  value,
  onChange,
  onBlur,
  height = "100%",
  minimap = false,
  readOnly = false,
  schema,
  schemaUri,
}: MonacoJsonEditorProps): React.ReactElement {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);

  const handleEditorMount: OnMount = useCallback(
    (editorInstance, m) => {
      editorRef.current = editorInstance;

      // Register schema if provided
      if (schema && schemaUri) {
        registerSchema(schemaUri, schema);
      }

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
    },
    [schema, schemaUri],
  );

  const handleChange = useCallback(
    (val: string | undefined) => {
      if (val !== undefined) {
        onChange(val);
      }
    },
    [onChange],
  );

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
 */
export function formatMonacoEditor(
  editorRef: React.RefObject<editor.IStandaloneCodeEditor | null>,
): void {
  editorRef.current?.getAction("editor.action.formatDocument")?.run();
}
