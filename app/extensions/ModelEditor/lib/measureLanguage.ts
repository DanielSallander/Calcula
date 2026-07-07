//! FILENAME: app/extensions/ModelEditor/lib/measureLanguage.ts
// PURPOSE: A focused Monaco language for the model-measure formula editor:
//          highlights VAR/GVAR/RETURN + function calls + Table[Column] / [Measure]
//          references, and offers keyword autocomplete + hover tooltips (the GVAR
//          entry carries the canonical "% of grand total" snippet + docs).
// CONTEXT: Used by MeasureEditorModal (BI measures). GVAR is the query-scoped
//          sibling of VAR — evaluated once per query, ignoring the row axis,
//          respecting slicers. See docs/guide/gvar-query-scoped-variables.md.

import * as monaco from "monaco-editor";
import type { FunctionDefDto } from "@api";

export const MEASURE_LANGUAGE_ID = "calcula-measure";

// ============================================================================
// Live editor context (functions + model schema), fed from the model overview.
// The providers are registered once per window and read this module-level
// state, so refreshing the context updates completion/hover without
// re-registering.
// ============================================================================

export interface MeasureLanguageContext {
  /** Tables and their column names (physical + calculated). */
  tables: { name: string; columns: string[] }[];
  /** Measure names (offered as `[Measure]` references). */
  measures: string[];
}

let functionCatalog: FunctionDefDto[] = [];
let modelContext: MeasureLanguageContext = { tables: [], measures: [] };

/** Feed the editor the engine function catalog + the current model schema so
 *  completion/hover/signature help reflect the live model. */
export function setMeasureLanguageContext(
  catalog: FunctionDefDto[],
  context: MeasureLanguageContext,
): void {
  functionCatalog = catalog;
  modelContext = context;
}

/** Block / query keywords highlighted like VAR. Uppercase; tokenizer is case-insensitive. */
const KEYWORDS = [
  "VAR",
  "GVAR",
  "RETURN",
  "IN",
  "AS",
  "BY",
  "ORDER",
  "ORDERBY",
  "PARTITIONBY",
  "ROWS",
  "NOT",
  "AND",
  "OR",
  "TRUE",
  "FALSE",
];

/** Docs for the block keywords — surfaced as autocomplete + hover tooltips. */
export const KEYWORD_DOCS: Record<
  string,
  { detail: string; markdown: string; snippet?: string }
> = {
  VAR: {
    detail: "variable (per row)",
    markdown:
      "**VAR** — declares a variable inside a `VAR … RETURN` block. Inlined and " +
      "re-evaluated for every group / visual row.\n\n```\nVAR total = SUM(Sales[amount])\nRETURN total * 1.1\n```",
  },
  GVAR: {
    detail: "query-scoped variable",
    markdown:
      "**GVAR** — a *query-scoped* variable. Evaluated **once per query**, under the " +
      "query's outer filter/slicer context and active RLS role, but **without the group-by / " +
      "row axis**, then substituted as a constant everywhere it is referenced. It still " +
      "respects slicers — it only drops the row axis (it is not an absolute constant).\n\n" +
      "Use it to compare each row to a whole-context value (grand total, max date, threshold):\n\n" +
      "```\nGVAR grand = SUM(Sales[amount])\nRETURN DIVIDE(SUM(Sales[amount]), grand)\n```\n\n" +
      "With a plain `VAR`, `grand` would be recomputed per group and the ratio would be `1.0` " +
      "everywhere; with `GVAR`, each row shows its share of the total.",
    snippet:
      "GVAR ${1:grand} = SUM(${2:Table}[${3:amount}])\nRETURN DIVIDE(SUM(${2:Table}[${3:amount}]), ${1:grand})",
  },
  RETURN: {
    detail: "block result",
    markdown: "**RETURN** — the result expression of a `VAR`/`GVAR … RETURN` block.",
  },
};

let registered = false;

/**
 * Register the measure-formula language + providers. Safe to call repeatedly —
 * only registers once per window.
 */
export function registerMeasureLanguage(): void {
  if (registered) return;
  registered = true;

  monaco.languages.register({ id: MEASURE_LANGUAGE_ID });

  monaco.languages.setLanguageConfiguration(MEASURE_LANGUAGE_ID, {
    brackets: [
      ["(", ")"],
      ["[", "]"],
    ],
    autoClosingPairs: [
      { open: "(", close: ")" },
      { open: "[", close: "]" },
      { open: '"', close: '"' },
    ],
    surroundingPairs: [
      { open: "(", close: ")" },
      { open: "[", close: "]" },
      { open: '"', close: '"' },
    ],
  });

  monaco.languages.setMonarchTokensProvider(MEASURE_LANGUAGE_ID, {
    ignoreCase: true,
    keywords: KEYWORDS,
    tokenizer: {
      root: [
        [/"[^"]*"/, "string"],
        [/\b\d+(\.\d+)?([eE][+-]?\d+)?\b/, "number"],
        // Function call: NAME immediately followed by '('
        [/[A-Za-z_][\w.]*(?=\s*\()/, "type.identifier"],
        // Keywords vs bare identifiers (table names)
        [
          /[A-Za-z_]\w*/,
          { cases: { "@keywords": "keyword", "@default": "identifier" } },
        ],
        // [Name] — measure reference (no table prefix); the highlighter can't tell
        // a measure ref from a column ref without a prefix, so it colours both.
        [/\[[^\]]*\]/, "variable.name"],
        [/[+\-*/^&]|!=|>=|<=|[<>=]/, "operator"],
        [/[,;()]/, "delimiter"],
        [/\s+/, "white"],
      ],
    },
  });

  // Context-aware autocomplete: keywords + engine functions + table names, and
  // — inside `[…]` — the columns of the preceding table (or measure names for a
  // bare `[`).
  monaco.languages.registerCompletionItemProvider(MEASURE_LANGUAGE_ID, {
    triggerCharacters: ["[", "(", "."],
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      const lineText = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });
      const suggestions: monaco.languages.CompletionItem[] = [];

      // Inside an unclosed `[` → column or measure references.
      const lastOpen = lineText.lastIndexOf("[");
      const lastClose = lineText.lastIndexOf("]");
      if (lastOpen > lastClose) {
        const bracketRange = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: lastOpen + 2,
          endColumn: position.column,
        };
        const tableMatch = /([A-Za-z_]\w*)\s*$/.exec(lineText.slice(0, lastOpen));
        const table = tableMatch
          ? modelContext.tables.find((t) => t.name === tableMatch[1])
          : undefined;
        if (table) {
          for (const col of table.columns) {
            suggestions.push({
              label: col,
              kind: monaco.languages.CompletionItemKind.Field,
              insertText: col,
              sortText: "1col_" + col,
              range: bracketRange,
            });
          }
        } else {
          for (const m of modelContext.measures) {
            suggestions.push({
              label: m,
              kind: monaco.languages.CompletionItemKind.Variable,
              detail: "measure",
              insertText: m,
              sortText: "1meas_" + m,
              range: bracketRange,
            });
          }
        }
        return { suggestions };
      }

      // Otherwise: keywords, functions, then table names.
      for (const [kw, doc] of Object.entries(KEYWORD_DOCS)) {
        suggestions.push({
          label: kw,
          kind: monaco.languages.CompletionItemKind.Keyword,
          detail: doc.detail,
          documentation: { value: doc.markdown },
          insertText: doc.snippet ?? kw + " ",
          insertTextRules: doc.snippet
            ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
            : undefined,
          sortText: "0kw_" + kw,
          range,
        });
      }
      for (const f of functionCatalog) {
        suggestions.push({
          label: f.name,
          kind: monaco.languages.CompletionItemKind.Function,
          detail: f.signature,
          documentation: { value: `**${f.name}** — ${f.description}\n\n\`${f.signature}\`` },
          insertText: f.name + "(",
          sortText: "2fn_" + f.name,
          range,
        });
      }
      for (const t of modelContext.tables) {
        suggestions.push({
          label: t.name,
          kind: monaco.languages.CompletionItemKind.Struct,
          detail: "table",
          insertText: t.name,
          sortText: "3tbl_" + t.name,
          range,
        });
      }
      return { suggestions };
    },
  });

  // Hover: block keywords + engine functions.
  monaco.languages.registerHoverProvider(MEASURE_LANGUAGE_ID, {
    provideHover(model, position) {
      const word = model.getWordAtPosition(position);
      if (!word) return null;
      const wordRange = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      const kwDoc = KEYWORD_DOCS[word.word.toUpperCase()];
      if (kwDoc) return { range: wordRange, contents: [{ value: kwDoc.markdown }] };
      const fn = functionCatalog.find((f) => f.name.toUpperCase() === word.word.toUpperCase());
      if (fn) {
        return {
          range: wordRange,
          contents: [{ value: `**${fn.name}**\n\n${fn.description}\n\n\`${fn.signature}\`` }],
        };
      }
      return null;
    },
  });

  // Signature help: show the enclosing function's signature while typing args.
  monaco.languages.registerSignatureHelpProvider(MEASURE_LANGUAGE_ID, {
    signatureHelpTriggerCharacters: ["(", ","],
    signatureHelpRetriggerCharacters: [","],
    provideSignatureHelp(model, position) {
      const lineText = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });
      const call = enclosingCall(lineText);
      if (!call) return null;
      const def = functionCatalog.find(
        (f) => f.name.toUpperCase() === call.name.toUpperCase(),
      );
      if (!def) return null;
      return {
        value: {
          signatures: [
            {
              label: def.signature,
              documentation: { value: def.description },
              parameters: [],
            },
          ],
          activeSignature: 0,
          activeParameter: call.argIndex,
        },
        dispose: () => {},
      };
    },
  });
}

/** Find the function call enclosing the end of `text` and which argument index
 *  the cursor is in (walks back tracking paren depth). */
function enclosingCall(text: string): { name: string; argIndex: number } | null {
  let depth = 0;
  let argIndex = 0;
  for (let i = text.length - 1; i >= 0; i--) {
    const c = text[i];
    if (c === ")") depth++;
    else if (c === "(") {
      if (depth === 0) {
        const m = /([A-Za-z_]\w*)\s*$/.exec(text.slice(0, i));
        return m ? { name: m[1], argIndex } : null;
      }
      depth--;
    } else if (c === "," && depth === 0) {
      argIndex++;
    }
  }
  return null;
}
