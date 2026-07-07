//! FILENAME: app/extensions/_shared/dsl/pivotLayout/DesignQueryEditor.tsx
// PURPOSE: Shared Monaco editor for pivot-layout "design query" DSL. Registers
//   the pivot-layout-dsl language (syntax highlighting + autocomplete) and feeds
//   autocomplete the caller-supplied BI model. Consumed by charts and reports.
// CONTEXT: Lives in _shared so multiple extensions reuse it. It does NOT fetch
//   the model itself (that needs an extension-scoped backend channel) — the
//   parent passes `biModel` (e.g. from get_connection_bi_model).

import React, { useEffect, useCallback } from "react";
import Editor, { type OnChange } from "@monaco-editor/react";
import {
  LANGUAGE_ID,
  registerPivotDslLanguage,
  setDslEditorContext,
} from "./pivotDslLanguage";
import type { BiPivotModelInfo } from "../../components/types";

interface DesignQueryEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** The BI model driving autocomplete (field + measure names). */
  biModel?: BiPivotModelInfo | null;
  /** Editor height (CSS). Defaults to 160px. */
  height?: string;
}

export function DesignQueryEditor({
  value,
  onChange,
  biModel,
  height = "160px",
}: DesignQueryEditorProps): React.ReactElement {
  useEffect(() => {
    registerPivotDslLanguage();
  }, []);

  // The DSL editor context is module-global (shared with the pivot Design view);
  // re-set it whenever the supplied model changes.
  useEffect(() => {
    setDslEditorContext([], biModel ?? undefined);
  }, [biModel]);

  const handleChange: OnChange = useCallback((v) => onChange(v ?? ""), [onChange]);

  return (
    <div
      style={{
        height,
        border: "1px solid var(--border-color)",
        borderRadius: "4px",
        overflow: "hidden",
      }}
    >
      <Editor
        height="100%"
        language={LANGUAGE_ID}
        theme="vs"
        value={value}
        onChange={handleChange}
        options={{
          minimap: { enabled: false },
          lineNumbers: "off",
          glyphMargin: false,
          folding: false,
          scrollBeyondLastLine: false,
          wordWrap: "on",
          fontSize: 12,
          lineHeight: 18,
          padding: { top: 8, bottom: 8 },
          renderLineHighlight: "none",
          overviewRulerLanes: 0,
          hideCursorInOverviewRuler: true,
          scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
          suggestOnTriggerCharacters: true,
          quickSuggestions: true,
          acceptSuggestionOnCommitCharacter: true,
          tabSize: 2,
        }}
      />
    </div>
  );
}
