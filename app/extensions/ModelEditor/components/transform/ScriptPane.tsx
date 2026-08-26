// FILENAME: app/extensions/ModelEditor/components/transform/ScriptPane.tsx
// PURPOSE: The "advanced editor" half of the transform modal — the whole
//          pipeline as editable text, parsed back into typed steps on every
//          pause.
// CONTEXT: The steps stay canonical. This pane RENDERS them on entry and
//          COMPILES the buffer back before anything is lifted into the draft,
//          so a round trip through here that changes nothing is provably not an
//          edit (`parse(render(s)) == s` is a test in the engine). While the
//          buffer does not parse, the last good draft is what Apply would
//          write — so Apply is refused rather than writing something the buffer
//          does not say.

import React, { useCallback, useEffect, useRef, useState } from "react";
import Editor, { type OnMount, loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { enforceLfLineEndings } from "../../../_shared/lib/monacoLineEndings";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import { biModelTransformFromScript, biModelTransformVocabulary } from "@api";
import type { TransformDiagnosticDto, TransformStepDto } from "@api";
import { styles } from "../editorShared";
import {
  TRANSFORM_SCRIPT_LANGUAGE_ID,
  registerTransformScriptLanguage,
  setTransformScriptVocabulary,
} from "./transformScriptLanguage";

// Chain the worker handler so this editor never clobbers another Monaco setup
// in the same window (mirrors ExpressionEditorModal / ExpressionWorkspace).
const prevGetWorker = self.MonacoEnvironment?.getWorker;
self.MonacoEnvironment = {
  getWorker(id: string, label: string) {
    return prevGetWorker ? prevGetWorker(id, label) : new editorWorker();
  },
};
loader.config({ monaco });
// A script is LF on every platform. Monaco defaults a model created from EMPTY
// text to the OS ending (CRLF here) — see _shared/lib/monacoLineEndings.ts.
enforceLfLineEndings(monaco);

/** Reading a script is pure (no I/O), so it can chase the keystrokes closely —
 *  the same budget the step editor gives its schema derivation. */
const PARSE_DEBOUNCE_MS = 250;

export function ScriptPane({
  connectionId,
  tableName,
  /** The rendered starting text. Re-seeds the buffer when it changes identity,
   *  which happens when the pane is entered or the table is reloaded. */
  initialScript: initialText,
  readOnly,
  onParsed,
  onParseStateChange,
}: {
  connectionId: string;
  tableName: string;
  initialScript: string;
  readOnly: boolean;
  /** The steps a SUCCESSFUL parse produced. Not called on a failed parse: the
   *  draft must keep the last thing the buffer actually said. */
  onParsed: (steps: TransformStepDto[]) => void;
  /** Whether the buffer currently compiles. The modal refuses Apply while it
   *  does not, because the draft and the buffer then disagree. */
  onParseStateChange: (ok: boolean) => void;
}): React.ReactElement {
  const [text, setText] = useState(initialText);
  const [diagnostics, setDiagnostics] = useState<TransformDiagnosticDto[]>([]);
  const [readError, setReadError] = useState<string | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);

  // Re-seed when a new rendering arrives (entering the pane, or a fresh table).
  useEffect(() => {
    setText(initialText);
  }, [initialText]);

  // The grammar, served by the engine that parses it.
  useEffect(() => {
    let cancelled = false;
    void biModelTransformVocabulary(connectionId)
      .then((vocabulary) => {
        if (!cancelled) setTransformScriptVocabulary(vocabulary);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [connectionId]);

  const handleMount: OnMount = (editor) => {
    editorRef.current = editor;
    registerTransformScriptLanguage();
    editor.focus();
  };

  // ── Read the buffer (parse + validate + derive, one round trip) ───────────
  useEffect(() => {
    let cancelled = false;
    const handle = window.setTimeout(() => {
      void biModelTransformFromScript(connectionId, tableName, text)
        .then((result) => {
          if (cancelled) return;
          setReadError(null);
          setDiagnostics(result.diagnostics);
          onParseStateChange(result.parsed);
          // Lift ONLY a clean parse. A buffer that parses but fails validation
          // still describes a real pipeline, so the draft follows it and the
          // diagnostic explains the rest; a buffer that does not parse
          // describes nothing, and the draft stays where it was.
          if (result.parsed) onParsed(result.steps);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setReadError(String(err));
          onParseStateChange(false);
        });
    }, PARSE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [connectionId, tableName, text, onParsed, onParseStateChange]);

  // ── Diagnostics as markers, so the error is ON the line it belongs to ─────
  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!model) return;
    monaco.editor.setModelMarkers(
      model,
      "transform-script",
      diagnostics.map((d) => {
        const line = Math.min(Math.max(d.line ?? 1, 1), model.getLineCount());
        const column = d.column ?? 1;
        return {
          severity:
            d.severity === "warning"
              ? monaco.MarkerSeverity.Warning
              : monaco.MarkerSeverity.Error,
          message: d.message,
          startLineNumber: line,
          startColumn: column,
          endLineNumber: line,
          // To the end of the line: a syntax error's extent is not known, and a
          // one-character squiggle is easy to miss.
          endColumn: model.getLineMaxColumn(line),
        };
      }),
    );
  }, [diagnostics]);

  const goTo = useCallback((line: number, column: number) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column });
    editor.focus();
  }, []);

  const worst = readError ?? diagnostics[0]?.message ?? null;

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, gap: 6 }}>
      <div style={{ ...styles.hint }}>
        One statement per step, in order. An indented line continues the step above it; a
        <code style={{ margin: "0 3px" }}>//</code>
        at the start of a line comments a step out for as long as this editor is open. Applying
        replaces the pipeline in one edit.
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          border: `1px solid ${worst ? "#a4262c" : "#ddd"}`,
          borderRadius: 4,
          overflow: "hidden",
        }}
      >
        <Editor
          language={TRANSFORM_SCRIPT_LANGUAGE_ID}
          value={text}
          onChange={(next) => setText(next ?? "")}
          onMount={handleMount}
          options={{
            readOnly,
            minimap: { enabled: false },
            lineNumbers: "on",
            scrollBeyondLastLine: false,
            fontSize: 12,
            fontFamily: "Consolas, 'Courier New', monospace",
            wordWrap: "on",
            automaticLayout: true,
            renderWhitespace: "boundary",
            tabSize: 2,
            insertSpaces: true,
          }}
          height="100%"
        />
      </div>
      {worst !== null && (
        <div
          style={{
            fontSize: 12,
            color: "#a4262c",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {diagnostics[0]?.line !== undefined ? (
            <button
              style={{
                ...styles.smallBtn,
                marginRight: 6,
                borderColor: "#a4262c",
                color: "#a4262c",
              }}
              onClick={() => goTo(diagnostics[0].line ?? 1, diagnostics[0].column ?? 1)}
            >
              line {diagnostics[0].line}
            </button>
          ) : null}
          {worst}
        </div>
      )}
    </div>
  );
}
