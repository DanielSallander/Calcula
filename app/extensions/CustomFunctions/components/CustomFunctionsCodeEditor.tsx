//! FILENAME: app/extensions/CustomFunctions/components/CustomFunctionsCodeEditor.tsx
// PURPOSE: Monaco code editor for a custom-function BODY (a JS fragment that
//          returns a value). Syntax highlighting, autocomplete AND real
//          diagnostics for the sandboxed `cube.*` helpers.
// CONTEXT: This editor used to switch validation OFF — `noSemanticValidation:
//          true, noSyntaxValidation: true` — because the content is a FRAGMENT:
//          a top-level `return` is legal here and TypeScript reports it as
//          error 1108. Two problems with that:
//
//            1. Those options are GLOBAL to Monaco's javascript language
//               service. This module runs at import time, which is startup, so
//               it silently disabled diagnostics for the object-script editor
//               and the notebook as well — the "typings but no type-checking"
//               bug this file was half the cause of.
//            2. Custom-function authors lost every OTHER check with it: a
//               misspelled `cube.valu(...)` was as silent as a correct call.
//
//          The fix is to name the fragment shape precisely instead of turning
//          everything off. `registerScriptSurface` merges this surface's libs
//          and its (documented) fragment suppressions with every other
//          surface's, so `cube.` typos are reported here and object-script
//          diagnostics stay on over there.
//
//          A fragment is NOT offered TypeScript authoring: the body is stored
//          and executed verbatim as the text of a function body, so there is no
//          module to compile and nowhere to put the compiled result. Object
//          scripts, which ARE whole modules, are where TypeScript authoring
//          lives (see ScriptableObjects/lib/authoringLanguage.ts).

import React, { useCallback } from "react";
import Editor, { type OnMount, loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import { registerScriptSurface } from "../../_shared/lib/monacoScriptLanes";

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

// Ambient types for the names the generated wrapper binds around a body
// (see buildLibrarySource in src/api/customFunctions.ts): `cube` from the
// capability shim and `cellError` for returning a specific cell error. The
// declared parameters and the sibling-call table are per-function and dynamic,
// which is why 2304 stays suppressed below.
const CUBE_DTS = `
declare const cube: {
  /** Aggregated value: a measure sliced by member filters. */
  value(connection: string, ...members: string[]): Promise<number | null>;
  /** KPI value(1)/goal(2)/status(3). */
  kpi(connection: string, kpi: string, property: number): Promise<number | null>;
  /** Distinct members of a level, e.g. "Geo[Country]". */
  members(connection: string, level: string): Promise<string[]>;
};

/** Return a SPECIFIC error into the cell, e.g. \`return cellError("#N/A")\`. */
declare function cellError(code: string): unknown;
`;

/**
 * The diagnostics that are meaningless for a FUNCTION BODY, and nothing else.
 *
 * Everything not listed here stays on, so a misspelled helper, a bad argument
 * count or a genuine syntax error is a red squiggle at author time instead of
 * a `#VALUE!` at recalculation time.
 */
const FRAGMENT_SUPPRESSIONS = [
  { code: 1108, reason: "A 'return' statement can only be used within a function body — this IS a function body" },
  {
    code: 2304,
    reason:
      "Cannot find name — the declared parameters and the sibling-call table (fns) are bound by the generated wrapper, not by this text",
  },
];

function registerSurface(): void {
  registerScriptSurface(monacoTs, {
    lane: "javascript",
    surface: "customFunctions",
    libs: [{ path: "calcula-cube.d.ts", content: CUBE_DTS }],
    ignoreDiagnosticCodes: FRAGMENT_SUPPRESSIONS,
  });
}
registerSurface();

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
  // Re-assert on mount: module load order decides who configured Monaco first,
  // mount order decides who configured it last, and the MERGED configuration
  // has to be the live one either way.
  const handleMount: OnMount = useCallback((_ed, _m) => {
    registerSurface();
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
        // Explicit `.js` model name: Monaco's TypeScript worker picks a script
        // kind from the file name, so naming it keeps this fragment parsed as
        // JavaScript no matter what compiler options the shared lane carries.
        path="customFunction/body.js"
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
