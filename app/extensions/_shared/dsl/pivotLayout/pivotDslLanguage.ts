//! FILENAME: app/extensions/Pivot/components/pivotDslLanguage.ts
// PURPOSE: Register a custom Monaco language for the Pivot Layout DSL.
// CONTEXT: Provides syntax highlighting and autocomplete for the Design editor.

import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import type { SourceField } from '../../components/types';
import type { BiPivotModelInfo } from '../../components/types';
import { AGGREGATION_NAMES, CALC_FUNCTION_ALIASES, LAYOUT_DIRECTIVES, SHOW_VALUES_AS_NAMES, TRANSFORM_FUNCTIONS, VISUAL_CALC_FUNCTIONS, VISUAL_CALC_RESET_OPTIONS } from './tokens';
import { BARE_PARAM_NAME_RE, paramReference } from './paramNames';
import { inlineItemsFor } from './nextEditInline';
import {
  dslContextForUri,
  type DslControlHint,
  type DslModelContext,
} from './dslModelContexts';

// The registry itself lives in `dslModelContexts` — no monaco import there, so
// it is unit-testable. These are the names the editors already import here.
export {
  clearDslModelContext,
  dslModelContextCount,
  setDslControlHints,
  setDslEditorContext,
  setDslModelContext,
  type DslControlHint,
  type DslModelContext,
} from './dslModelContexts';
import { compileDesignQuery } from './designQuery';

/**
 * How many ghost-text suggestions Monaco is offered at once: ONE.
 *
 * Monaco's handling of a list that mixes plain completions with inline EDITS is
 * not something to rely on — an inline edit and a ghost-text item cannot both be
 * rendered, and which survives is an implementation detail. One item is also
 * what the surface means: the next edit, where the cursor is. The row below the
 * editor is where a person sees the alternatives, with the reason for each.
 */
const MAX_INLINE_SUGGESTIONS = 1;

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
let inlineDisposable: monaco.IDisposable | null = null;

/** The context for a document: its own if registered, else the fallback. */
function contextFor(model: monaco.editor.ITextModel): DslModelContext {
  return dslContextForUri(model.uri?.toString());
}

/**
 * 0-based index of the `@` starting an in-progress param token at the END of
 * `lineText` (the text up to the cursor), or null when the cursor is not inside
 * one. Skips `@` inside quoted string values (with `""` escapes) and after an
 * unquoted `#` (trailing comment) — the same rules the Reports substitution uses.
 */
function findOpenParamToken(lineText: string): number | null {
  let inString = false;
  for (let i = 0; i < lineText.length; i++) {
    const ch = lineText[i];
    if (ch === '"') {
      if (inString && lineText[i + 1] === '"') {
        i++;
        continue;
      }
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '#') return null;
    if (ch !== '@') continue;

    if (lineText[i + 1] === '"') {
      const close = lineText.indexOf('"', i + 2);
      if (close === -1) return i; // open quoted param reaching the cursor
      i = close; // completed quoted param — keep scanning
    } else {
      const m = BARE_PARAM_NAME_RE.exec(lineText.slice(i + 1));
      const len = m ? m[0].length : 0;
      if (i + 1 + len === lineText.length) return i; // token reaches the cursor
      i += len; // completed bare token — keep scanning
    }
  }
  return null;
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
  ctx: DslModelContext,
  suggestions: monaco.languages.CompletionItem[],
  range: monaco.IRange,
  numericOnly: boolean,
): void {
  if (ctx.biModel) {
    // Calculation groups place as dimension fields (Power BI-style) — suggest
    // them alongside columns in ROWS/COLUMNS/FILTERS.
    if (!numericOnly) {
      for (const g of ctx.biModel.calculationGroups ?? []) {
        suggestions.push({
          label: { label: g.name, description: 'Calculation group' },
          kind: monaco.languages.CompletionItemKind.Class,
          insertText: g.name,
          detail: `${g.items.length} item${g.items.length === 1 ? '' : 's'}`,
          sortText: `00_calcgroup_${g.name}`,
          range,
        });
      }
    }
    let tableIdx = 0;
    for (const table of ctx.biModel.tables) {
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
    for (const field of ctx.sourceFields) {
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

/** Known aggregation function names (lowercase). */
const AGGREGATION_FUNC_NAMES = new Set([...AGGREGATION_NAMES]);

/** Known visual calc function names incl. engine aliases (lowercase). */
const VISUAL_CALC_FUNC_NAMES = new Set([...VISUAL_CALC_FUNCTIONS.keys(), ...CALC_FUNCTION_ALIASES.keys()]);

/**
 * Detect if the cursor is inside a function's parentheses.
 * Returns the function context or null if not inside parens.
 */
function detectFunctionContext(lineText: string): { isAggregation: boolean; isVisualCalc: boolean; argIndex: number } | null {
  // Walk backwards through the line to find the most recent unmatched '('
  let depth = 0;
  let commaCount = 0;
  for (let i = lineText.length - 1; i >= 0; i--) {
    const ch = lineText[i];
    if (ch === ')') depth++;
    else if (ch === '(') {
      if (depth > 0) {
        depth--;
      } else {
        // Found unmatched '(' — extract the function name before it
        const before = lineText.substring(0, i).trimEnd();
        const funcMatch = before.match(/([A-Za-z_]\w*)$/);
        if (funcMatch) {
          const funcName = funcMatch[1].toLowerCase();
          return {
            isAggregation: AGGREGATION_FUNC_NAMES.has(funcName),
            isVisualCalc: VISUAL_CALC_FUNC_NAMES.has(funcName),
            argIndex: commaCount,
          };
        }
        // Bare parens (not a function call) — treat as grouping
        return null;
      }
    } else if (ch === ',' && depth === 0) {
      commaCount++;
    }
  }
  return null;
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
          [/\b(RunningSum|MovingAverage|Previous|Next|First|Last|Parent|GrandTotal|Children|Leaves|Range|IsAtLevel|Lookup|LookupWithTotals|Collapse|CollapseAll|Expand|ExpandAll)\s*(?=\()/i, 'type.identifier'],
          [/\b(IF|SWITCH|AND|OR|NOT|ABS|ROUND|MIN|MAX|CEILING|FLOOR|SQRT|MOD|INT|SIGN|POWER|CONCAT|CONCATENATE|LEFT|RIGHT|MID|LEN|UPPER|LOWER|TRIM|TEXT)\s*(?=\()/i, 'type.identifier'],
          [/\b(HIGHESTPARENT|LOWESTPARENT|NONE)\b/i, 'keyword.modifier'],
          [/\b[a-zA-Z][\w]*(-[a-zA-Z][\w]*)+\b/, 'variable.predefined'],
          [/[A-Za-z_]\w*\.[A-Za-z_]\w*/, 'variable.name'],
          [/[A-Za-z_]\w*/, 'identifier'],
          [/(>=|<=|<>|>|<|=|&)/, 'operator'],
          [/[,:()+\-*/^]/, 'delimiter'],
        ],
      },
    });
  }

  // Dispose previous providers (allows re-registration on HMR). Both are
  // registered per LANGUAGE, so there is exactly one of each however many
  // editors are open; which document each answers for is decided by
  // `contextFor`, not by re-registering.
  if (completionDisposable) {
    completionDisposable.dispose();
    completionDisposable = null;
  }
  if (inlineDisposable) {
    inlineDisposable.dispose();
    inlineDisposable = null;
  }
  inlineDisposable = registerInlineNextEdits();

  // Register completion provider
  completionDisposable = monaco.languages.registerCompletionItemProvider(LANGUAGE_ID, {
    triggerCharacters: [' ', ':', ',', '.', '(', '[', '@'],
    provideCompletionItems(model, position) {
      // THIS document's context, not "whichever editor wrote last".
      const ctx = contextFor(model);
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

      // Replace-range for field/measure suggestions. Monaco's default word
      // breaks at '.' and '[', so accepting a full-key insert mid-token would
      // corrupt the text ("BI." + "BI.dim_customer.title", or "[[Revenue]").
      // Span the whole in-progress token instead: an unclosed [measure token
      // or a dotted identifier chain (table names can contain dots). Monaco
      // then also filters against the full typed token, so "BI.dim_customer."
      // narrows the list to that table's fields.
      const tokenMatch = lineText.match(/(\[[^\]]*|[A-Za-z_][\w.]*)$/);
      const fieldRange: monaco.IRange = tokenMatch
        ? {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: position.column - tokenMatch[1].length,
            endColumn: position.column,
          }
        : range;

      const suggestions: monaco.languages.CompletionItem[] = [];
      const lineTrimmed = lineText.trim().toUpperCase();

      // @Control param completion: a report's FILTERS line can bind a value to a
      // Controls-pane control or ribbon filter by name (e.g. `Category = @Region`
      // or `Products.Category = @"Products.Category"`). Fires when the cursor is
      // inside an in-progress `@` token — but not inside string values or
      // comments. Only the Reports editor supplies control hints, so this is
      // naturally inert in pivot/chart editors.
      if (ctx.controlHints.length > 0) {
        const atIdx = findOpenParamToken(lineText);
        if (atIdx !== null) {
          // Replace the WHOLE token including the '@' — the default word range
          // excludes '@' and breaks on '.', which would corrupt dotted names.
          const paramRange: monaco.IRange = {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: atIdx + 1, // columns are 1-based; atIdx is 0-based
            endColumn: position.column,
          };
          for (const hint of ctx.controlHints) {
            const insert = paramReference(hint.name);
            if (!insert) continue; // names containing '"' are not expressible
            suggestions.push({
              label: { label: `@${hint.name}`, description: hint.kind ?? 'control' },
              kind: monaco.languages.CompletionItemKind.Variable,
              insertText: insert,
              // The typed prefix ('@Reg' / '@Prod') must strong-match; without
              // filterText Monaco matches against the label from its first char
              // and drops these once the user types past the '@'.
              filterText: `@${hint.name}`,
              detail: hint.detail,
              sortText: `00_${hint.name}`,
              range: paramRange,
            });
          }
          return { suggestions };
        }
      }

      // Determine which clause the cursor is in.
      // Override to 'CALC' if the current line has an inline CALC expression
      // (e.g., "CALC test = PR" within a VALUES clause).
      let clause = findCurrentClause(model, position);
      if (/\bCALC\s+\w+\s*=/.test(lineText)) {
        clause = 'CALC';
      }

      // Inside function parens — detect context based on what function we're in
      // and which argument position (before or after a comma)
      const funcParenCtx = detectFunctionContext(lineText);
      if (funcParenCtx) {
        if (funcParenCtx.isVisualCalc && funcParenCtx.argIndex > 0) {
          // 2nd+ argument of a visual calc function → suggest reset options + numbers
          for (const opt of VISUAL_CALC_RESET_OPTIONS) {
            suggestions.push({
              label: opt.label,
              kind: monaco.languages.CompletionItemKind.EnumMember,
              insertText: opt.label,
              detail: opt.description,
              range,
            });
          }
          // Also suggest field names for field-level reset
          addFieldSuggestions(ctx, suggestions, fieldRange, false);
          return { suggestions };
        }
        // 1st argument (or aggregation function) → suggest fields + measures
        addFieldSuggestions(ctx, suggestions, fieldRange, funcParenCtx.isAggregation);
        if (ctx.biModel) {
          addMeasureSuggestions(ctx, suggestions, fieldRange);
        }
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
          addFieldSuggestions(ctx, suggestions, fieldRange, false);
          if (ctx.biModel) {
            suggestions.push({
              label: 'LOOKUP',
              kind: monaco.languages.CompletionItemKind.Keyword,
              insertText: 'LOOKUP ',
              range,
            });
          }
          if (clause !== 'FILTERS' && ctx.biModel) {
            // VIA Table.Column — relationship path for ambiguous joins
            suggestions.push({
              label: 'VIA',
              kind: monaco.languages.CompletionItemKind.Keyword,
              insertText: 'VIA ',
              detail: 'Resolve an ambiguous relationship path: Field VIA Orders.OrderDate',
              range,
            });
          }
          if (clause === 'FILTERS') {
            suggestions.push({
              label: 'NOT IN',
              kind: monaco.languages.CompletionItemKind.Keyword,
              insertText: 'NOT IN ("$0")',
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              detail: 'Exclude values: Field NOT IN ("A", "B")',
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
          // Default: CALC keyword + aggregation functions + BI measures
          suggestions.push({
            label: 'CALC',
            kind: monaco.languages.CompletionItemKind.Keyword,
            insertText: 'CALC ${1:Name} = $0',
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            detail: 'Inline calculated field: CALC Name = IF([Measure] > 0, ...)',
            sortText: '0_calc',
            range,
          });
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
          if (ctx.biModel) {
            addMeasureSuggestions(ctx, suggestions, fieldRange);
          }
          return { suggestions };

        case 'SORT':
          addFieldSuggestions(ctx, suggestions, fieldRange, false);
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
          // CALC expressions can reference dimensions, measures, and visual calc functions
          addFieldSuggestions(ctx, suggestions, fieldRange, false);
          if (ctx.biModel) {
            addMeasureSuggestions(ctx, suggestions, fieldRange);
          }
          // Transformation functions (IF/SWITCH/math/text) — post-aggregation.
          for (const [fn, desc] of TRANSFORM_FUNCTIONS) {
            const upperName = fn.toUpperCase();
            suggestions.push({
              label: { label: `${upperName}()`, description: 'Transform' },
              kind: monaco.languages.CompletionItemKind.Function,
              insertText: `${upperName}($0)`,
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              detail: desc,
              sortText: `00_${fn}`,
              range,
            });
          }
          // Visual calculation functions
          for (const [fn, desc] of VISUAL_CALC_FUNCTIONS) {
            const upperName = fn.toUpperCase();
            suggestions.push({
              label: { label: `${upperName}()`, description: 'Visual Calc' },
              kind: monaco.languages.CompletionItemKind.Function,
              insertText: `${upperName}($0)`,
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              detail: desc,
              sortText: `01_${fn}`,
              range,
            });
          }
          // Engine-supported aliases (COLLAPSE/COLLAPSEALL/EXPAND/EXPANDALL)
          for (const [fn, desc] of CALC_FUNCTION_ALIASES) {
            const upperName = fn.toUpperCase();
            suggestions.push({
              label: { label: `${upperName}()`, description: 'Visual Calc (alias)' },
              kind: monaco.languages.CompletionItemKind.Function,
              insertText: `${upperName}($0)`,
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              detail: desc,
              sortText: `01_${fn}`,
              range,
            });
          }
          // Reset parameter options (when inside a function after a comma)
          for (const opt of VISUAL_CALC_RESET_OPTIONS) {
            suggestions.push({
              label: opt.label,
              kind: monaco.languages.CompletionItemKind.EnumMember,
              insertText: opt.label,
              detail: opt.description,
              sortText: `02_${opt.label}`,
              range,
            });
          }
          return { suggestions };

        default:
          addClauseKeywords(suggestions, range);
          return { suggestions };
      }
    },
  });
}

/**
 * Ghost text for the next edit the strategy wants (Milestone C).
 *
 * EDIT-TRIGGERED, which is the whole point: Monaco asks this on every keystroke,
 * so a suggestion appears where the person is typing rather than waiting on a
 * row below. Two shapes come out of it, and the second is the one the owner's
 * original question was about:
 *
 *   AT THE CURSOR'S LINE — plain ghost text, accepted with Tab.
 *   AT ANOTHER LINE      — `isInlineEdit` plus a `hint` carrying
 *                          `jumpToEdit`, which Monaco renders as "there is an
 *                          edit over there" and jumps to on Tab. That is
 *                          Copilot's Next-Edit-Suggestion behaviour, and this
 *                          Monaco (0.55) implements it natively; nothing here
 *                          hand-rolls it out of decorations.
 *
 * NO MODEL IS ASKED. Milestone B measured the built-in 1.5B at 0 of 80 next
 * clauses, so ghost text from it would be wrong every time it appeared. These
 * come from the same rules, the same compile veto and the same edit functions
 * as the chip row — `inlineNextEdits` calls `rulesChips` — so the two surfaces
 * cannot propose different things, and a suggestion dismissed on the row is
 * dismissed here too through the shared `dismissed` set.
 */
function registerInlineNextEdits(): monaco.IDisposable {
  return monaco.languages.registerInlineCompletionsProvider(LANGUAGE_ID, {
    displayName: 'Calcula design-query suggestions',
    provideInlineCompletions(model, position) {
      const ctx = contextFor(model);
      if (!ctx.inlineNextEdits || !ctx.biModel) return { items: [] };
      const biModel = ctx.biModel;

      // EVERY decision is made by `inlineItemsFor`: which line, what replaces
      // it, ghost text or inline edit, hint or no hint. All that is left here is
      // turning a line number into a Monaco range, which needs the live model.
      // The split is what makes the behaviour testable — this module imports
      // `monaco-editor`, `@monaco-editor/react` and a `?worker` module, and a
      // test that mocked all three to assert a line number would be testing the
      // mocks.
      const decided = inlineItemsFor(
        model.getValue(),
        position.lineNumber,
        biModel,
        biModel.tables.map((t) => t.name),
        (dsl: string) => compileDesignQuery(dsl, ctx.connectionId ?? '', biModel),
        ctx.dismissed ?? new Set(),
        MAX_INLINE_SUGGESTIONS,
      );

      const items: monaco.languages.InlineCompletion[] = decided.map((item) => ({
        insertText: item.insertText,
        // The whole anchor line is replaced. A whole-line range always ends at
        // the end of a line, which is what lets `insertText` contain a break.
        range: {
          startLineNumber: item.line,
          startColumn: 1,
          endLineNumber: item.line,
          endColumn: model.getLineMaxColumn(item.line),
        },
        isInlineEdit: item.isInlineEdit,
        showInlineEditMenu: item.elsewhere,
        hint: item.elsewhere
          ? {
              range: {
                startLineNumber: position.lineNumber,
                startColumn: 1,
                endLineNumber: position.lineNumber,
                endColumn: model.getLineMaxColumn(position.lineNumber),
              },
              style: monaco.languages.InlineCompletionHintStyle.Label,
              content: item.label,
              jumpToEdit: true,
            }
          : undefined,
      }));
      return { items };
    },
    disposeInlineCompletions() {
      /* nothing retained: every item is rebuilt from the model's text */
    },
  });
}

/** Add BI measure suggestions grouped by table. */
function addMeasureSuggestions(
  ctx: DslModelContext,
  suggestions: monaco.languages.CompletionItem[],
  range: monaco.IRange,
): void {
  if (!ctx.biModel) return;

  // Group measures by table
  const measuresByTable = new Map<string, typeof ctx.biModel.measures>();
  for (const m of ctx.biModel.measures) {
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
