//! FILENAME: app/extensions/ScriptNotebook/components/NotebookMonacoEditor.tsx
// PURPOSE: Lightweight Monaco editor for notebook cells with Calcula API intellisense.
// CONTEXT: Provides autocomplete, hover docs, and syntax validation for the
//          Calcula.* and console.* APIs inside notebook cells.

import React, { useRef, useCallback, useEffect } from "react";
import Editor, { type OnMount, loader } from "@monaco-editor/react";
import type { editor as monacoEditor } from "monaco-editor";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
// Vite ?raw import: loads .d.ts as a plain string for Monaco type registration
import calculaDts from "../../ScriptEditor/calcula.d.ts?raw";

// ============================================================================
// Monaco Worker Setup (local, no CDN)
// ============================================================================

// Patch the global MonacoEnvironment to include TS/JS worker support.
// Other extensions (e.g., Charts) may have set this first with only JSON
// workers, so we must override to ensure the TypeScript language service loads.
const prevGetWorker = self.MonacoEnvironment?.getWorker;
self.MonacoEnvironment = {
  getWorker(_: string, label: string) {
    if (label === "typescript" || label === "javascript") {
      return new tsWorker();
    }
    // Delegate to previous handler for other worker types (e.g., JSON)
    if (prevGetWorker) {
      return prevGetWorker(_, label);
    }
    return new editorWorker();
  },
};

loader.config({ monaco });

// Register Calcula API types eagerly at module load time.
// This ensures IntelliSense is ready before the first editor mounts.
(function registerCalculaTypes() {
  monaco.languages.typescript.javascriptDefaults.addExtraLib(
    calculaDts,
    "calcula.d.ts",
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
// Props
// ============================================================================

export interface NotebookMonacoEditorProps {
  /** Current cell source code. */
  value: string;
  /** Called when source changes. */
  onChange: (value: string) => void;
  /** Called when Shift+Enter is pressed (run cell). */
  onRunCell: () => void;
  /** Placeholder text for empty editor. */
  placeholder?: string;
}

// ============================================================================
// Component
// ============================================================================

// Minimum and maximum editor height in pixels
const MIN_HEIGHT = 38;
const MAX_HEIGHT = 400;
const LINE_HEIGHT = 19;

export function NotebookMonacoEditor({
  value,
  onChange,
  onRunCell,
}: NotebookMonacoEditorProps): React.ReactElement {
  const editorRef = useRef<monacoEditor.IStandaloneCodeEditor | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Compute height based on line count
  const lineCount = Math.max(1, (value || "").split("\n").length);
  const contentHeight = Math.min(
    MAX_HEIGHT,
    Math.max(MIN_HEIGHT, lineCount * LINE_HEIGHT + 4),
  );

  const handleMount: OnMount = useCallback(
    (ed, _m) => {
      editorRef.current = ed;

      // Shift+Enter = run cell (prevent default newline)
      ed.addAction({
        id: "notebook.runCell",
        label: "Run Cell",
        keybindings: [monaco.KeyMod.Shift | monaco.KeyCode.Enter],
        run: () => {
          onRunCell();
        },
      });

      // Disable the default command palette keybinding to avoid conflicts
      // Keep Ctrl+Space for suggestions

      // Auto-resize on content change
      const updateHeight = () => {
        const model = ed.getModel();
        if (!model) return;
        const lines = model.getLineCount();
        const newHeight = Math.min(
          MAX_HEIGHT,
          Math.max(MIN_HEIGHT, lines * LINE_HEIGHT + 4),
        );
        if (containerRef.current) {
          containerRef.current.style.height = `${newHeight}px`;
        }
        ed.layout();
      };

      ed.onDidChangeModelContent(updateHeight);
      updateHeight();
    },
    [onRunCell],
  );

  const handleChange = useCallback(
    (val: string | undefined) => {
      if (val !== undefined) {
        onChange(val);
      }
    },
    [onChange],
  );

  // Re-layout when value changes externally (e.g., after rewind clears cells)
  useEffect(() => {
    if (editorRef.current) {
      editorRef.current.layout();
    }
  }, [value]);

  return (
    <div ref={containerRef} style={{ height: contentHeight, minHeight: MIN_HEIGHT }}>
      <Editor
        height="100%"
        language="javascript"
        theme="vs"
        value={value}
        onChange={handleChange}
        onMount={handleMount}
        options={{
          fontSize: 12,
          fontFamily: "'Cascadia Code', 'Consolas', 'Courier New', monospace",
          lineNumbers: "off",
          glyphMargin: false,
          folding: false,
          lineDecorationsWidth: 4,
          lineNumbersMinChars: 0,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          automaticLayout: true,
          tabSize: 2,
          wordWrap: "on",
          renderLineHighlight: "none",
          overviewRulerLanes: 0,
          overviewRulerBorder: false,
          hideCursorInOverviewRuler: true,
          scrollbar: {
            vertical: "hidden",
            horizontal: "auto",
            verticalScrollbarSize: 0,
            horizontalScrollbarSize: 6,
          },
          quickSuggestions: true,
          suggestOnTriggerCharacters: true,
          parameterHints: { enabled: true },
          hover: { enabled: true },
          padding: { top: 4, bottom: 4 },
          contextmenu: false,
          // Render suggest widget and other overlays with position:fixed
          // so they are not clipped by the cell's overflow:hidden
          fixedOverflowWidgets: true,
          // Single-cell feel: no unnecessary chrome
          occurrencesHighlight: "off",
          selectionHighlight: false,
          matchBrackets: "always",
        }}
      />
    </div>
  );
}
