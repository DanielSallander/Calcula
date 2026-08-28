// FILENAME: app/extensions/ModelEditor/components/transform/formulaLanguage.ts
// PURPOSE: A Monaco language for a TRANSFORMATION STEP's formula — the
//          completion, hover and signature help that make "write it as a
//          formula" discoverable rather than merely possible.
// CONTEXT: Deliberately NOT the measure language. A step runs before its table
//          joins the model, so the measure surface is wrong for it in three
//          ways that each produce a broken formula:
//            * it sorts VAR / GVAR / RETURN to the top of completion, and none
//              of them parses in a step;
//            * it offers the WHOLE function catalog, including the aggregates a
//              step refuses by name;
//            * it draws columns from the table's FINAL model columns, not from
//              the schema reaching this step — so a column a previous step
//              renamed away is still offered, and one it created is not.
//          Both the column list and the row-level function set come from the
//          engine: the columns from the step's derived input schema, the
//          functions from `FunctionDefDto.rowLevel`, which the engine derives
//          from the very allowlist that will judge the formula.

import * as monaco from "monaco-editor";
import type { FunctionDefDto, ModelColumnInfo } from "@api";

export const TRANSFORM_FORMULA_LANGUAGE_ID = "calcula-transform-formula";

/** What the providers below read. Set per open editor. */
export interface FormulaContext {
  /** The columns reaching THIS step — its input schema, not the table's. */
  columns: ModelColumnInfo[];
  /** The catalog, already filtered to what a step may call. */
  functions: FunctionDefDto[];
}

let context: FormulaContext = { columns: [], functions: [] };
let registered = false;

/** Point the editor at the step being edited. Safe to call on every render. */
export function setFormulaContext(next: FormulaContext): void {
  context = next;
}

/** The keywords a step's formula may use. Notably NOT `VAR`/`RETURN`. */
const KEYWORDS = ["AND", "OR", "NOT", "XOR", "IN", "TRUE", "FALSE", "BLANK"];

/** Date-granularity keywords, which are bare words rather than strings. */
const GRANULARITIES = ["DAY", "WEEK", "MONTH", "QUARTER", "YEAR"];

/** A name needs brackets unless it is a plain identifier. */
function columnToken(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `[${name}]`;
}

export function registerTransformFormulaLanguage(): void {
  if (registered) return;
  registered = true;

  monaco.languages.register({ id: TRANSFORM_FORMULA_LANGUAGE_ID });

  monaco.languages.setLanguageConfiguration(TRANSFORM_FORMULA_LANGUAGE_ID, {
    brackets: [
      ["(", ")"],
      ["[", "]"],
      ["{", "}"],
    ],
    autoClosingPairs: [
      { open: "(", close: ")" },
      { open: "[", close: "]" },
      { open: "{", close: "}" },
      { open: '"', close: '"' },
    ],
    surroundingPairs: [
      { open: "(", close: ")" },
      { open: "[", close: "]" },
      { open: '"', close: '"' },
    ],
  });

  monaco.languages.setMonarchTokensProvider(TRANSFORM_FORMULA_LANGUAGE_ID, {
    defaultToken: "",
    ignoreCase: true,
    keywords: KEYWORDS,
    tokenizer: {
      root: [
        // A bracketed column, the spelling this surface teaches.
        [/\[[^\]]*\]/, "variable.name"],
        // A function call: the name up to its open paren.
        [/[A-Za-z_][A-Za-z0-9_]*(?=\s*\()/, "keyword.function"],
        [
          /[A-Za-z_][A-Za-z0-9_]*/,
          { cases: { "@keywords": "keyword", "@default": "variable" } },
        ],
        [/"([^"]|"")*"/, "string"],
        [/-?\d+(\.\d+)?/, "number"],
        [/[<>]=?|<>|=/, "operator"],
        [/[+\-*/&]/, "operator"],
        [/[,;]/, "delimiter"],
      ],
    },
  });

  monaco.languages.registerCompletionItemProvider(TRANSFORM_FORMULA_LANGUAGE_ID, {
    triggerCharacters: ["[", "(", ",", " "],
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const line = model.getLineContent(position.lineNumber);
      const before = line.slice(0, position.column - 1);

      // Inside an unclosed `[`, offer BARE column names: the bracket is
      // already typed, so inserting another would give `[[status]]`.
      const openBracket = before.lastIndexOf("[");
      if (openBracket !== -1 && !before.slice(openBracket).includes("]")) {
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: openBracket + 2,
          endColumn: position.column,
        };
        return {
          suggestions: context.columns.map((column, index) => ({
            label: column.name,
            kind: monaco.languages.CompletionItemKind.Field,
            insertText: column.name,
            detail: column.dataType,
            sortText: String(index).padStart(4, "0"),
            range,
          })),
        };
      }

      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      // Columns first and in SCHEMA order, because the thing an author reaches
      // for in a transform is nearly always a column of the row in front of
      // them — and their order is information (it is the table's order).
      const columns = context.columns.map((column, index) => ({
        label: column.name,
        kind: monaco.languages.CompletionItemKind.Field,
        insertText: columnToken(column.name),
        detail: `column · ${column.dataType}`,
        sortText: `0${String(index).padStart(4, "0")}`,
        range,
      }));

      const functions = context.functions.map((fn) => ({
        label: fn.name,
        kind: monaco.languages.CompletionItemKind.Function,
        // Place the caret between the parens, the way a grid formula bar does.
        insertText: `${fn.name}($0)`,
        insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
        detail: fn.signature,
        documentation: { value: fn.description },
        sortText: `1${fn.name}`,
        range,
      }));

      const keywords = [...KEYWORDS, ...GRANULARITIES].map((keyword) => ({
        label: keyword,
        kind: monaco.languages.CompletionItemKind.Keyword,
        insertText: keyword,
        sortText: `2${keyword}`,
        range,
      }));

      return { suggestions: [...columns, ...functions, ...keywords] };
    },
  });

  monaco.languages.registerHoverProvider(TRANSFORM_FORMULA_LANGUAGE_ID, {
    provideHover(model, position) {
      const word = model.getWordAtPosition(position);
      if (!word) return null;
      const column = context.columns.find((c) => c.name === word.word);
      if (column) {
        return {
          contents: [
            { value: `**${column.name}** · ${column.dataType}` },
            { value: "A column reaching this step. Write it as `[" + column.name + "]`." },
          ],
        };
      }
      const fn = context.functions.find(
        (f) => f.name.toUpperCase() === word.word.toUpperCase(),
      );
      if (fn) {
        return {
          contents: [{ value: `\`${fn.signature}\`` }, { value: fn.description }],
        };
      }
      return null;
    },
  });

  monaco.languages.registerSignatureHelpProvider(TRANSFORM_FORMULA_LANGUAGE_ID, {
    signatureHelpTriggerCharacters: ["(", ","],
    signatureHelpRetriggerCharacters: [","],
    provideSignatureHelp(model, position) {
      const call = enclosingCall(model, position);
      if (!call) return null;
      const fn = context.functions.find(
        (f) => f.name.toUpperCase() === call.name.toUpperCase(),
      );
      if (!fn) return null;
      return {
        value: {
          signatures: [
            {
              label: fn.signature,
              documentation: fn.description,
              parameters: signatureParameters(fn.signature),
            },
          ],
          activeSignature: 0,
          activeParameter: call.argument,
        },
        dispose: () => undefined,
      };
    },
  });
}

/** The function call the caret sits inside, and which argument it is on. */
function enclosingCall(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
): { name: string; argument: number } | null {
  const text = model.getValueInRange({
    startLineNumber: 1,
    startColumn: 1,
    endLineNumber: position.lineNumber,
    endColumn: position.column,
  });
  let depth = 0;
  let argument = 0;
  let inString = false;
  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text[i];
    // Count quotes crudely: a string cannot span a formula's argument list in
    // any way that matters for finding the enclosing paren.
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === ")") depth++;
    else if (ch === ",") {
      if (depth === 0) argument++;
    } else if (ch === "(") {
      if (depth === 0) {
        const head = /([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(text.slice(0, i));
        return head ? { name: head[1], argument } : null;
      }
      depth--;
    }
  }
  return null;
}

/** Split a signature's parameter list into Monaco parameter labels. */
function signatureParameters(signature: string): monaco.languages.ParameterInformation[] {
  const open = signature.indexOf("(");
  const close = signature.lastIndexOf(")");
  if (open === -1 || close <= open) return [];
  const inner = signature.slice(open + 1, close);
  if (inner.trim() === "") return [];
  return inner.split(",").map((part) => ({ label: part.trim() }));
}
