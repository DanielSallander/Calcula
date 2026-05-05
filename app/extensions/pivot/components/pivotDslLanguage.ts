//! FILENAME: app/extensions/Pivot/components/pivotDslLanguage.ts
// PURPOSE: Register a custom Monaco language for the Pivot Layout DSL.
// CONTEXT: Provides syntax highlighting and autocomplete for the Design editor.

import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import type { SourceField } from '../../_shared/components/types';
import type { BiPivotModelInfo } from './types';
import { AGGREGATION_NAMES, LAYOUT_DIRECTIVES, SHOW_VALUES_AS_NAMES } from '../dsl/tokens';

// Monaco worker setup (local, no CDN)
self.MonacoEnvironment = {
  getWorker() {
    return new editorWorker();
  },
};

loader.config({ monaco });

const LANGUAGE_ID = 'pivot-layout-dsl';
let languageRegistered = false;
let completionDisposable: monaco.IDisposable | null = null;

/** Mutable refs for autocomplete context (updated when pivot data changes). */
let currentSourceFields: SourceField[] = [];
let currentBiModel: BiPivotModelInfo | undefined;

/** Update the field context used for autocomplete suggestions. */
export function setDslEditorContext(
  sourceFields: SourceField[],
  biModel?: BiPivotModelInfo,
): void {
  currentSourceFields = sourceFields;
  currentBiModel = biModel;
}

/**
 * Scan backwards from the cursor position to find which clause the cursor is in.
 * Returns the clause name (e.g., "ROWS", "VALUES") or null if at top level.
 */
function findCurrentClause(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
): string | null {
  const clausePattern = /^\s*(ROWS|COLUMNS|VALUES|FILTERS|SORT|LAYOUT|CALC|TOP|BOTTOM|SAVE)\s*[:]/i;

  for (let line = position.lineNumber; line >= 1; line--) {
    const lineText = model.getLineContent(line);
    const match = clausePattern.exec(lineText);
    if (match) {
      return match[1].toUpperCase();
    }
  }
  return null;
}

/** Add field name suggestions from current context. */
function addFieldSuggestions(
  suggestions: monaco.languages.CompletionItem[],
  range: monaco.IRange,
  numericOnly: boolean,
): void {
  if (currentBiModel) {
    let tableIdx = 0;
    for (const table of currentBiModel.tables) {
      const prefix = String(tableIdx).padStart(2, '0');
      let colIdx = 0;
      for (const col of table.columns) {
        if (numericOnly && !col.isNumeric) continue;
        const fullName = `${table.name}.${col.name}`;
        suggestions.push({
          label: {
            label: fullName,
            description: table.name,
          },
          kind: monaco.languages.CompletionItemKind.Field,
          insertText: fullName,
          detail: col.dataType,
          sortText: `${prefix}_${String(colIdx).padStart(3, '0')}`,
          range,
        });
        colIdx++;
      }
      tableIdx++;
    }
  } else {
    for (const field of currentSourceFields) {
      if (numericOnly && !field.isNumeric) continue;
      suggestions.push({
        label: field.name,
        kind: monaco.languages.CompletionItemKind.Field,
        insertText: field.name.match(/[,:()=.\[\]"#\s]/) ? `"${field.name}"` : field.name,
        detail: field.isNumeric ? 'Numeric' : 'Text',
        range,
      });
    }
  }
}

/** Add clause keyword suggestions. */
function addClauseKeywords(
  suggestions: monaco.languages.CompletionItem[],
  range: monaco.IRange,
): void {
  const keywords = ['ROWS:', 'COLUMNS:', 'VALUES:', 'FILTERS:', 'SORT:', 'LAYOUT:', 'CALC:', 'TOP', 'SAVE AS'];
  for (const kw of keywords) {
    suggestions.push({
      label: kw,
      kind: monaco.languages.CompletionItemKind.Keyword,
      insertText: kw.endsWith(':') ? kw + ' ' : kw + ' ',
      range,
    });
  }
}

/**
 * Register the pivot-layout-dsl language and its providers.
 * Safe to call multiple times — language is registered once, completion
 * provider is replaced on each call to pick up code changes (HMR).
 */
export function registerPivotDslLanguage(): void {
  if (!languageRegistered) {
    languageRegistered = true;
    monaco.languages.register({ id: LANGUAGE_ID });

    // Monarch tokenizer (only needs registering once)
    monaco.languages.setMonarchTokensProvider(LANGUAGE_ID, {
      ignoreCase: true,
      tokenizer: {
        root: [
          [/#.*$/, 'comment'],
          [/"[^"]*"/, 'string'],
          [/\[[^\]]*\]/, 'string.special'],
          [/\b\d+(\.\d+)?\b/, 'number'],
          [/\b(ROWS|COLUMNS|VALUES|FILTERS|SORT|LAYOUT|CALC)\b/i, 'keyword'],
          [/\b(TOP|BOTTOM|SAVE)\b/i, 'keyword'],
          [/\b(AS|BY|VIA|LOOKUP|NOT|IN)\b/i, 'keyword.modifier'],
          [/\b(ASC|DESC)\b/i, 'keyword.sort'],
          [/\b(Sum|Count|Average|Min|Max|CountNumbers|StdDev|StdDevP|Var|VarP|Product)\s*(?=\()/i, 'type.identifier'],
          [/\b[a-zA-Z][\w]*(-[a-zA-Z][\w]*)+\b/, 'variable.predefined'],
          [/[A-Za-z_]\w*\.[A-Za-z_]\w*/, 'variable.name'],
          [/[A-Za-z_]\w*/, 'identifier'],
          [/[=,:()+\-*/^]/, 'delimiter'],
        ],
      },
    });
  }

  // Dispose previous completion provider (allows re-registration on HMR)
  if (completionDisposable) {
    completionDisposable.dispose();
    completionDisposable = null;
  }

  // Register completion provider
  completionDisposable = monaco.languages.registerCompletionItemProvider(LANGUAGE_ID, {
    triggerCharacters: [' ', ':', ',', '.', '(', '['],
    provideCompletionItems(model, position) {
      const lineText = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });

      const word = model.getWordUntilPosition(position);
      const range: monaco.IRange = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      const suggestions: monaco.languages.CompletionItem[] = [];
      const lineTrimmed = lineText.trim().toUpperCase();

      // Determine which clause the cursor is in
      const clause = findCurrentClause(model, position);

      // Inside aggregation parens (e.g., Sum(|)) → suggest fields
      if (/\(\s*$/.test(lineText)) {
        addFieldSuggestions(suggestions, range, true);
        return { suggestions };
      }

      // At line start with no clause context: suggest clause keywords
      if (lineTrimmed === '' || (lineTrimmed === word.word.toUpperCase() && !clause)) {
        addClauseKeywords(suggestions, range);
        return { suggestions };
      }

      // Context-specific suggestions
      switch (clause) {
        case 'ROWS':
        case 'COLUMNS':
        case 'FILTERS':
          addFieldSuggestions(suggestions, range, false);
          if (currentBiModel) {
            suggestions.push({
              label: 'LOOKUP',
              kind: monaco.languages.CompletionItemKind.Keyword,
              insertText: 'LOOKUP ',
              range,
            });
          }
          return { suggestions };

        case 'VALUES':
          // After a closing paren or bracket ] → suggest AS and show-values-as
          if (/(\)|\])\s*$/.test(lineText) || /\bAS\b/i.test(lineTrimmed)) {
            suggestions.push({
              label: 'AS "..."',
              kind: monaco.languages.CompletionItemKind.Keyword,
              insertText: 'AS "$0"',
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              range,
            });
            for (const [label] of SHOW_VALUES_AS_NAMES) {
              suggestions.push({
                label: `[${label}]`,
                kind: monaco.languages.CompletionItemKind.EnumMember,
                insertText: `[${label}]`,
                range,
              });
            }
            return { suggestions };
          }
          // Default: aggregation functions + BI measures
          for (const agg of AGGREGATION_NAMES) {
            const capLabel = agg.charAt(0).toUpperCase() + agg.slice(1);
            suggestions.push({
              label: `${capLabel}()`,
              kind: monaco.languages.CompletionItemKind.Function,
              insertText: `${capLabel}($0)`,
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              range,
            });
          }
          if (currentBiModel) {
            addMeasureSuggestions(suggestions, range);
          }
          return { suggestions };

        case 'SORT':
          addFieldSuggestions(suggestions, range, false);
          suggestions.push(
            { label: 'ASC', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'ASC', range },
            { label: 'DESC', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'DESC', range },
          );
          return { suggestions };

        case 'LAYOUT':
          for (const dir of LAYOUT_DIRECTIVES) {
            suggestions.push({
              label: dir,
              kind: monaco.languages.CompletionItemKind.EnumMember,
              insertText: dir,
              range,
            });
          }
          return { suggestions };

        case 'CALC':
          addFieldSuggestions(suggestions, range, false);
          return { suggestions };

        default:
          addClauseKeywords(suggestions, range);
          return { suggestions };
      }
    },
  });
}

/** Add BI measure suggestions grouped by table. */
function addMeasureSuggestions(
  suggestions: monaco.languages.CompletionItem[],
  range: monaco.IRange,
): void {
  if (!currentBiModel) return;

  // Group measures by table
  const measuresByTable = new Map<string, typeof currentBiModel.measures>();
  for (const m of currentBiModel.measures) {
    const table = m.table || '(Measures)';
    if (!measuresByTable.has(table)) {
      measuresByTable.set(table, []);
    }
    measuresByTable.get(table)!.push(m);
  }

  // Add measures with table grouping via sortText prefix
  let tableIdx = 0;
  for (const [table, measures] of measuresByTable) {
    const prefix = String(tableIdx).padStart(2, '0');
    for (let i = 0; i < measures.length; i++) {
      const m = measures[i];
      suggestions.push({
        label: {
          label: `[${m.name}]`,
          description: table,
        },
        kind: monaco.languages.CompletionItemKind.Value,
        insertText: `[${m.name}]`,
        detail: `${m.aggregation}(${m.sourceColumn})`,
        sortText: `${prefix}_${String(i).padStart(3, '0')}`,
        range,
      });
    }
    tableIdx++;
  }
}

export { LANGUAGE_ID };
