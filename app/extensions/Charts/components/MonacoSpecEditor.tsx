//! FILENAME: app/extensions/Charts/components/MonacoSpecEditor.tsx
// PURPOSE: Shared Monaco-based JSON editor for ChartSpec with IntelliSense.
// CONTEXT: Used by both SpecTab (dialog) and ChartSpecEditorApp (standalone window).
//          Provides autocomplete, hover docs, and validation from the JSON Schema.

import React, { useRef, useCallback, useEffect } from "react";
import Editor, { type OnMount, loader } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import * as monaco from "monaco-editor";
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Monaco 0.52+ moved json to top-level; languages.json still works at runtime
const monacoJson = (monaco.languages as any).json;
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import { chartSpecJsonSchema } from "../lib/chartSpecSchema";
import { CHART_SNIPPETS } from "../lib/chartSnippets";

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

  monacoJson.jsonDefaults.setDiagnosticsOptions({
    validate: true,
    allowComments: false,
    trailingCommas: "error",
    schemas: [
      {
        uri: "calcula://chartspec-schema",
        // "*" keeps the historical catch-all; the explicit chartspec patterns
        // guarantee the schema still associates with our custom per-instance model
        // URIs (chartspec://spec-N.json) regardless of how "*" globs a scheme.
        // Same schema uri -> Monaco applies it once (no duplicate diagnostics).
        fileMatch: ["*", "chartspec://*", "chartspec:/*"],
        schema: chartSpecJsonSchema as Record<string, unknown>,
      },
    ],
  });
}

// ----------------------------------------------------------------------------
// Insert-snippets (B6)
// ----------------------------------------------------------------------------
// The JSON completion provider is language-global, so we scope chart snippets to
// the models that belong to a ChartSpec editor (registered on mount) — they must
// NOT pollute unrelated JSON editors. The provider returns an empty set for any
// other model, letting the schema's own completions stand alone.
const chartSpecModelUris = new Set<string>();
let snippetsRegistered = false;
// Per-instance model URI counter. Path-less @monaco-editor/react editors all
// share the URI "file:///" (one reused model), so without a unique path the
// snippet scoping below could not tell a chart-spec model from any other JSON
// editor in the same window (e.g. the JSON View pane) — chart snippets would leak
// there. A distinct path per instance gives each chart editor its own model + URI.
let specEditorSeq = 0;

function registerSnippets(m: typeof monaco) {
  if (snippetsRegistered) return;
  snippetsRegistered = true;

  m.languages.registerCompletionItemProvider("json", {
    provideCompletionItems(model, position) {
      if (!chartSpecModelUris.has(model.uri.toString())) return { suggestions: [] };
      // Replace the word being typed so triggering mid-token doesn't duplicate it.
      const word = model.getWordUntilPosition(position);
      const range = new m.Range(
        position.lineNumber,
        word.startColumn,
        position.lineNumber,
        word.endColumn,
      );
      const suggestions = CHART_SNIPPETS.map((s) => ({
        label: s.label,
        kind: m.languages.CompletionItemKind.Snippet,
        detail: s.detail,
        documentation: { value: s.documentation },
        insertText: s.body,
        insertTextRules: m.languages.CompletionItemInsertTextRule.InsertAsSnippet,
        range,
      }));
      return { suggestions };
    },
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
  // Stable, unique model path for THIS editor instance (lazy-init so the counter
  // advances once per mount, not per render). Scopes snippets to chart-spec models.
  const modelPathRef = useRef<string | null>(null);
  if (modelPathRef.current === null) {
    modelPathRef.current = `chartspec://spec-${specEditorSeq++}.json`;
  }

  const handleEditorMount: OnMount = useCallback((editorInstance, m) => {
    editorRef.current = editorInstance;

    // Register schema for IntelliSense
    registerSchema();

    // Register insert-snippets (once) and mark THIS model as a chart-spec model
    // so the language-global provider only offers chart snippets here.
    registerSnippets(m);
    const model = editorInstance.getModel();
    if (model) {
      const uri = model.uri.toString();
      chartSpecModelUris.add(uri);
      model.onWillDispose(() => chartSpecModelUris.delete(uri));
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
      path={modelPathRef.current}
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
