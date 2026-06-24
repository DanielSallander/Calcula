//! FILENAME: app/extensions/CustomFunctions/components/CustomFunctionsCodeEditor.tsx
// PURPOSE: Monaco code editor for a custom-function BODY (a JS fragment that
//          returns a value). Provides syntax highlighting + autocomplete for the
//          sandboxed `cube.*` helpers. Diagnostics are off because the content is
//          a function body (top-level `return` is valid here, not a syntax error).

import React, { useCallback } from "react";
import Editor, { type OnMount, loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- typescript namespace stays at runtime
const monacoTs = (monaco.languages as any).typescript;

// Patch MonacoEnvironment for TS/JS workers, preserving any prior handler so we
// don't clobber another editor's (e.g. Charts/Notebook) worker setup.
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

// Ambient types so `cube.` autocompletes inside a function body. Idempotent.
const CUBE_DTS = `
declare const cube: {
  /** Aggregated value: a measure sliced by member filters. */
  value(connection: string, ...members: string[]): Promise<number | null>;
  /** KPI value(1)/goal(2)/status(3). */
  kpi(connection: string, kpi: string, property: number): Promise<number | null>;
  /** Distinct members of a level, e.g. "Geo[Country]". */
  members(connection: string, level: string): Promise<string[]>;
};
`;

let typesRegistered = false;
function registerTypesOnce(): void {
  if (typesRegistered) return;
  typesRegistered = true;
  monacoTs.javascriptDefaults.addExtraLib(CUBE_DTS, "calcula-cube.d.ts");
  // The body is a fragment (top-level `return`), so disable validation to avoid
  // false errors; highlighting + completions still work.
  monacoTs.javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: true,
  });
  monacoTs.javascriptDefaults.setCompilerOptions({
    target: monacoTs.ScriptTarget.ESNext,
    allowNonTsExtensions: true,
    allowJs: true,
  });
}
registerTypesOnce();

export interface CustomFunctionsCodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  height?: number;
}

export function CustomFunctionsCodeEditor({
  value,
  onChange,
  height = 170,
}: CustomFunctionsCodeEditorProps): React.ReactElement {
  const handleMount: OnMount = useCallback((_ed, _m) => {
    registerTypesOnce();
  }, []);

  const handleChange = useCallback(
    (val: string | undefined) => {
      if (val !== undefined) onChange(val);
    },
    [onChange],
  );

  return (
    <div
      style={{
        height,
        border: "1px solid var(--border, #ccc)",
        borderRadius: 4,
        overflow: "hidden",
      }}
    >
      <Editor
        height="100%"
        language="javascript"
        theme="vs"
        value={value}
        onChange={handleChange}
        onMount={handleMount}
        options={{
          fontSize: 12.5,
          fontFamily: "'Cascadia Code', 'Consolas', 'Courier New', monospace",
          lineNumbers: "on",
          glyphMargin: false,
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
          padding: { top: 6, bottom: 6 },
          contextmenu: false,
          fixedOverflowWidgets: true,
        }}
      />
    </div>
  );
}
