//! FILENAME: app/extensions/Pivot/components/DesignEditor.tsx
// PURPOSE: Monaco-based DSL editor for the "Design" tab of the pivot field pane.
// CONTEXT: Parses DSL text in real-time, compiles to zone state, and shows inline errors.

import React, { useRef, useEffect, useCallback } from 'react';
import Editor, { type OnMount, type OnChange } from '@monaco-editor/react';
import type * as monaco from 'monaco-editor';
import { processDsl, serialize, type CompileContext } from '../dsl';
import { LANGUAGE_ID, registerPivotDslLanguage, setDslEditorContext } from './pivotDslLanguage';
import type { SourceField, ZoneField } from '../../_shared/components/types';
import type { LayoutConfig, BiPivotModelInfo, CalculatedFieldDef, ValueColumnRefDef } from './types';
import type { DslError } from '../dsl/errors';

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

  // Register the language once
  useEffect(() => {
    registerPivotDslLanguage();
  }, []);

  // Update autocomplete context when fields change
  useEffect(() => {
    setDslEditorContext(sourceFields, biModel);
  }, [sourceFields, biModel]);

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

    // Set initial content by serializing current zone state
    const text = serialize(rows, columns, values, filters, layout, { biModel, filterUniqueValues, calculatedFields });
    lastSerializedText.current = text;
    // setValue during mount doesn't trigger onChange (listener not attached yet)
    editor.setValue(text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleEditorChange: OnChange = useCallback((value) => {
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
      const ctx: CompileContext = { sourceFields, biModel, filterUniqueValues };
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
      }
    }, 300);
  }, [sourceFields, biModel, onZoneStateChange]);

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
