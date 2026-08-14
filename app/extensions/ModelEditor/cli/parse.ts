// FILENAME: app/extensions/ModelEditor/cli/parse.ts
// PURPOSE: The MODEL domain's typed parsing layer over the shared CLI kernel
//          (_shared/cli/parse.ts). The verb/kind vocabulary is declared here
//          ONCE as kernel contribution data — the standalone parser below and
//          the fused engine (via modelDomain.ts) both build from it, so the
//          two can never disagree. The `Verb`/`Kind` unions and the typed
//          `Command` survive as a narrowing layer: readers/writers keep their
//          exhaustive switches, tests keep their imports.

import {
  createParser,
  optAll,
  optBool,
  optList,
  optNum,
  optStr,
  usedOptKeys,
} from "../../_shared/cli/parse";
import type { GenericCommand } from "../../_shared/cli/parse";
import { mergeVocabulary } from "../../_shared/cli/registry";
import type { CliVerbSpec, CliVocabularyContribution } from "../../_shared/cli/registry";
import type { LogicalLine, ValueTok } from "./lex";

export { optAll, optBool, optList, optNum, optStr, usedOptKeys };
export type { ValueTok };

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

/** Model-domain verbs beyond the shared core (fed to the kernel merge). */
export const MODEL_VERB_SPECS: CliVerbSpec[] = [
  { verb: "refresh" },
  { verb: "materialize" },
  { verb: "validate", kindless: true },
  { verb: "import" },
  { verb: "connect" },
];

/** Canonical verbs in completion/help display order (unchanged list). */
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

/** The model domain's kind vocabulary (canonical + aliases), as kernel
 *  contribution data. `sql` is the `import sql …` pseudo-kind. */
export const MODEL_KIND_DATA: Array<{ kind: Kind; aliases?: string[] }> = [
  { kind: "table", aliases: ["tbl"] },
  { kind: "column", aliases: ["col"] },
  { kind: "measure" },
  { kind: "relationship", aliases: ["rel"] },
  { kind: "hierarchy" },
  { kind: "kpi" },
  { kind: "role" },
  { kind: "perspective" },
  { kind: "culture" },
  { kind: "translation" },
  { kind: "calcgroup", aliases: ["calculationgroup"] },
  { kind: "calcitem", aliases: ["calcgroupitem"] },
  { kind: "calctable", aliases: ["calculatedtable", "global"] },
  { kind: "tablevar", aliases: ["tablevariable"] },
  { kind: "scriptfunction", aliases: ["func"] },
  { kind: "context" },
  { kind: "contextcolumn", aliases: ["contextcol"] },
  { kind: "writeback", aliases: ["writebackcolumn"] },
  { kind: "source" },
  { kind: "sourcetable" },
  { kind: "extdata", aliases: ["extensiondata"] },
  { kind: "model" },
  { kind: "sql" },
];

export const MODEL_PLURAL_OVERRIDES: Record<string, string> = {
  hierarchies: "hierarchy",
};

/** The model domain's whole vocabulary contribution (modelDomain.ts hands the
 *  SAME object to the engine, so standalone and fused parsing agree). */
export const MODEL_VOCABULARY_CONTRIBUTION: CliVocabularyContribution = {
  id: "model",
  verbs: MODEL_VERB_SPECS,
  kinds: MODEL_KIND_DATA,
  pluralOverrides: MODEL_PLURAL_OVERRIDES,
};

/** Kinds shown in completion / help (canonical spellings, listable first;
 *  the `sql` pseudo-kind is deliberately not displayed). */
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

// ---------------------------------------------------------------------------
// Parser (single-domain, typed)
// ---------------------------------------------------------------------------

/** The model domain's full merged vocabulary (core verbs + this domain).
 *  Shared with the Monaco language registration so highlighting/completion
 *  can never disagree with the parser. */
export const MODEL_CLI_VOCABULARY = mergeVocabulary([MODEL_VOCABULARY_CONTRIBUTION]);

const modelParser = createParser(MODEL_CLI_VOCABULARY);

/** Normalize a kind word: aliases, plural stripping, `hierarchies` special. */
export function normalizeKind(word: string): Kind | null {
  return modelParser.normalizeKind(word) as Kind | null;
}

/** The typed command readers/writers consume — the generic shape with the
 *  verb/kind narrowed to this domain's unions. Sound because the parser above
 *  was built from exactly this domain's vocabulary. */
export interface Command extends GenericCommand {
  verb: Verb;
  kind: Kind | null;
}

export function parseCommand(logical: LogicalLine): Command {
  return modelParser.parseCommand(logical) as Command;
}

/** Parse a whole script: logical lines → commands. Throws on first error. */
export function parseScript(source: string): Command[] {
  return modelParser.parseScript(source) as Command[];
}

/** Narrow an engine-dispatched generic command at the domain boundary. */
export function asModelCommand(cmd: GenericCommand): Command {
  return cmd as Command;
}
