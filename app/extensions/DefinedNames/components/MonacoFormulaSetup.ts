//! FILENAME: app/extensions/DefinedNames/components/MonacoFormulaSetup.ts
// PURPOSE: Register a custom Monaco language for formula editing with IntelliSense.
// CONTEXT: Used by NewFunctionDialog for multiline function body editing.

import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import {
  loadFunctionCatalog,
  getFunctionCatalog,
} from "../../BuiltIn/FormulaAutocomplete/functionCatalog";

// ============================================================================
// Monaco Worker Setup (local, no CDN)
// ============================================================================

self.MonacoEnvironment = {
  getWorker() {
    return new editorWorker();
  },
};

loader.config({ monaco });

// ============================================================================
// Language Registration
// ============================================================================

const LANGUAGE_ID = "calcula-formula";
let languageRegistered = false;

/** Current parameter names injected by the dialog. */
let currentParamNames: string[] = [];

/**
 * Update the parameter names available for IntelliSense.
 * Call this whenever the user adds/removes/renames parameters.
 */
export function setFormulaEditorParams(params: string[]): void {
  currentParamNames = params;
}

/**
 * Register the calcula-formula language and its completion provider.
 * Safe to call multiple times -- only registers once.
 */
export function registerFormulaLanguage(): void {
  if (languageRegistered) return;
  languageRegistered = true;

  // Register the language
  monaco.languages.register({ id: LANGUAGE_ID });

  // Monarch tokenizer for syntax highlighting
  monaco.languages.setMonarchTokensProvider(LANGUAGE_ID, {
    ignoreCase: true,
    tokenizer: {
      root: [
        // String literals
        [/"[^"]*"/, "string"],

        // Numbers
        [/\b\d+(\.\d+)?([eE][+-]?\d+)?\b/, "number"],

        // Boolean & error constants
        [/\b(TRUE|FALSE)\b/i, "keyword"],
        [/#(N\/A|VALUE!|REF!|DIV\/0!|NULL!|NAME\?|NUM!|SPILL!)/i, "keyword"],

        // Cell references (e.g., A1, $B$2, Sheet1!A1:B10)
        [/\$?[A-Z]+\$?\d+(:\$?[A-Z]+\$?\d+)?/i, "variable.name"],

        // Function names followed by (
        [/[A-Z][A-Z0-9_.]*(?=\s*\()/i, "type.identifier"],

        // Identifiers (parameters, named ranges)
        [/[a-zA-Z_][a-zA-Z0-9_.]*/, "identifier"],

        // Operators
        [/[+\-*/^&=<>]+/, "operator"],
        [/[,;()]/, "delimiter"],

        // Whitespace
        [/\s+/, "white"],
      ],
    },
  });

  // Completion provider
  monaco.languages.registerCompletionItemProvider(LANGUAGE_ID, {
    triggerCharacters: [".", "(", ","],

    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      const suggestions: monaco.languages.CompletionItem[] = [];

      // Add parameter names as variable completions
      for (const param of currentParamNames) {
        if (param.trim()) {
          suggestions.push({
            label: param,
            kind: monaco.languages.CompletionItemKind.Variable,
            insertText: param,
            detail: "Parameter",
            range,
            sortText: "0_" + param,
          });
        }
      }

      // Add functions from the catalog
      const catalog = getFunctionCatalog();
      for (const fn of catalog) {
        suggestions.push({
          label: fn.name,
          kind: monaco.languages.CompletionItemKind.Function,
          insertText: fn.name + "(",
          insertTextRules:
            monaco.languages.CompletionItemInsertTextRule.None,
          detail: fn.syntax,
          documentation: fn.description,
          range,
          sortText: "1_" + fn.name,
        });
      }

      return { suggestions };
    },
  });

  // Ensure the function catalog is loaded
  loadFunctionCatalog();
}

export { LANGUAGE_ID };
