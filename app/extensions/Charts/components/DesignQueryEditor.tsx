//! FILENAME: app/extensions/Charts/components/DesignQueryEditor.tsx
// PURPOSE: Monaco editor for a chart's "design query" DSL. Reuses the shared
//   pivot-layout-dsl language (syntax highlighting + autocomplete) and feeds
//   autocomplete the selected connection's BI model so field/measure names
//   suggest correctly.

import React, { useEffect, useCallback } from "react";
import Editor, { type OnChange } from "@monaco-editor/react";
import {
  LANGUAGE_ID,
  registerPivotDslLanguage,
  setDslEditorContext,
} from "../../_shared/dsl/pivotLayout/pivotDslLanguage";
import type { BiPivotModelInfo } from "../../_shared/components/types";
import { chartsBackend } from "../lib/chartsBackend";

interface DesignQueryEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** The BI connection whose model drives autocomplete (may be empty). */
  connectionId: string;
}

export function DesignQueryEditor({
  value,
  onChange,
  connectionId,
}: DesignQueryEditorProps): React.ReactElement {
  // Register the shared DSL language once.
  useEffect(() => {
    registerPivotDslLanguage();
  }, []);

  // Load the selected connection's model so autocomplete knows its tables and
  // measures. The DSL editor context is module-global (shared with the pivot
  // Design view), so it is re-set whenever the connection changes.
  useEffect(() => {
    let cancelled = false;
    if (!connectionId) {
      setDslEditorContext([], undefined);
      return;
    }
    chartsBackend
      .invoke<BiPivotModelInfo | null>("get_connection_bi_model", { connectionId })
      .then((model) => {
        if (!cancelled) setDslEditorContext([], model ?? undefined);
      })
      .catch(() => {
        if (!cancelled) setDslEditorContext([], undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId]);

  const handleChange: OnChange = useCallback(
    (v) => onChange(v ?? ""),
    [onChange],
  );

  return (
    <div
      style={{
        height: "160px",
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
          scrollbar: {
            verticalScrollbarSize: 8,
            horizontalScrollbarSize: 8,
          },
          suggestOnTriggerCharacters: true,
          quickSuggestions: true,
          acceptSuggestionOnCommitCharacter: true,
          tabSize: 2,
        }}
      />
    </div>
  );
}
