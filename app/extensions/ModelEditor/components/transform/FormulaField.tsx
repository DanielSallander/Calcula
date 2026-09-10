// FILENAME: app/extensions/ModelEditor/components/transform/FormulaField.tsx
// PURPOSE: The formula input a transformation step's expression is written in —
//          Monaco with the transform-scoped language, sized like a formula bar
//          rather than like a code editor.
// CONTEXT: This replaces a <textarea> whose only affordance was a 12-name
//          truncated hint and a button opening the MEASURE editor. The measure
//          editor is wrong here in three ways that each produce a broken
//          formula (see formulaLanguage.ts), so the fix was a scoped surface
//          rather than a nicer hint.
//
//          The function list is fetched once per mount and filtered on the
//          engine's own `rowLevel` flag, which the engine derives from the
//          transform allowlist. So completion cannot offer something the step
//          will refuse.

import React, { useEffect, useMemo, useRef, useState } from "react";
import Editor, { type OnMount, loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { enforceLfLineEndings } from "../../../_shared/lib/monacoLineEndings";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import { biModelFunctionCatalog } from "@api";
import type { FunctionDefDto, ModelColumnInfo } from "@api";
import { styles } from "../editorShared";
import {
  TRANSFORM_FORMULA_LANGUAGE_ID,
  registerTransformFormulaLanguage,
  setFormulaContext,
} from "./formulaLanguage";
import { ME } from "../theme";
import { applyModelEditorTheme } from "../../lib/monacoTheme";

// Chain the worker handler so this editor never clobbers another Monaco setup
// in the same window (mirrors ExpressionEditorModal / ScriptPane).
const prevGetWorker = self.MonacoEnvironment?.getWorker;
self.MonacoEnvironment = {
  getWorker(id: string, label: string) {
    return prevGetWorker ? prevGetWorker(id, label) : new editorWorker();
  },
};
loader.config({ monaco });
enforceLfLineEndings(monaco);

/** The catalog is static for the process; fetch it once per window. */
let catalogPromise: Promise<FunctionDefDto[]> | null = null;
function rowLevelFunctions(): Promise<FunctionDefDto[]> {
  catalogPromise ??= biModelFunctionCatalog().catch(() => [] as FunctionDefDto[]);
  return catalogPromise.then((all) => all.filter((f) => f.rowLevel));
}

export function FormulaField({
  value,
  columns,
  readOnly,
  placeholder,
  minHeight = 68,
  onChange,
}: {
  value: string;
  /** The columns reaching THIS step — its input schema, not the table's. */
  columns: ModelColumnInfo[];
  readOnly: boolean;
  placeholder?: string;
  minHeight?: number;
  onChange: (value: string) => void;
}): React.ReactElement {
  const [functions, setFunctions] = useState<FunctionDefDto[]>([]);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);

  useEffect(() => {
    let cancelled = false;
    void rowLevelFunctions().then((list) => {
      if (!cancelled) setFunctions(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Point the providers at THIS step before any of them can run.
  useEffect(() => {
    setFormulaContext({ columns, functions });
  }, [columns, functions]);

  const handleMount: OnMount = (editor, monaco) => {
    // Every Monaco in this window ran the stock light "vs" theme; once the
    // window follows the skin that is a white editor inside a dark dialog.
    applyModelEditorTheme(monaco);
    editorRef.current = editor;
    registerTransformFormulaLanguage();
    setFormulaContext({ columns, functions });
  };

  // A formula is usually one line; grow with it rather than reserving a slab
  // of empty editor, the way a formula bar does.
  const height = useMemo(() => {
    const lines = Math.max(1, value.split("\n").length);
    return Math.max(minHeight, Math.min(220, 22 + lines * 19));
  }, [value, minHeight]);

  return (
    <div>
      <div
        style={{
          border: `1px solid ${ME.ctlBorder}`,
          borderRadius: 4,
          overflow: "hidden",
          background: readOnly ? ME.sunken : ME.surface,
        }}
      >
        <Editor
          language={TRANSFORM_FORMULA_LANGUAGE_ID}
          value={value}
          onChange={(next) => onChange(next ?? "")}
          onMount={handleMount}
          height={height}
          options={{
            readOnly,
            minimap: { enabled: false },
            lineNumbers: "off",
            glyphMargin: false,
            folding: false,
            lineDecorationsWidth: 6,
            lineNumbersMinChars: 0,
            scrollBeyondLastLine: false,
            overviewRulerLanes: 0,
            scrollbar: { vertical: "auto", horizontal: "auto", verticalScrollbarSize: 8 },
            fontSize: 13,
            fontFamily: "Consolas, 'Courier New', monospace",
            wordWrap: "on",
            automaticLayout: true,
            renderLineHighlight: "none",
            quickSuggestions: { other: true, comments: false, strings: false },
            suggestOnTriggerCharacters: true,
            tabCompletion: "on",
            padding: { top: 6, bottom: 6 },
          }}
        />
      </div>
      <div style={{ ...styles.hint, marginTop: 4 }}>
        {placeholder ? `e.g. ${placeholder} · ` : ""}
        Type <code>[</code> for this step&apos;s {columns.length} column
        {columns.length === 1 ? "" : "s"}, or a function name for the{" "}
        {functions.length > 0 ? functions.length : ""} that work here. Aggregates
        (<code>SUM</code>) are not offered — a step computes one value per row.
      </div>
    </div>
  );
}
