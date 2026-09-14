//! FILENAME: app/extensions/Pivot/components/DesignEditor.tsx
// PURPOSE: Monaco-based DSL editor for the "Design" tab of the pivot field pane.
// CONTEXT: Parses DSL text in real-time, compiles to zone state, and shows inline errors.

import React, { useRef, useEffect, useCallback, useState } from 'react';
import Editor, { type OnMount, type OnChange } from '@monaco-editor/react';
import type * as monaco from 'monaco-editor';
import { processDsl, serialize, type CompileContext } from '../../_shared/dsl/pivotLayout';
import { getControlValue, type ControlValue } from '@api/controlValues';
import { LANGUAGE_ID, clearDslModelContext, registerPivotDslLanguage, setDslEditorContext, setDslModelContext } from '../../_shared/dsl/pivotLayout/pivotDslLanguage';
import { DescribeQueryPanel } from '../../_shared/dsl/pivotLayout/describeQuery';
import { NextEditRow } from '../../_shared/dsl/pivotLayout/NextEditRow';
import type { SourceField, ZoneField } from '../../_shared/components/types';
import type { LayoutConfig, BiPivotModelInfo, CalculatedFieldDef, ValueColumnRefDef } from './types';
import type { DslError } from '../../_shared/dsl/pivotLayout/errors';

/**
 * Field parameters: resolve an `@CONTROL(name)` DSL reference to the named
 * control's current value as text (mirrors pivot-api's resolver).
 */
function resolveControl(name: string): string | undefined {
  const v: ControlValue | undefined = getControlValue(name);
  if (!v) return undefined;
  switch (v.kind) {
    case 'text':
      return v.value;
    case 'number':
      return String(v.value);
    case 'boolean':
      return v.value ? 'TRUE' : 'FALSE';
    case 'textList':
      return v.value.join(', ');
    default:
      return undefined;
  }
}

interface DesignEditorProps {
  sourceFields: SourceField[];
  biModel?: BiPivotModelInfo;
  /** Current zone state — serialized to DSL text when the editor needs syncing. */
  rows: ZoneField[];
  columns: ZoneField[];
  values: ZoneField[];
  filters: ZoneField[];
  layout: LayoutConfig;
  /** Map from filter field name to all unique values, for smart serialization. */
  filterUniqueValues: Map<string, string[]>;
  /** Calculated fields to include in serialization. */
  calculatedFields?: CalculatedFieldDef[];
  /** Callback to apply compiled DSL state to the pivot editor. */
  onZoneStateChange: (
    rows: ZoneField[],
    columns: ZoneField[],
    values: ZoneField[],
    filters: ZoneField[],
    layout: LayoutConfig,
    calculatedFields?: CalculatedFieldDef[],
    valueColumnOrder?: ValueColumnRefDef[],
  ) => void;
  /** Called when a SAVE AS clause is compiled from user-typed DSL. */
  onSaveAs?: (name: string, dslText: string) => void;
  /** Called when DSL text changes (for toolbar sync). */
  onDslTextChange?: (text: string, saveAsName?: string) => void;
  /** When set, programmatically loads this DSL text into the editor. */
  externalDslText?: string | null;
  /** Whether this tab is currently visible. */
  isActive: boolean;
}

export function DesignEditor({
  sourceFields,
  biModel,
  rows,
  columns,
  values,
  filters,
  layout,
  filterUniqueValues,
  calculatedFields,
  onZoneStateChange,
  onSaveAs,
  onDslTextChange,
  externalDslText,
  isActive,
}: DesignEditorProps): React.ReactElement {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof monaco | null>(null);

  // When true, the next onChange should be ignored because it was triggered
  // by a programmatic text update (pushEditOperations / setValue), not user typing.
  const isProgrammaticEdit = useRef(false);

  // Debounce timer for compiling on text change
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track the last serialized text to avoid unnecessary updates
  const lastSerializedText = useRef<string>('');

  // Track whether the zone state was last set by the DSL editor (to prevent
  // the serialization useEffect from overwriting the editor text on the
  // state change that the editor itself caused).
  const editorIsSource = useRef(false);

  // The editor's current text, for the suggestion row. Monaco owns the buffer;
  // this mirrors it on every change, programmatic or typed.
  const [dslText, setDslText] = useState('');
  // The mounted document's URI, so the language module knows which editor's
  // suggestions it is being asked for. Known only after mount.
  const [dslModelUri, setDslModelUri] = useState<string | null>(null);
  // One dismissed set for the chip row AND the ghost text: dismissing a
  // suggestion on the row must not leave it sitting in the text.
  const dismissedSuggestions = useRef<Set<string>>(new Set());

  // The strategy the assistant rows read arrives ON `biModel`: `PivotEditor`
  // passes its live connection-level model (`fieldListModel`), which carries
  // the summary a pivot's cached metadata never has. This component fetched it
  // itself for one afternoon, which was a second full-model round trip on every
  // pivot open, went stale when the model changed, and — because it did not
  // clear the previous value first — could hand one connection's strategy to
  // another connection's pivot. The parent's fetch already solves all three.

  // Register the language once
  useEffect(() => {
    registerPivotDslLanguage();
  }, []);

  // Update autocomplete context when fields change.
  //
  // The fallback write stays for the window before Monaco mounts; the per-model
  // registration is what the providers actually read. Both this tab and a
  // Reports dialog can be open at once, and while the context was one
  // module-level "current model" the last render won and one editor
  // autocompleted against the other's schema.
  useEffect(() => {
    setDslEditorContext(sourceFields, biModel);
    if (!dslModelUri) return;
    setDslModelContext(dslModelUri, {
      sourceFields,
      biModel,
      controlHints: [],
      connectionId: biModel?.connectionId ?? '',
      // Ghost text needs a model to read the strategy from; a range pivot has
      // neither, exactly as the chip row below already decides.
      inlineNextEdits: Boolean(biModel),
      dismissed: dismissedSuggestions.current,
    });
  }, [sourceFields, biModel, dslModelUri]);

  useEffect(() => {
    if (!dslModelUri) return;
    return () => clearDslModelContext(dslModelUri);
  }, [dslModelUri]);

  // Sync visual editor state -> DSL text when the tab becomes active
  // or when zone state changes externally (from the Fields tab).
  useEffect(() => {
    if (!isActive) return;

    // If the editor itself caused this state change, don't re-serialize
    if (editorIsSource.current) {
      editorIsSource.current = false;
      return;
    }

    const text = serialize(rows, columns, values, filters, layout, { biModel, filterUniqueValues, calculatedFields });
    if (text === lastSerializedText.current) return;
    lastSerializedText.current = text;
    setDslText(text);

    const editor = editorRef.current;
    if (editor) {
      const model = editor.getModel();
      if (model) {
        // Mark as programmatic so onChange ignores this change
        isProgrammaticEdit.current = true;
        const fullRange = model.getFullModelRange();
        model.pushEditOperations(
          [],
          [{ range: fullRange, text }],
          () => null,
        );
      }
    }
  }, [isActive, rows, columns, values, filters, layout, biModel]);

  // Handle external DSL text injection (from Load Layout toolbar)
  useEffect(() => {
    if (externalDslText == null) return;
    const editor = editorRef.current;
    if (!editor) return;
    const model = editor.getModel();
    if (!model) return;

    // Clear the programmatic flag so onChange will compile this change.
    // The sync effect may have set it to true in the same render batch.
    isProgrammaticEdit.current = false;
    lastSerializedText.current = externalDslText;
    setDslText(externalDslText);
    const fullRange = model.getFullModelRange();
    model.pushEditOperations(
      [],
      [{ range: fullRange, text: externalDslText }],
      () => null,
    );
  }, [externalDslText]);

  // A drafted query from the "describe it in words" row, or a query with a
  // suggested edit accepted: loaded the way Load Layout loads text, so
  // onChange compiles it and the markers show.
  const applyDraft = useCallback((dsl: string) => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    isProgrammaticEdit.current = false;
    lastSerializedText.current = dsl;
    setDslText(dsl);
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: dsl }], () => null);
  }, []);

  // When the Design tab becomes active, tell Monaco to recalculate its layout.
  // Monaco doesn't handle display:none -> display:flex transitions on its own.
  useEffect(() => {
    if (isActive && editorRef.current) {
      // Small delay to ensure the DOM has reflowed
      requestAnimationFrame(() => {
        editorRef.current?.layout();
      });
    }
  }, [isActive]);

  const handleEditorMount: OnMount = useCallback((editor, monacoInstance) => {
    editorRef.current = editor;
    monacoRef.current = monacoInstance;
    setDslModelUri(editor.getModel()?.uri?.toString() ?? null);

    // Set initial content by serializing current zone state
    const text = serialize(rows, columns, values, filters, layout, { biModel, filterUniqueValues, calculatedFields });
    lastSerializedText.current = text;
    setDslText(text);
    // setValue during mount doesn't trigger onChange (listener not attached yet)
    editor.setValue(text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleEditorChange: OnChange = useCallback((value) => {
    setDslText(value ?? '');
    if (!value) return;

    // If this change was triggered by programmatic text sync (not user typing),
    // skip compilation. This prevents the serialization -> compile -> setAllZones
    // loop that was overwriting filter state and other zone data.
    if (isProgrammaticEdit.current) {
      isProgrammaticEdit.current = false;
      return;
    }

    // Clear previous debounce
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
    }

    // Debounce: compile after 300ms of inactivity
    debounceTimer.current = setTimeout(() => {
      const ctx: CompileContext = { sourceFields, biModel, filterUniqueValues, resolveControl };
      const result = processDsl(value, ctx);

      // Update Monaco markers for errors
      const monacoInstance = monacoRef.current;
      const editor = editorRef.current;
      if (monacoInstance && editor) {
        const model = editor.getModel();
        if (model) {
          const markers = result.errors.map(errToMarker(monacoInstance));
          monacoInstance.editor.setModelMarkers(model, 'pivot-dsl', markers);
        }
      }

      // If there are no hard parse errors, apply the compiled state
      const hasParseErrors = result.parseErrors.some(e => e.severity === 'error');
      if (!hasParseErrors) {
        editorIsSource.current = true;
        lastSerializedText.current = value;
        onZoneStateChange(
          result.rows,
          result.columns,
          result.values,
          result.filters,
          result.layout,
          result.calculatedFields.length > 0 ? result.calculatedFields : undefined,
          result.valueColumnOrder.length > 0 ? result.valueColumnOrder : undefined,
        );

        // Notify parent about SAVE AS clause
        if (result.saveAs && onSaveAs) {
          onSaveAs(result.saveAs, value);
        }
      }

      // Notify parent about current DSL text (for toolbar sync)
      if (onDslTextChange) {
        onDslTextChange(value, result.saveAs);
      }
    }, 300);
  }, [sourceFields, biModel, onZoneStateChange, onSaveAs, onDslTextChange]);

  // Cleanup debounce timer
  useEffect(() => {
    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
    };
  }, []);

  return (
    <div style={{
      flex: 1,
      display: isActive ? 'flex' : 'none',
      flexDirection: 'column',
      overflow: 'hidden',
    }}>
      {/* Model pivots only: a range pivot has no BI model to draft against. The
          pivot compiles live, so no dry run is needed here. */}
      {biModel ? (
        <DescribeQueryPanel
          biModel={biModel}
          host={{ connectionId: biModel.connectionId ?? '' }}
          currentDsl={dslText}
          onApply={applyDraft}
        />
      ) : null}
    {/* `minHeight: 0` is load-bearing here and was not before. A flex child's
        default `min-height: auto` refuses to shrink below its content, so with
        a transcript above it this column would push the editor past the pane
        and clip it rather than sharing the space. */}
    <div style={{
      flex: 1,
      minHeight: 0,
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      border: '1px solid #d0d7de',
      borderRadius: '4px',
    }}>
      <Editor
        height="100%"
        language={LANGUAGE_ID}
        theme="vs"
        onMount={handleEditorMount}
        onChange={handleEditorChange}
        options={{
          // Ghost text for the next edit the strategy wants (Milestone C).
          inlineSuggest: { enabled: true, showToolbar: 'onHover' },
          minimap: { enabled: false },
          lineNumbers: 'off',
          glyphMargin: false,
          folding: false,
          scrollBeyondLastLine: false,
          wordWrap: 'on',
          fontSize: 12,
          lineHeight: 18,
          padding: { top: 8, bottom: 8 },
          renderLineHighlight: 'none',
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
    {/* The next-edit suggestions (rules over the strategy). Model pivots only:
        a range pivot has no strategy and no measures for the rules to read. */}
    {biModel ? (
      <NextEditRow
        text={dslText}
        biModel={biModel}
        connectionId={biModel.connectionId ?? ''}
        onApply={applyDraft}
        dismissed={dismissedSuggestions.current}
      />
    ) : null}
    </div>
  );
}

/** Convert a DslError to a Monaco marker. */
function errToMarker(monacoInstance: typeof monaco) {
  return (err: DslError): monaco.editor.IMarkerData => {
    const severity = err.severity === 'error'
      ? monacoInstance.MarkerSeverity.Error
      : err.severity === 'warning'
        ? monacoInstance.MarkerSeverity.Warning
        : monacoInstance.MarkerSeverity.Info;

    return {
      severity,
      message: err.message,
      startLineNumber: err.location.line,
      startColumn: err.location.column + 1, // Monaco is 1-based
      endLineNumber: err.location.line,
      endColumn: err.location.endColumn + 1,
    };
  };
}
