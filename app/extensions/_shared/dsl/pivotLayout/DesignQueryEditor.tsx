//! FILENAME: app/extensions/_shared/dsl/pivotLayout/DesignQueryEditor.tsx
// PURPOSE: Shared Monaco editor for pivot-layout "design query" DSL. Registers
//   the pivot-layout-dsl language (syntax highlighting + autocomplete) and feeds
//   autocomplete the caller-supplied BI model. Consumed by charts and reports.
// CONTEXT: Lives in _shared so multiple extensions reuse it. It does NOT fetch
//   the model itself (that needs an extension-scoped backend channel) — the
//   parent passes `biModel` (e.g. from get_connection_bi_model).

import React, { useEffect, useCallback, useRef } from "react";
import Editor, { type OnChange } from "@monaco-editor/react";
import {
  LANGUAGE_ID,
  registerPivotDslLanguage,
  setDslEditorContext,
  setDslControlHints,
  type DslControlHint,
} from "./pivotDslLanguage";
import type { BiPivotModelInfo } from "../../components/types";

interface DesignQueryEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** The BI model driving autocomplete (field + measure names). */
  biModel?: BiPivotModelInfo | null;
  /** Named controls / ribbon filters for `@Name` completion (Reports @param
   *  binding). Omit for editors that don't support @params (pivots, charts). */
  controlHints?: DslControlHint[];
  /** Editor height (CSS). Defaults to 160px. */
  height?: string;
}

export function DesignQueryEditor({
  value,
  onChange,
  biModel,
  controlHints,
  height = "160px",
}: DesignQueryEditorProps): React.ReactElement {
  useEffect(() => {
    registerPivotDslLanguage();
  }, []);

  // Host node for Monaco's overflow widgets (suggest list, hover), attached
  // directly to document.body. Dialogs center themselves with a CSS transform,
  // and a transformed ancestor re-bases position:fixed descendants — Monaco's
  // viewport coordinates would land offset (bottom-right of the screen).
  // Rendering the widgets from an untransformed body child keeps fixed
  // coordinates true viewport coordinates. The "monaco-editor" class scopes
  // Monaco's widget CSS; z-index sits above dialogs (1051).
  const overflowNodeRef = useRef<HTMLDivElement | null>(null);
  if (overflowNodeRef.current === null) {
    const node = document.createElement("div");
    node.className = "monaco-editor";
    node.style.zIndex = "10000";
    node.style.position = "fixed";
    node.style.top = "0";
    node.style.left = "0";
    overflowNodeRef.current = node;
  }
  useEffect(() => {
    const node = overflowNodeRef.current;
    if (node) document.body.appendChild(node);
    return () => {
      node?.remove();
    };
  }, []);

  // The DSL editor context is module-global (shared with the pivot Design view);
  // re-set it whenever the supplied model or control hints change, and clear the
  // hints on unmount so they never leak into a pivot/chart editor that reuses
  // the shared language module.
  useEffect(() => {
    setDslEditorContext([], biModel ?? undefined, controlHints);
  }, [biModel, controlHints]);
  useEffect(() => () => setDslControlHints([]), []);

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
          // Render suggest/hover widgets position:fixed so they escape the
          // editor box and the host dialog instead of being clipped by them.
          fixedOverflowWidgets: true,
          overflowWidgetsDomNode: overflowNodeRef.current ?? undefined,
        }}
      />
    </div>
  );
}
