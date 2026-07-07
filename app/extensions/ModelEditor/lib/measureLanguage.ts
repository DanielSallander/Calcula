//! FILENAME: app/extensions/ModelEditor/lib/measureLanguage.ts
// PURPOSE: A focused Monaco language for the model-measure formula editor:
//          highlights VAR/GVAR/RETURN + function calls + Table[Column] / [Measure]
//          references, and offers keyword autocomplete + hover tooltips (the GVAR
//          entry carries the canonical "% of grand total" snippet + docs).
// CONTEXT: Used by MeasureEditorModal (BI measures). GVAR is the query-scoped
//          sibling of VAR — evaluated once per query, ignoring the row axis,
//          respecting slicers. See docs/guide/gvar-query-scoped-variables.md.

import * as monaco from "monaco-editor";

export const MEASURE_LANGUAGE_ID = "calcula-measure";

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

  // Keyword autocomplete (VAR / GVAR / RETURN). GVAR expands the %-of-total snippet.
  monaco.languages.registerCompletionItemProvider(MEASURE_LANGUAGE_ID, {
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      const suggestions: monaco.languages.CompletionItem[] = [];
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
      return { suggestions };
    },
  });

  // Hover tooltips for the block keywords.
  monaco.languages.registerHoverProvider(MEASURE_LANGUAGE_ID, {
    provideHover(model, position) {
      const word = model.getWordAtPosition(position);
      if (!word) return null;
      const doc = KEYWORD_DOCS[word.word.toUpperCase()];
      if (!doc) return null;
      return {
        range: {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        },
        contents: [{ value: doc.markdown }],
      };
    },
  });
}
