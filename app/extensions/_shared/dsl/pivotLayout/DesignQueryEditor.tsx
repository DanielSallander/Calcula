//! FILENAME: app/extensions/_shared/dsl/pivotLayout/DesignQueryEditor.tsx
// PURPOSE: Shared Monaco editor for pivot-layout "design query" DSL. Registers
//   the pivot-layout-dsl language (syntax highlighting + autocomplete) and feeds
//   autocomplete the caller-supplied BI model. Consumed by charts and reports.
// CONTEXT: Lives in _shared so multiple extensions reuse it. It does NOT fetch
//   the model itself (that needs an extension-scoped backend channel) — the
//   parent passes `biModel` (e.g. from get_connection_bi_model).

import React, { useEffect, useCallback, useRef, useState } from "react";
import Editor, { type OnChange, type OnMount } from "@monaco-editor/react";
import {
  LANGUAGE_ID,
  clearDslModelContext,
  registerPivotDslLanguage,
  setDslEditorContext,
  setDslControlHints,
  setDslModelContext,
  type DslControlHint,
} from "./pivotDslLanguage";
import { DescribeQueryPanel, type DesignQueryAssistHost } from "./describeQuery";
import { NextEditRow } from "./NextEditRow";
import { TOKENS } from "../../lib/themeTokens";
import type { BiPivotModelInfo } from "../../components/types";

interface DesignQueryEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** The BI model driving autocomplete (field + measure names). */
  biModel?: BiPivotModelInfo | null;
  /** Named controls / ribbon filters for `@Name` completion (Reports @param
   *  binding). Omit for editors that don't support @params (pivots, charts). */
  controlHints?: DslControlHint[];
  /** Editor height (CSS). Defaults to 160px. Ignored when `autoHeight` is set. */
  height?: string;
  /**
   * Size the editor to the query instead of pinning it, between two bounds.
   *
   * A fixed height is wrong in both directions here. A design query is usually
   * three to six lines, so 300px of box around 54px of text is mostly void —
   * and in a blade that void is doubled, because the conversation column
   * stretches to match and pushes its composer to the bottom of a mostly-empty
   * column. But the same editor has to hold a twenty-line query with FILTERS
   * and a CALC block without becoming a two-line slot.
   *
   * Computed from the LINE COUNT rather than measured, deliberately: Monaco
   * exposes a content height only after layout, reading it means a
   * `ResizeObserver` (absent in jsdom) and a second render pass, and the answer
   * is `lines × lineHeight` anyway for an editor with no wrapping widgets.
   */
  autoHeight?: { min: number; max: number };
  /**
   * When set, a "describe the report in words" row is shown above the editor
   * and a drafted query is put into it through `onChange`. The host supplies
   * the connection and, when it can, a dry run — the shared editor has no
   * backend channel of its own.
   */
  assist?: DesignQueryAssistHost;
  /**
   * The row of next-edit suggestions under the editor (rules over the
   * strategy; no model needed). On by default whenever a model is supplied,
   * because the rules read the strategy that rides on it.
   */
  suggest?: boolean;
  /**
   * Where the AI conversation goes.
   *
   * `inline` (default) stacks it above the editor — the original shape, and the
   * only one that fits a narrow task pane like the pivot's Design tab.
   *
   * `blade` puts it in its own column beside the editor. A transcript with a
   * side-by-side diff in it needs roughly as much width as the query does, and
   * stacking the two inside a 560px dialog left the diff clipped mid-line.
   *
   * THE BLADE WRAPS BY ITSELF. Both columns are `flex: 1 1 <basis>`, so when
   * the container is too narrow to hold both they fall back to stacked with no
   * media query, no `ResizeObserver` (jsdom has none) and no measurement pass.
   * A host may therefore ask for a blade without knowing how much room it will
   * actually get.
   */
  assistPlacement?: "inline" | "blade";
}

export function DesignQueryEditor({
  value,
  onChange,
  biModel,
  controlHints,
  height = "160px",
  assist,
  suggest,
  assistPlacement = "inline",
  autoHeight,
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

  // WHICH DOCUMENT THIS EDITOR'S SUGGESTIONS ARE ABOUT.
  //
  // Monaco registers providers per LANGUAGE, so the language module must be able
  // to map the model it is handed back to the host that owns it. This editor and
  // the pivot's Design tab can be open at once — a Reports dialog over a pivot —
  // and while the context was a single module-level "current model", the last
  // one to render won and the other autocompleted against the wrong schema.
  // Registering per model URI makes that impossible.
  const [modelUri, setModelUri] = useState<string | null>(null);
  const handleMount: OnMount = useCallback((editor) => {
    setModelUri(editor.getModel()?.uri?.toString() ?? null);
  }, []);

  // One dismissed set, shared by the chip row and the ghost text. Two sets would
  // mean dismissing a suggestion on the row and finding it still sitting in the
  // text, which is precisely the nagging the row was built to avoid.
  const dismissed = useRef<Set<string>>(new Set());

  const showSuggestions = suggest ?? Boolean(biModel);
  const connectionId = assist?.connectionId ?? biModel?.connectionId ?? "";

  useEffect(() => {
    // The fallback stays written for the window before this editor mounts.
    setDslEditorContext([], biModel ?? undefined, controlHints);
    if (!modelUri) return;
    setDslModelContext(modelUri, {
      sourceFields: [],
      biModel: biModel ?? undefined,
      controlHints: controlHints ?? [],
      connectionId,
      inlineNextEdits: showSuggestions,
      dismissed: dismissed.current,
    });
  }, [biModel, controlHints, modelUri, connectionId, showSuggestions]);

  useEffect(() => {
    if (!modelUri) return;
    return () => clearDslModelContext(modelUri);
  }, [modelUri]);
  useEffect(() => () => setDslControlHints([]), []);

  const handleChange: OnChange = useCallback((v) => onChange(v ?? ""), [onChange]);

  const assistPanel =
    assist && assist.connectionId ? (
      <DescribeQueryPanel
        biModel={biModel}
        host={assist}
        currentDsl={value}
        onApply={onChange}
        fill={assistPlacement === "blade"}
      />
    ) : null;

  // `lineHeight: 18` and `padding: { top: 8, bottom: 8 }` are set on the Editor
  // below; the +2 is the box's own border. One blank line of slack keeps the
  // caret off the bottom edge as the person types the next clause, so the box
  // grows a line AHEAD of the text rather than in lockstep with it.
  const fittedHeight = autoHeight
    ? `${Math.min(
        autoHeight.max,
        Math.max(autoHeight.min, (value.split("\n").length + 1) * 18 + 16 + 2),
      )}px`
    : height;

  const editorAndChips = (
    <>
    <div
      style={{
        height: fittedHeight,
        // `--border-color` was never a declared token, and with no fallback the
        // whole shorthand was invalid — so this box had NO border at all
        // wherever a skin did not happen to define one, which was everywhere.
        border: `1px solid ${TOKENS.border}`,
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
        onMount={handleMount}
        options={{
          // Ghost text for the next edit the strategy wants (Milestone C).
          // `mode` is left at its default `prefix`, which shows ghost text only
          // when the replaced text is a prefix of the suggestion — the reason
          // `nextEditInline` anchors an insertion to the line ABOVE it. A
          // suggestion that is NOT a prefix is declared `isInlineEdit` instead
          // and Monaco renders it as an edit with a jump, which is the
          // Next-Edit-Suggestion shape and needs no option here.
          inlineSuggest: { enabled: true, showToolbar: "onHover" },
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
    {showSuggestions ? (
      <NextEditRow
        text={value}
        biModel={biModel}
        connectionId={connectionId}
        onApply={onChange}
        dismissed={dismissed.current}
      />
    ) : null}
    </>
  );

  if (assistPlacement === "blade" && assistPanel) {
    return (
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 14,
          alignItems: "stretch",
          minHeight: 0,
        }}
        data-testid="design-query-blade-layout"
      >
        {/* The query keeps the larger basis: it is the thing being authored,
            and the conversation is how you get there. */}
        <div style={{ flex: "1 1 420px", minWidth: 0, display: "flex", flexDirection: "column" }}>
          {editorAndChips}
        </div>
        <div
          style={{ flex: "1 1 360px", minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}
          data-testid="design-query-blade"
        >
          {assistPanel}
        </div>
      </div>
    );
  }

  return (
    <>
      {assistPanel}
      {editorAndChips}
    </>
  );
}
