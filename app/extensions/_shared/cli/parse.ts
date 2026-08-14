// FILENAME: app/extensions/_shared/cli/parse.ts
// PURPOSE: The shared command parser: one logical line -> a GenericCommand
//          (verb + object kind + positionals with an optional `->` right-hand
//          side + `key=value` options + raw expression tail). The verb/kind
//          VOCABULARY is passed in — each CLI domain contributes its verbs and
//          kinds through the registry, and the engine feeds the merged
//          vocabulary here — so parsing, help and Monaco completion all share
//          one registry without this module knowing any domain.
// CONTEXT: Extracted from the Model Editor CLI (whose typed Verb/Kind unions
//          live on in its own cli/parse.ts as a narrowing layer over this).

import { CliError, lexLine, logicalLines } from "./lex";
import type { LogicalLine, Token, ValueTok } from "./lex";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export interface CliVocabulary {
  /** alias (lowercase) -> canonical verb. Canonical spellings map to
   *  themselves ("delete" -> "delete", "rm" -> "delete"). */
  verbAliases: Record<string, string>;
  /** Canonical verbs in completion/help display order. */
  verbs: string[];
  /** alias (lowercase) -> canonical kind. Canonical spellings included. */
  kindAliases: Record<string, string>;
  /** Canonical kinds in completion/help display order. */
  kinds: string[];
  /** Verbs that never take an object kind (undo, redo, goto, …). */
  kindless: ReadonlySet<string>;
  /** Irregular plurals ("hierarchies" -> "hierarchy"); regular plurals are
   *  handled by stripping a trailing "s" against the alias table. */
  pluralOverrides?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

/** The parsed shape every domain receives. Verb and kind are canonical
 *  vocabulary strings; a domain narrows them to its own unions at its
 *  boundary (e.g. the Model Editor's `asModelCommand`). Deliberately
 *  serializable: no closures, no live references (a future "record as CLI
 *  script" printer depends on that staying true). */
export interface GenericCommand {
  verb: string;
  kind: string | null;
  /** Positional target tokens (before any `->`). */
  pos: ValueTok[];
  /** Positional tokens after `->` (relationship right-hand endpoint). */
  arrowPos: ValueTok[];
  /** Raw expression tail after a free-standing `=`, or null. */
  expr: string | null;
  /** key → occurrences → comma-separated value list of that occurrence. */
  opts: Map<string, ValueTok[][]>;
  raw: string;
  line: number;
}

const VALUE_KINDS = new Set(["word", "string", "bracket", "colref"]);

function isValue(t: Token): t is ValueTok {
  return VALUE_KINDS.has(t.kind);
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export interface CliParser {
  vocabulary: CliVocabulary;
  /** Normalize a kind word (aliases, plural stripping), or null. */
  normalizeKind(word: string): string | null;
  parseCommand(logical: LogicalLine): GenericCommand;
  parseScript(source: string): GenericCommand[];
}

export function createParser(vocabulary: CliVocabulary): CliParser {
  const normalizeKind = (word: string): string | null => {
    const w = word.toLowerCase();
    if (vocabulary.kindAliases[w]) return vocabulary.kindAliases[w];
    const irregular = vocabulary.pluralOverrides?.[w];
    if (irregular) return irregular;
    if (w.endsWith("s") && vocabulary.kindAliases[w.slice(0, -1)]) {
      return vocabulary.kindAliases[w.slice(0, -1)];
    }
    return null;
  };

  const parseCommand = (logical: LogicalLine): GenericCommand => {
    const { tokens, expr } = (() => {
      try {
        return lexLine(logical.text);
      } catch (e) {
        if (e instanceof CliError) throw new CliError(e.message, logical.line);
        throw e;
      }
    })();

    // Explicit annotation so TS narrows after calls (never-returning arrows
    // without a variable type annotation don't participate in flow analysis).
    const fail: (msg: string) => never = (msg) => {
      throw new CliError(msg, logical.line);
    };

    if (tokens.length === 0) {
      if (expr !== null) fail("A command cannot start with '='");
      fail("Empty command");
    }
    const head = tokens[0];
    if (head.kind !== "word") fail("A command must start with a verb (try 'help')");
    const verb = vocabulary.verbAliases[(head as ValueTok).text.toLowerCase()];
    if (!verb) fail(`Unknown command '${(head as ValueTok).text}' (try 'help')`);

    const cmd: GenericCommand = {
      verb,
      kind: null,
      pos: [],
      arrowPos: [],
      expr,
      opts: new Map(),
      raw: logical.text,
      line: logical.line,
    };

    let i = 1;

    if (!vocabulary.kindless.has(verb) && i < tokens.length) {
      const t = tokens[i];
      // A word directly followed by `=` is an option key, never a kind.
      if (t.kind === "word" && tokens[i + 1]?.kind !== "eqAttached") {
        const k = normalizeKind(t.text);
        if (k) {
          cmd.kind = k;
          i++;
        }
      }
    }
    if (verb === "help") {
      // `help <anything>` — keep the raw topic words as positionals.
      while (i < tokens.length) {
        const t = tokens[i];
        if (isValue(t)) cmd.pos.push(t);
        i++;
      }
      return cmd;
    }

    let side: "pos" | "arrow" = "pos";
    while (i < tokens.length) {
      const t = tokens[i];
      if (t.kind === "arrow") {
        side = "arrow";
        i++;
        continue;
      }
      if (t.kind === "comma") {
        i++; // commas between positionals (multi-condition endpoints) are soft
        continue;
      }
      if (t.kind === "eqAttached") fail("Unexpected '='");
      if (!isValue(t)) fail("Unexpected token");

      // Option assignment: word glued to '='.
      if (t.kind === "word" && tokens[i + 1]?.kind === "eqAttached") {
        const key = t.text.toLowerCase();
        i += 2;
        const values: ValueTok[] = [];
        // A value list: value (, value)* — may be empty (`format=` clears).
        if (i < tokens.length && isValue(tokens[i])) {
          values.push(tokens[i] as ValueTok);
          i++;
          while (
            i + 1 < tokens.length &&
            tokens[i].kind === "comma" &&
            isValue(tokens[i + 1])
          ) {
            values.push(tokens[i + 1] as ValueTok);
            i += 2;
          }
        }
        const list = cmd.opts.get(key) ?? [];
        list.push(values);
        cmd.opts.set(key, list);
        continue;
      }

      // `rename x TO y` — the connective reads naturally, skip it.
      if (
        verb === "rename" &&
        t.kind === "word" &&
        t.text.toLowerCase() === "to" &&
        cmd.pos.length > 0
      ) {
        i++;
        continue;
      }

      if (side === "pos") cmd.pos.push(t);
      else cmd.arrowPos.push(t);
      i++;
    }

    return cmd;
  };

  return {
    vocabulary,
    normalizeKind,
    parseCommand,
    parseScript: (source: string) => logicalLines(source).map(parseCommand),
  };
}

// ---------------------------------------------------------------------------
// Option helpers (shared by every domain's executors)
// ---------------------------------------------------------------------------

type OptCarrier = Pick<GenericCommand, "opts" | "line">;

/** Last occurrence of `key` as a single scalar string, or undefined when the
 *  option wasn't given. An empty assignment (`format=`) returns "". */
export function optStr(cmd: OptCarrier, key: string): string | undefined {
  const occ = cmd.opts.get(key);
  if (!occ || occ.length === 0) return undefined;
  const vals = occ[occ.length - 1];
  if (vals.length === 0) return "";
  return vals.map((v) => v.text).join(",");
}

/** Last occurrence of `key` as a value-token list (empty array = `key=`). */
export function optList(cmd: OptCarrier, key: string): ValueTok[] | undefined {
  const occ = cmd.opts.get(key);
  if (!occ || occ.length === 0) return undefined;
  return occ[occ.length - 1];
}

/** Every occurrence of `key` flattened (repeatable options like filter=…). */
export function optAll(cmd: OptCarrier, key: string): ValueTok[] {
  const occ = cmd.opts.get(key);
  if (!occ) return [];
  return occ.flat();
}

export function optBool(cmd: OptCarrier, key: string): boolean | undefined {
  const s = optStr(cmd, key);
  if (s === undefined) return undefined;
  const v = s.toLowerCase();
  if (["true", "yes", "on", "1"].includes(v)) return true;
  if (["false", "no", "off", "0"].includes(v)) return false;
  throw new CliError(`Option ${key}= expects true/false (got '${s}')`, cmd.line);
}

export function optNum(cmd: OptCarrier, key: string): number | undefined {
  const s = optStr(cmd, key);
  if (s === undefined || s === "") return undefined;
  const n = Number(s);
  if (!Number.isFinite(n)) throw new CliError(`Option ${key}= expects a number (got '${s}')`, cmd.line);
  return n;
}

/** The option keys a command actually used (for unknown-option validation). */
export function usedOptKeys(cmd: OptCarrier): string[] {
  return [...cmd.opts.keys()];
}
