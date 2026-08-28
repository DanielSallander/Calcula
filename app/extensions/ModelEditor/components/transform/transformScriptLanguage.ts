// FILENAME: app/extensions/ModelEditor/components/transform/transformScriptLanguage.ts
// PURPOSE: A focused Monaco language for the applied-steps script: highlights
//          step tags, option keys, values and comments, and completes from the
//          vocabulary the ENGINE publishes.
// CONTEXT: The word lists are SERVED, never declared here. A local copy would
//          be a second statement of the grammar the parser reads against, and
//          would drift the first time a step gained an option — the exact
//          defect that moving the grammar into `engine-core` removed. Until the
//          vocabulary arrives, completion offers nothing rather than guessing.

import * as monaco from "monaco-editor";
import type { FunctionDefDto, ModelColumnInfo, TransformScriptVocabulary } from "@api";

export const TRANSFORM_SCRIPT_LANGUAGE_ID = "calcula-transform-script";

let vocabulary: TransformScriptVocabulary | null = null;
let formulaColumns: ModelColumnInfo[] = [];
let formulaFunctions: FunctionDefDto[] = [];
let registered = false;

/** Feed the editor the engine's published grammar. Safe to call repeatedly. */
export function setTransformScriptVocabulary(next: TransformScriptVocabulary): void {
  vocabulary = next;
}

/**
 * Feed the editor what an expression TAIL may name.
 *
 * The columns are approximate by construction: a tail's true input schema is the
 * pipeline's schema at THAT statement, and the pane knows only the source
 * columns and the pipeline's output. The union of the two covers essentially
 * every real formula, and the cost of being wrong is an unoffered name rather
 * than a wrong one — the engine still judges what was typed.
 */
export function setTransformScriptFormulaContext(
  columns: ModelColumnInfo[],
  functions: FunctionDefDto[],
): void {
  formulaColumns = columns;
  formulaFunctions = functions;
}

/** Whether the caret sits after a free-standing `=` — inside a formula. */
function inExpressionTail(model: monaco.editor.ITextModel, position: monaco.Position): boolean {
  for (let line = position.lineNumber; line >= 1; line--) {
    const text =
      line === position.lineNumber
        ? model.getLineContent(line).slice(0, position.column - 1)
        : model.getLineContent(line);
    if (/(^|\s)=(\s|$)/.test(text)) return true;
    // A statement starts at a line whose first character is not whitespace, so
    // reaching one without having seen a free-standing `=` means the caret is
    // in the option part, not in a tail.
    if (line !== position.lineNumber && !/^\s/.test(text)) return false;
    if (line === position.lineNumber && !/^\s/.test(model.getLineContent(line))) return false;
  }
  return false;
}

/** Register the language once per window. */
export function registerTransformScriptLanguage(): void {
  if (registered) return;
  registered = true;

  monaco.languages.register({ id: TRANSFORM_SCRIPT_LANGUAGE_ID });

  monaco.languages.setLanguageConfiguration(TRANSFORM_SCRIPT_LANGUAGE_ID, {
    // Only a comment at column zero is a comment; an indented line continues
    // the step above it, and a condition may well contain "//".
    comments: { lineComment: "//" },
    brackets: [["[", "]"]],
    autoClosingPairs: [
      { open: '"', close: '"' },
      { open: "[", close: "]" },
    ],
    surroundingPairs: [
      { open: '"', close: '"' },
      { open: "[", close: "]" },
    ],
  });

  monaco.languages.setMonarchTokensProvider(TRANSFORM_SCRIPT_LANGUAGE_ID, {
    defaultToken: "",
    tokenizer: {
      root: [
        // A comment only at column zero — see the language configuration above.
        [/^(\/\/|#).*$/, "comment"],
        // A step tag: the first word of a statement, so only at column zero.
        [/^[A-Za-z_][A-Za-z0-9_]*/, "keyword"],
        // A free-standing `=` opens the expression tail, which runs to the end
        // of the logical line and is never tokenized further — it belongs to
        // the model expression parser, not to this grammar.
        [/(\s)(=)(\s|$)/, ["", "operator", { token: "", next: "@tail" }]],
        [/[A-Za-z_][A-Za-z0-9_]*(?==)/, "attribute.name"],
        [/"/, { token: "string.quote", next: "@string" }],
        [/\[/, { token: "string.quote", next: "@bracket" }],
        [/-?\d+(\.\d+)?/, "number"],
        [/[,:]/, "delimiter"],
        [/=/, "operator"],
      ],
      // The expression tail is a FORMULA. It is never re-tokenized by the
      // PARSER — the grammar hands it to the model expression parser
      // byte-for-byte, which is what removes any need for an escape convention
      // on the one field feeding the fail-closed allowlist — but the
      // HIGHLIGHTER may still read it, and leaving it as one grey run was the
      // single least formula-like thing about this pane.
      tail: [
        [/\[[^\]]*\]/, "variable.name"],
        [/[A-Za-z_][A-Za-z0-9_]*(?=\s*\()/, "keyword.function"],
        // Word-bounded, or "BRAND" would highlight its own "AND".
        [/\b(AND|OR|NOT|XOR|IN|TRUE|FALSE|BLANK)\b/i, "keyword"],
        [/"([^"]|"")*"/, "string"],
        [/-?\d+(\.\d+)?/, "number"],
        [/[<>]=?|<>|=/, "operator"],
        [/[+\-*/&]/, "operator"],
        [/$/, { token: "", next: "@pop" }],
        [/./, ""],
      ],
      string: [
        [/[^"\\]+/, "string"],
        [/\\./, "string.escape"],
        [/""/, "string"],
        [/"/, { token: "string.quote", next: "@pop" }],
      ],
      bracket: [
        [/\]\]/, "string"],
        [/[^\]]+/, "string"],
        [/\]/, { token: "string.quote", next: "@pop" }],
      ],
    },
  });

  monaco.languages.registerCompletionItemProvider(TRANSFORM_SCRIPT_LANGUAGE_ID, {
    triggerCharacters: ["=", " "],
    provideCompletionItems(model, position) {
      if (!vocabulary) return { suggestions: [] };
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      const line = model.getLineContent(position.lineNumber);
      const beforeCursor = line.slice(0, position.column - 1);

      // Inside a formula tail the vocabulary is COLUMNS and FUNCTIONS, not step
      // options — offering `dataType=` where a formula belongs was the least
      // formula-like thing about this pane.
      if (inExpressionTail(model, position)) {
        const openBracket = beforeCursor.lastIndexOf("[");
        const inBracket = openBracket !== -1 && !beforeCursor.slice(openBracket).includes("]");
        const bracketRange = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: openBracket + 2,
          endColumn: position.column,
        };
        return {
          suggestions: [
            ...formulaColumns.map((column, index) => ({
              label: column.name,
              kind: monaco.languages.CompletionItemKind.Field,
              insertText: inBracket
                ? column.name
                : /^[A-Za-z_][A-Za-z0-9_]*$/.test(column.name)
                  ? column.name
                  : `[${column.name}]`,
              detail: `column · ${column.dataType}`,
              sortText: `0${String(index).padStart(4, "0")}`,
              range: inBracket ? bracketRange : range,
            })),
            ...(inBracket
              ? []
              : formulaFunctions.map((fn) => ({
                  label: fn.name,
                  kind: monaco.languages.CompletionItemKind.Function,
                  insertText: `${fn.name}($0)`,
                  insertTextRules:
                    monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                  detail: fn.signature,
                  documentation: { value: fn.description },
                  sortText: `1${fn.name}`,
                  range,
                }))),
          ],
        };
      }

      // After `key=`, offer that option's own values where the grammar has a
      // closed set for them.
      const assignment = /([A-Za-z_][A-Za-z0-9_]*)=\s*[A-Za-z0-9_.()]*$/.exec(beforeCursor);
      if (assignment) {
        const key = assignment[1].toLowerCase();
        const values = valuesForOption(key, vocabulary);
        return {
          suggestions: values.map((value) => ({
            label: value,
            kind: monaco.languages.CompletionItemKind.EnumMember,
            insertText: value,
            range,
          })),
        };
      }

      // At column zero: the step tags.
      if (/^\s*[A-Za-z_]*$/.test(beforeCursor) && !/^\s/.test(line)) {
        return {
          suggestions: vocabulary.steps.map((step) => ({
            label: step.tag,
            kind: monaco.languages.CompletionItemKind.Keyword,
            insertText: step.tag,
            detail: step.help,
            documentation: optionSummary(step),
            range,
          })),
        };
      }

      // Otherwise: the options of whichever step this statement names.
      const step = statementStep(model, position.lineNumber, vocabulary);
      const options = step ? step.options : allOptions(vocabulary);
      return {
        suggestions: [
          ...options.map((option) => ({
            label: `${option.key}=`,
            kind: monaco.languages.CompletionItemKind.Property,
            insertText: `${option.key}=`,
            detail: option.help,
            range,
          })),
          ...(step?.takesExpression
            ? [
                {
                  label: "= <expression>",
                  kind: monaco.languages.CompletionItemKind.Snippet,
                  insertText: "= ",
                  detail: "a row-level expression over this table's columns",
                  range,
                },
              ]
            : []),
        ],
      };
    },
  });

  monaco.languages.registerHoverProvider(TRANSFORM_SCRIPT_LANGUAGE_ID, {
    provideHover(model, position) {
      if (!vocabulary) return null;
      const word = model.getWordAtPosition(position);
      if (!word) return null;
      const step = vocabulary.steps.find((s) => s.tag === word.word);
      if (step) {
        return {
          contents: [{ value: `**${step.tag}** — ${step.help}` }, { value: optionSummary(step) }],
        };
      }
      const option = allOptions(vocabulary).find((o) => o.key === word.word);
      if (option) return { contents: [{ value: `**${option.key}=** ${option.help}` }] };
      return null;
    },
  });
}

/** The step a statement names, walking back over its continuation lines. */
function statementStep(
  model: monaco.editor.ITextModel,
  lineNumber: number,
  vocab: TransformScriptVocabulary,
): TransformScriptVocabulary["steps"][number] | null {
  for (let line = lineNumber; line >= 1; line--) {
    const text = model.getLineContent(line);
    if (/^\s/.test(text) || text.trim() === "") continue;
    const tag = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(text)?.[1];
    return vocab.steps.find((s) => s.tag.toLowerCase() === tag?.toLowerCase()) ?? null;
  }
  return null;
}

function allOptions(vocab: TransformScriptVocabulary) {
  const seen = new Map<string, { key: string; help: string }>();
  for (const step of vocab.steps) {
    for (const option of step.options) {
      if (!seen.has(option.key)) seen.set(option.key, option);
    }
  }
  return [...seen.values()];
}

/** The closed value set an option accepts, or nothing when it is free text. */
function valuesForOption(key: string, vocab: TransformScriptVocabulary): string[] {
  switch (key) {
    case "datatype":
    case "cast":
      return vocab.dataTypes;
    case "aggregate":
    case "agg":
      return vocab.aggregates;
    case "operation":
      return vocab.textOperations;
    case "onerror":
      return vocab.castErrorPolicies;
    case "range":
      return vocab.rowRangeKinds.map((kind) => (kind === "range" ? "range:0:100" : `${kind}:100`));
    case "keeporiginal":
    case "matchentirevalue":
      return ["true", "false"];
    default:
      return [];
  }
}

function optionSummary(step: TransformScriptVocabulary["steps"][number]): string {
  const options = step.options
    .map((o) => `- \`${o.key}=\`${o.optional ? " (optional)" : ""}${o.repeatable ? " (repeatable)" : ""} — ${o.help}`)
    .join("\n");
  const tail = step.takesExpression ? "\n- `= <expression>` — a row-level expression" : "";
  return options + tail || "_takes no options_";
}
