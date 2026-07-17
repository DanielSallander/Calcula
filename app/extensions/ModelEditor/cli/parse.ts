// FILENAME: app/extensions/ModelEditor/cli/parse.ts
// PURPOSE: Parse one logical line into a Command: verb + object kind +
//          positional targets (with an optional `->` right-hand side for
//          relationship endpoints) + `key=value` options + raw expression
//          tail. Verb/kind vocabularies live here so parsing, help and Monaco
//          completion all share one registry.

import { CliError, lexLine, logicalLines } from "./lex";
import type { LogicalLine, Token, ValueTok } from "./lex";

// ---------------------------------------------------------------------------
// Verbs
// ---------------------------------------------------------------------------

export type Verb =
  | "help"
  | "clear"
  | "ls"
  | "show"
  | "add"
  | "set"
  | "rename"
  | "delete"
  | "undo"
  | "redo"
  | "refresh"
  | "materialize"
  | "validate"
  | "import"
  | "connect";

const VERB_ALIASES: Record<string, Verb> = {
  help: "help",
  clear: "clear",
  cls: "clear",
  ls: "ls",
  list: "ls",
  show: "show",
  add: "add",
  create: "add",
  new: "add",
  set: "set",
  rename: "rename",
  mv: "rename",
  delete: "delete",
  del: "delete",
  rm: "delete",
  remove: "delete",
  undo: "undo",
  redo: "redo",
  refresh: "refresh",
  materialize: "materialize",
  validate: "validate",
  import: "import",
  connect: "connect",
};

export const VERBS: Verb[] = [
  "ls",
  "show",
  "add",
  "set",
  "rename",
  "delete",
  "refresh",
  "materialize",
  "validate",
  "import",
  "connect",
  "undo",
  "redo",
  "help",
  "clear",
];

// ---------------------------------------------------------------------------
// Object kinds
// ---------------------------------------------------------------------------

export type Kind =
  | "table"
  | "column"
  | "measure"
  | "relationship"
  | "hierarchy"
  | "kpi"
  | "role"
  | "perspective"
  | "culture"
  | "translation"
  | "calcgroup"
  | "calcitem"
  | "calctable"
  | "tablevar"
  | "scriptfunction"
  | "context"
  | "contextcolumn"
  | "writeback"
  | "source"
  | "sourcetable"
  | "extdata"
  | "model"
  | "tables"
  | "sql";

const KIND_ALIASES: Record<string, Kind> = {
  table: "table",
  tbl: "table",
  column: "column",
  col: "column",
  measure: "measure",
  relationship: "relationship",
  rel: "relationship",
  hierarchy: "hierarchy",
  kpi: "kpi",
  role: "role",
  perspective: "perspective",
  culture: "culture",
  translation: "translation",
  calcgroup: "calcgroup",
  calculationgroup: "calcgroup",
  calcitem: "calcitem",
  calcgroupitem: "calcitem",
  calctable: "calctable",
  calculatedtable: "calctable",
  global: "calctable",
  tablevar: "tablevar",
  tablevariable: "tablevar",
  scriptfunction: "scriptfunction",
  func: "scriptfunction",
  context: "context",
  contextcolumn: "contextcolumn",
  contextcol: "contextcolumn",
  writeback: "writeback",
  writebackcolumn: "writeback",
  source: "source",
  sourcetable: "sourcetable",
  extdata: "extdata",
  extensiondata: "extdata",
  model: "model",
  // `import tables …` / `import sql …` pseudo-kinds:
  sql: "sql",
};

/** Kinds shown in completion / help (canonical spellings, listable first). */
export const KINDS: Kind[] = [
  "table",
  "column",
  "measure",
  "relationship",
  "hierarchy",
  "kpi",
  "role",
  "perspective",
  "culture",
  "translation",
  "calcgroup",
  "calcitem",
  "calctable",
  "tablevar",
  "scriptfunction",
  "context",
  "contextcolumn",
  "writeback",
  "source",
  "sourcetable",
  "extdata",
  "model",
];

/** Normalize a kind word: lowercase, strip a plural "s" when the singular is
 *  known (hierarchies → hierarchy handled explicitly). */
export function normalizeKind(word: string): Kind | null {
  const w = word.toLowerCase();
  if (KIND_ALIASES[w]) return KIND_ALIASES[w];
  if (w === "hierarchies") return "hierarchy";
  if (w === "tables") return "table";
  if (w.endsWith("s") && KIND_ALIASES[w.slice(0, -1)]) return KIND_ALIASES[w.slice(0, -1)];
  return null;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export interface Command {
  verb: Verb;
  kind: Kind | null;
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

export function parseCommand(logical: LogicalLine): Command {
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
  const verb = VERB_ALIASES[(head as ValueTok).text.toLowerCase()];
  if (!verb) fail(`Unknown command '${(head as ValueTok).text}' (try 'help')`);

  const cmd: Command = {
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

  // Verbs that take no object kind.
  const kindless = new Set<Verb>(["undo", "redo", "clear", "validate", "help"]);
  if (!kindless.has(verb) && i < tokens.length) {
    const t = tokens[i];
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
}

/** Parse a whole script: logical lines → commands. Throws on first error. */
export function parseScript(source: string): Command[] {
  return logicalLines(source).map(parseCommand);
}

// ---------------------------------------------------------------------------
// Option helpers (shared by the executor)
// ---------------------------------------------------------------------------

/** Last occurrence of `key` as a single scalar string, or undefined when the
 *  option wasn't given. An empty assignment (`format=`) returns "". */
export function optStr(cmd: Command, key: string): string | undefined {
  const occ = cmd.opts.get(key);
  if (!occ || occ.length === 0) return undefined;
  const vals = occ[occ.length - 1];
  if (vals.length === 0) return "";
  return vals.map((v) => v.text).join(",");
}

/** Last occurrence of `key` as a value-token list (empty array = `key=`). */
export function optList(cmd: Command, key: string): ValueTok[] | undefined {
  const occ = cmd.opts.get(key);
  if (!occ || occ.length === 0) return undefined;
  return occ[occ.length - 1];
}

/** Every occurrence of `key` flattened (repeatable options like filter=…). */
export function optAll(cmd: Command, key: string): ValueTok[] {
  const occ = cmd.opts.get(key);
  if (!occ) return [];
  return occ.flat();
}

export function optBool(cmd: Command, key: string): boolean | undefined {
  const s = optStr(cmd, key);
  if (s === undefined) return undefined;
  const v = s.toLowerCase();
  if (["true", "yes", "on", "1"].includes(v)) return true;
  if (["false", "no", "off", "0"].includes(v)) return false;
  throw new CliError(`Option ${key}= expects true/false (got '${s}')`, cmd.line);
}

export function optNum(cmd: Command, key: string): number | undefined {
  const s = optStr(cmd, key);
  if (s === undefined || s === "") return undefined;
  const n = Number(s);
  if (!Number.isFinite(n)) throw new CliError(`Option ${key}= expects a number (got '${s}')`, cmd.line);
  return n;
}

/** The option keys a command actually used (for unknown-option validation). */
export function usedOptKeys(cmd: Command): string[] {
  return [...cmd.opts.keys()];
}
