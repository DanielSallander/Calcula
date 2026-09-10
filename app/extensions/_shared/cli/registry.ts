// FILENAME: app/extensions/_shared/cli/registry.ts
// PURPOSE: The domain contract of the fused Calcula CLI. A CliDomain is one
//          subject area's contribution — its object kinds, extra verbs,
//          executors, batch strategy and help — registered into a CliEngine
//          (engine.ts) together with a live session. The model domain wraps
//          the Model Editor's readers/writers; the app domain drives the grid.
// CONTEXT: Kinds are globally unique across domains (asserted at build), so
//          `add measure` and `add sheet` dispatch by kind with zero syntax.
//          Design: docs/design/macro-model-recording-and-fused-cli.md.

import type { CliOptionTable } from "./optionSchema";
import type { CliVocabulary, GenericCommand } from "./parse";

/** Output sink of one run (the panel renders it into the log). */
export interface CliIo {
  /** Append a block of output. cls: "out" (default) | "err" | "info". */
  print(text: string, cls?: "out" | "err" | "info"): void;
  clear(): void;
}

export interface WritePreview {
  labels: string[];
  wildcard: boolean;
}

export interface CliNameSuggestion {
  label: string;
  insert: string;
  detail?: string;
}

export interface CliKindSpec<S> {
  /** Canonical kind name — UNIQUE ACROSS ALL DOMAINS (asserted at build). */
  kind: string;
  aliases?: string[];
  /** Appears in `ls` completion. */
  listable?: boolean;
  /** Options per verb — drives validation + completion + help. */
  options?: CliOptionTable;
  /** Live object names for completion (word ≥ 2). */
  nameSuggestions?(session: S): CliNameSuggestion[];
}

export interface CliVerbSpec {
  /** Canonical verb beyond the shared core (goto, refresh, materialize, …). */
  verb: string;
  aliases?: string[];
  /** Never takes an object kind (the parser skips kind detection). */
  kindless?: boolean;
}

/**
 * How this domain makes a multi-write run atomic — and what honestly happens
 * on a mid-run error. The model's strategy is a true rollback (batchCancel);
 * the grid's COMMITS the partial as one undo step, because the grid's
 * `cancelUndoTransaction` discards the undo record WITHOUT reverting (see
 * core/engine/src/undo.rs) and would strand the changes un-undoable.
 */
export interface CliBatchStrategy<S> {
  begin(session: S): Promise<void>;
  end(session: S): Promise<void>;
  /** Error recovery; the engine prints the outcome-appropriate message. */
  onError(session: S): Promise<"rolled-back" | "kept-partial">;
  /** Confirm-card wording, e.g. "one undo step, all-or-nothing". */
  confirmNote: string;
}

export interface CliDomain<S = unknown> {
  /** "model" | "app" */
  id: string;
  label: string;
  kinds: Array<CliKindSpec<S>>;
  verbs?: CliVerbSpec[];
  /** Extra kind aliases outside the per-kind lists (the model's
   *  `global`->calctable, or pseudo-kinds like `sql`). */
  extraKindAliases?: Record<string, string>;
  /** Irregular plurals for this domain's kinds. */
  pluralOverrides?: Record<string, string>;
  /** Verbs this domain answers as READS (ls/show/validate…). Anything else
   *  it owns routes to runWrite. */
  readVerbs: ReadonlySet<string>;
  runRead(cmd: GenericCommand, session: S, io: CliIo): Promise<void>;
  /** Labels for the confirm card, or null when the command is not a write
   *  (reads, navigation). Throws CliError on lookup errors. */
  previewWrite(cmd: GenericCommand, session: S): WritePreview | null;
  runWrite(cmd: GenericCommand, session: S, io: CliIo): Promise<void>;
  /** null = no atomicity: commands run sequentially, each its own undo. */
  batch: CliBatchStrategy<S> | null;
  /** Whether the session currently allows writes (read-only models…). */
  isWritable(session: S): boolean;
  undoRedo?: {
    undo(session: S, io: CliIo): Promise<void>;
    redo(session: S, io: CliIo): Promise<void>;
  };
  /** Help text for `help` / `help <topic>`; null = topic unknown here. */
  helpText(topic: string[]): string | null;
  /** Enforce the option schema on writes (see optionSchema.ts). */
  strictOptions?: boolean;
  /**
   * Whether this domain evaluates a `where` clause.
   *
   * FAIL CLOSED, and this is the whole reason the flag exists rather than the
   * kernel just handing the clause over and hoping. `delete measure * where
   * folder="Archive"` in a domain that parses `where` but ignores it does not
   * delete the archived measures — it deletes EVERY measure, reports success,
   * and the confirm card that should have shown three names showed three
   * hundred. A domain that does not set this gets a refusal, never a
   * broadened command.
   */
  supportsWhere?: boolean;
}

/** One registered domain + the live session its executors run against. */
export interface CliDomainBinding<S = unknown> {
  domain: CliDomain<S>;
  session: S;
}

// ---------------------------------------------------------------------------
// Vocabulary building
// ---------------------------------------------------------------------------

/** The verbs every domain shares. Aliases mirror the original model CLI. */
const CORE_VERBS: CliVerbSpec[] = [
  { verb: "ls", aliases: ["list"] },
  { verb: "show" },
  { verb: "add", aliases: ["create", "new"] },
  { verb: "set" },
  { verb: "rename", aliases: ["mv"] },
  { verb: "delete", aliases: ["del", "rm", "remove"] },
  { verb: "undo", kindless: true },
  { verb: "redo", kindless: true },
  { verb: "help", kindless: true },
  { verb: "clear", aliases: ["cls"], kindless: true },
];

/** One domain's parser-facing contribution — the data slice of CliDomain.
 *  Extracted so a domain's own standalone tooling (the Model Editor's typed
 *  parse.ts) can build a single-domain vocabulary from the SAME data the
 *  engine merges, with no second copy to drift. */
export interface CliVocabularyContribution {
  id: string;
  verbs?: CliVerbSpec[];
  kinds: Array<Pick<CliKindSpec<never>, "kind" | "aliases">>;
  extraKindAliases?: Record<string, string>;
  pluralOverrides?: Record<string, string>;
}

/**
 * Merge the core verbs and each contribution into one parser vocabulary.
 * Throws on a kind owned by two domains — uniqueness is what makes
 * kind-driven dispatch unambiguous, so a collision is a build error, never a
 * runtime surprise.
 */
export function mergeVocabulary(contribs: CliVocabularyContribution[]): CliVocabulary {
  const verbAliases: Record<string, string> = {};
  const verbs: string[] = [];
  const kindless = new Set<string>();

  const addVerb = (spec: CliVerbSpec): void => {
    if (!verbs.includes(spec.verb)) verbs.push(spec.verb);
    verbAliases[spec.verb] = spec.verb;
    for (const a of spec.aliases ?? []) verbAliases[a] = spec.verb;
    if (spec.kindless) kindless.add(spec.verb);
  };
  for (const v of CORE_VERBS) addVerb(v);
  for (const c of contribs) for (const v of c.verbs ?? []) addVerb(v);

  const kindAliases: Record<string, string> = {};
  const kinds: string[] = [];
  const kindOwner = new Map<string, string>();
  const pluralOverrides: Record<string, string> = {};

  for (const c of contribs) {
    for (const k of c.kinds) {
      const owner = kindOwner.get(k.kind);
      if (owner && owner !== c.id) {
        throw new Error(
          `CLI kind '${k.kind}' is claimed by both '${owner}' and '${c.id}' — ` +
            `kinds must be globally unique (rename one, e.g. 'gridtable')`,
        );
      }
      kindOwner.set(k.kind, c.id);
      if (!kinds.includes(k.kind)) kinds.push(k.kind);
      kindAliases[k.kind] = k.kind;
      for (const a of k.aliases ?? []) kindAliases[a] = k.kind;
    }
    for (const [alias, kind] of Object.entries(c.extraKindAliases ?? {})) {
      kindAliases[alias] = kind;
    }
    Object.assign(pluralOverrides, c.pluralOverrides ?? {});
  }

  return { verbAliases, verbs, kindAliases, kinds, kindless, pluralOverrides };
}

/** A domain's contribution slice (what mergeVocabulary consumes). */
export function contributionOf(domain: CliDomain<never> | CliDomain): CliVocabularyContribution {
  return {
    id: domain.id,
    verbs: domain.verbs,
    kinds: domain.kinds.map((k) => ({ kind: k.kind, aliases: k.aliases })),
    extraKindAliases: domain.extraKindAliases,
    pluralOverrides: domain.pluralOverrides,
  };
}

/** Vocabulary for a set of live bindings (the engine's entry point). */
export function buildVocabulary(bindings: CliDomainBinding[]): CliVocabulary {
  return mergeVocabulary(bindings.map((b) => contributionOf(b.domain)));
}

/** kind -> binding lookup for the engine's dispatch. */
export function kindOwners(bindings: CliDomainBinding[]): Map<string, CliDomainBinding> {
  const map = new Map<string, CliDomainBinding>();
  for (const b of bindings) {
    for (const k of b.domain.kinds) map.set(k.kind, b);
  }
  return map;
}
