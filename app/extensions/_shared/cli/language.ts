// FILENAME: app/extensions/_shared/cli/language.ts
// PURPOSE: The Monaco language machinery of the fused CLI, shared by every
//          panel: verb/kind highlighting from a vocabulary, plus positional
//          completion (verbs at line start, kinds after the verb, then live
//          object names and option keys) fed by a swappable per-language
//          CONTEXT — the register-once + module-context pattern of the
//          original Model Editor cliLanguage.ts, generalized.
// CONTEXT: A language id is registered once per window; its completion
//          context can be replaced any time (overview installs, engine
//          rebuilds) without re-registering providers.

import * as monaco from "monaco-editor";
import type { CliEngine } from "./engine";
import type { CliVocabulary } from "./parse";
import type { CliNameSuggestion } from "./registry";

export interface CliCompletionOption {
  key: string;
  /** Shown as the completion item's detail. */
  help?: string;
}

export interface CliCompletionContext {
  /** Live object names for one canonical kind. */
  nameSuggestions(kind: string): CliNameSuggestion[];
  /** Option keys to offer for one canonical kind under one verb (the raw
   *  verb word as typed — the context resolves aliases itself). */
  optionKeys(kind: string, verbWord: string): CliCompletionOption[];
  normalizeKind(word: string): string | null;
}

interface LanguageState {
  vocabulary: CliVocabulary;
  context: CliCompletionContext | null;
}

const LANGUAGES = new Map<string, LanguageState>();

/** Swap the live completion context for a registered language. */
export function setCliCompletionContext(
  languageId: string,
  context: CliCompletionContext | null,
): void {
  const state = LANGUAGES.get(languageId);
  if (state) state.context = context;
}

/** Quote an object name for the command line when it needs it. */
export function cliNameInsert(name: string): string {
  return /[\s,="'[\]]/.test(name) ? `"${name.replace(/"/g, '""')}"` : name;
}

/** Register a CLI language (highlighting + completion) for one vocabulary.
 *  Safe to call repeatedly; later calls refresh the vocabulary reference. */
export function registerCliLanguage(languageId: string, vocabulary: CliVocabulary): void {
  const existing = LANGUAGES.get(languageId);
  if (existing) {
    existing.vocabulary = vocabulary;
    return;
  }
  const state: LanguageState = { vocabulary, context: null };
  LANGUAGES.set(languageId, state);

  monaco.languages.register({ id: languageId });

  monaco.languages.setLanguageConfiguration(languageId, {
    brackets: [
      ["(", ")"],
      ["[", "]"],
    ],
    autoClosingPairs: [
      { open: "(", close: ")" },
      { open: "[", close: "]" },
      { open: '"', close: '"' },
    ],
    comments: { lineComment: "#" },
  });

  monaco.languages.setMonarchTokensProvider(languageId, {
    ignoreCase: true,
    verbs: state.vocabulary.verbs,
    kinds: [
      ...state.vocabulary.kinds,
      ...state.vocabulary.kinds.map((k) => k + "s"),
      ...Object.keys(state.vocabulary.kindAliases),
    ],
    tokenizer: {
      root: [
        [/^\s*(#|\/\/).*$/, "comment"],
        [/"([^"]|"")*"/, "string"],
        [/'([^']|'')*'/, "string"],
        [/\[[^\]]*\]/, "variable"],
        [/->/, "operator"],
        [/\b\d+(\.\d+)?\b/, "number"],
        [/[A-Za-z_][\w.-]*(?==)/, "attribute.name"],
        // `@verbs`/`@kinds`/`@default` are Monaco Monarch's required literal
        // case keys — not renameable.
        [
          /^[a-zA-Z]+/,
          // eslint-disable-next-line @typescript-eslint/naming-convention
          { cases: { "@verbs": "keyword", "@default": "identifier" } },
        ],
        [
          /[a-zA-Z][\w.-]*/,
          // eslint-disable-next-line @typescript-eslint/naming-convention
          { cases: { "@kinds": "type", "@default": "identifier" } },
        ],
        [/=/, "operator"],
      ],
    },
  } as monaco.languages.IMonarchLanguage);

  monaco.languages.registerCompletionItemProvider(languageId, {
    triggerCharacters: [" ", "["],
    provideCompletionItems(model, position) {
      const line = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
      // Inside a formula tail (after a free-standing =)? No CLI suggestions.
      if (/(^|\s)=(\s|$)/.test(line) || /^\s/.test(model.getLineContent(position.lineNumber))) {
        return { suggestions: [] };
      }

      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(
        position.lineNumber,
        word.startColumn,
        position.lineNumber,
        word.endColumn,
      );
      const K = monaco.languages.CompletionItemKind;

      // Words already completed before the cursor (exclude the one being typed).
      const before = line.slice(0, word.startColumn - 1);
      const words = before.split(/\s+/).filter((w) => w !== "");

      const { vocabulary, context } = state;
      const suggestions: monaco.languages.CompletionItem[] = [];
      if (words.length === 0) {
        for (const v of vocabulary.verbs) {
          suggestions.push({ label: v, kind: K.Keyword, insertText: v + " ", range });
        }
      } else if (words.length === 1) {
        const verb = vocabulary.verbAliases[words[0].toLowerCase()];
        if (verb && !vocabulary.kindless.has(verb)) {
          for (const k of vocabulary.kinds) {
            suggestions.push({ label: k, kind: K.Class, insertText: k + " ", range });
          }
        }
      } else if (context) {
        const kind = context.normalizeKind(words[1]);
        if (kind) {
          for (const n of context.nameSuggestions(kind).slice(0, 400)) {
            suggestions.push({
              label: n.label,
              kind: K.Value,
              insertText: n.insert,
              detail: n.detail,
              range,
            });
          }
          for (const opt of context.optionKeys(kind, words[0])) {
            suggestions.push({
              label: opt.key + "=",
              kind: K.Property,
              insertText: opt.key + "=",
              detail: opt.help,
              sortText: "zz" + opt.key, // names first, option keys after
              range,
            });
          }
        }
      }
      return { suggestions };
    },
  });
}

/**
 * A completion context derived generically from a live engine: object names
 * from each kind spec's `nameSuggestions(session)`, option keys as the union
 * of the kind's per-verb option tables. Works for any domain whose kind specs
 * carry those — the main-window panel uses this for every mounted domain.
 */
export function engineCompletionContext(engine: CliEngine): CliCompletionContext {
  return {
    normalizeKind: (word) => engine.parser.normalizeKind(word),
    nameSuggestions(kind) {
      for (const b of engine.bindings) {
        const spec = b.domain.kinds.find((k) => k.kind === kind);
        if (spec?.nameSuggestions) return spec.nameSuggestions(b.session);
      }
      return [];
    },
    optionKeys(kind, verbWord) {
      const verb = engine.parser.vocabulary.verbAliases[verbWord.toLowerCase()];
      if (!verb) return [];
      for (const b of engine.bindings) {
        const spec = b.domain.kinds.find((k) => k.kind === kind);
        if (spec?.options) {
          return (spec.options[verb] ?? []).map((s) => ({ key: s.key, help: s.help }));
        }
      }
      return [];
    },
  };
}
