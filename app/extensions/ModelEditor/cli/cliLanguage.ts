// FILENAME: app/extensions/ModelEditor/cli/cliLanguage.ts
// PURPOSE: The Monaco language for the Model Editor command line: verb/kind
//          highlighting plus context-aware completion — verbs at line start,
//          object kinds after the verb, then live object names (from the
//          current ModelOverview) and per-kind option keys.
// CONTEXT: Same register-once + module-level-context pattern as
//          lib/measureLanguage.ts, so refreshing the overview updates
//          completions without re-registering providers.

import * as monaco from "monaco-editor";
import type { ModelOverview } from "@api";
import { KINDS, VERBS, normalizeKind } from "./parse";
import type { Kind } from "./parse";

export const CLI_LANGUAGE_ID = "calcula-model-cli";

let currentOverview: ModelOverview | null = null;

/** Feed the completion provider the live model (call on every overview install). */
export function setCliLanguageContext(overview: ModelOverview | null): void {
  currentOverview = overview;
}

/** Option keys offered per kind (mirrors the executor's accepted options). */
const OPTION_KEYS: Partial<Record<Kind, string[]>> = {
  measure: ["format", "formatexpr", "folder", "hidden", "description", "detailrows"],
  table: [
    "displayname",
    "description",
    "hidden",
    "storage",
    "refresh",
    "incremental",
    "source",
    "schema",
    "sourcetable",
  ],
  column: ["type", "description", "hidden", "format", "displayname", "sortby", "lookup"],
  relationship: ["cardinality", "active", "propagation", "name", "ops"],
  hierarchy: ["table", "levels"],
  kpi: ["base", "target", "targetvalue", "bands", "description"],
  role: ["filter", "deny"],
  perspective: ["tables", "columns", "measures", "description"],
  tablevar: ["source", "filter"],
  scriptfunction: ["params", "returns"],
  context: [],
  writeback: [
    "type",
    "keys",
    "kind",
    "projection",
    "projexpr",
    "required",
    "min",
    "max",
    "enum",
    "maxlength",
    "pattern",
    "editors",
    "history",
  ],
  source: ["kind", "host", "port", "database", "schema", "auth", "ssl", "trustcert", "connstr"],
  calctable: ["dynamic", "table", "cascade"],
  model: ["name", "version", "author", "description", "datetable", "lookup"],
  culture: [],
  translation: ["caption", "description"],
};

function needsQuoting(name: string): boolean {
  return /[\s,="'[\]]/.test(name);
}

function tableInsert(name: string): string {
  return needsQuoting(name) ? `"${name.replace(/"/g, '""')}"` : name;
}

/** Live object-name suggestions for one kind. */
function nameSuggestions(kind: Kind): Array<{ label: string; insert: string; detail: string }> {
  const o = currentOverview;
  if (!o) return [];
  switch (kind) {
    case "table":
      return o.tables.map((t) => ({ label: t.name, insert: tableInsert(t.name), detail: "table" }));
    case "measure":
      return o.measures.map((m) => ({ label: `[${m.name}]`, insert: `[${m.name}]`, detail: `measure on ${m.table}` }));
    case "column":
      return o.tables.flatMap((t) =>
        t.columns.map((c) => ({
          label: `${t.name}[${c.name}]`,
          insert: `${tableInsert(t.name)}[${c.name}]`,
          detail: c.dataType,
        })),
      );
    case "relationship":
      return o.relationships.map((r) => ({
        label: r.name,
        insert: tableInsert(r.name),
        detail: `${r.fromTable} -> ${r.toTable}`,
      }));
    case "hierarchy":
      return o.hierarchies.map((h) => ({ label: h.name, insert: tableInsert(h.name), detail: h.table }));
    case "kpi":
      return o.kpis.map((k) => ({ label: k.name, insert: tableInsert(k.name), detail: k.baseMeasure }));
    case "role":
      return o.securityRoles.map((r) => ({ label: r.name, insert: tableInsert(r.name), detail: "role" }));
    case "perspective":
      return o.perspectives.map((p) => ({ label: p.name, insert: tableInsert(p.name), detail: "perspective" }));
    case "culture":
    case "translation":
      return o.cultures.map((c) => ({ label: c.locale, insert: c.locale, detail: "culture" }));
    case "calcgroup":
      return o.calculationGroups.map((g) => ({ label: g.name, insert: tableInsert(g.name), detail: "calc group" }));
    case "calcitem":
      return o.calculationGroups.flatMap((g) =>
        g.items.map((i) => ({ label: `${g.name}[${i.name}]`, insert: `${tableInsert(g.name)}[${i.name}]`, detail: "calc item" })),
      );
    case "calctable":
      return o.globalVariables.map((g) => ({
        label: g.name,
        insert: tableInsert(g.name),
        detail: g.dynamic ? "dynamic" : "materialized",
      }));
    case "tablevar":
      return o.tableVariables.map((v) => ({ label: v.name, insert: tableInsert(v.name), detail: v.source }));
    case "scriptfunction":
      return o.scriptFunctions.map((f) => ({ label: f.name, insert: tableInsert(f.name), detail: f.returnType }));
    case "context":
      return o.contexts.map((c) => ({ label: c.name, insert: tableInsert(c.name), detail: "context" }));
    case "contextcolumn":
      return o.contextColumns.map((c) => ({ label: c.name, insert: tableInsert(c.name), detail: c.table }));
    case "writeback":
      return o.writebackColumns.map((w) => ({ label: w.name, insert: tableInsert(w.name), detail: w.table }));
    case "source":
      return o.sources.map((src) => ({
        label: src.displayName ?? src.id,
        insert: tableInsert(src.displayName ?? src.id),
        detail: src.kind,
      }));
    default:
      return [];
  }
}

let registered = false;

/** Register the CLI language + providers. Safe to call repeatedly. */
export function registerCliLanguage(): void {
  if (registered) return;
  registered = true;

  monaco.languages.register({ id: CLI_LANGUAGE_ID });

  monaco.languages.setLanguageConfiguration(CLI_LANGUAGE_ID, {
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

  monaco.languages.setMonarchTokensProvider(CLI_LANGUAGE_ID, {
    ignoreCase: true,
    verbs: VERBS,
    kinds: [...KINDS, ...KINDS.map((k) => k + "s"), "hierarchies", "func", "funcs", "rel", "rels", "col", "cols"],
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

  monaco.languages.registerCompletionItemProvider(CLI_LANGUAGE_ID, {
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

      const suggestions: monaco.languages.CompletionItem[] = [];
      if (words.length === 0) {
        for (const v of VERBS) {
          suggestions.push({ label: v, kind: K.Keyword, insertText: v + " ", range });
        }
      } else if (words.length === 1) {
        for (const k of KINDS) {
          suggestions.push({ label: k, kind: K.Class, insertText: k + " ", range });
        }
      } else {
        const kind = normalizeKind(words[1]);
        if (kind) {
          for (const n of nameSuggestions(kind).slice(0, 400)) {
            suggestions.push({ label: n.label, kind: K.Value, insertText: n.insert, detail: n.detail, range });
          }
          for (const key of OPTION_KEYS[kind] ?? []) {
            suggestions.push({
              label: key + "=",
              kind: K.Property,
              insertText: key + "=",
              sortText: "zz" + key, // names first, option keys after
              range,
            });
          }
        }
      }
      return { suggestions };
    },
  });
}
