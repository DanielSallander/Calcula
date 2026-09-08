// FILENAME: app/extensions/ModelEditor/cli/modelOptions.ts
// PURPOSE: The MODEL domain's declarative option vocabulary: ONE audited
//          CliOptionTable per object kind (verb -> accepted `key=` specs).
//          Drives STRICT validation (modelDomain refuses an unknown key= at
//          both preview and run, naming the valid keys), Monaco completion
//          (cliLanguage.ts derives its suggestions here) and help — ending
//          the documented triplication (writers.ts truth / cliLanguage
//          OPTION_KEYS hand-mirror / reference docs).
// AUDIT:   2026-08-14. Method: writers.ts was read end to end and EVERY
//          optStr/optList/optBool/optNum/optAll/opts.has() call was catalogued
//          per verb+kind dispatch path — including the pseudo/kindless-looking
//          paths: `import tables` (parses as kind "table"), `import sql`,
//          `connect source`, `set model`, `set|delete translation`,
//          `set|delete extdata`, and `rename|delete calctable`'s cascade=.
//          The tables record what the CODE reads, not what the old mirror or
//          the docs claimed (the differences are reported in the audit notes
//          of the strict-options change, not "fixed" here). readers.ts
//          consumes NO options — ls/show/validate are positional-only — so
//          reads stay lenient. No model verb reads options while
//          cmd.kind === null, so the kindless table is EMPTY: a stray option
//          there errors as "takes no options here".
// UPDATE:  2026-08-25. `transform table` joined the table kind. Its specs are
//          NOT re-typed here: TRANSFORM_STEP_OPTIONS lives next to the builder
//          that reads them (transformSteps.ts), so the audit is structural
//          rather than a re-reading. Same for DATA_TYPE_VALUES, which now
//          derives from dataTypes.ts instead of being a third hand copy.

import { mergeVocabulary } from "../../_shared/cli/registry";
import { validateOptions } from "../../_shared/cli/optionSchema";
import type { CliOptionSpec, CliOptionTable } from "../../_shared/cli/optionSchema";
import { MODEL_VOCABULARY_CONTRIBUTION } from "./parse";
import type { Command, Kind } from "./parse";
import { DATA_TYPE_NAMES } from "./dataTypes";
import { TRANSFORM_STEP_OPTIONS } from "./transformSteps";

// ---------------------------------------------------------------------------
// Shared spec lists (add/set accept the same keys for most kinds)
// ---------------------------------------------------------------------------

const MEASURE_PROPS: CliOptionSpec[] = [
  { key: "format", type: "string", help: "number format string (empty clears)" },
  { key: "formatexpr", type: "string", help: "dynamic format expression (empty clears)" },
  { key: "folder", type: "string", help: "display folder, \\ nests (empty clears)" },
  { key: "hidden", type: "boolean", help: "hide from field lists" },
  { key: "description", type: "string", help: "description (empty clears)" },
  { key: "detailrows", type: "list", help: "DETAILROWS projection T[c1],T[c2] (empty clears)" },
];

/** The engine's own spellings, from the ONE table that also parses them. */
const DATA_TYPE_VALUES: string[] = [...DATA_TYPE_NAMES];

const RELATIONSHIP_SET_PROPS: CliOptionSpec[] = [
  {
    key: "cardinality",
    type: "enum",
    values: ["m:1", "1:m", "1:1", "m:m", "manyToOne", "oneToMany", "oneToOne", "manyToMany"],
    help: "join cardinality (default m:1)",
  },
  { key: "active", type: "boolean", help: "active vs inactive (USERELATIONSHIP)" },
  { key: "propagation", type: "string", help: "filter propagation: auto | none | both" },
];

const HIERARCHY_PROPS: CliOptionSpec[] = [
  { key: "table", type: "string", help: "the hierarchy's home table" },
  { key: "levels", type: "list", help: "ordered column list, top level first (replaces)" },
];

const KPI_PROPS: CliOptionSpec[] = [
  { key: "base", type: "string", help: "the measured value, [Measure]" },
  { key: "target", type: "string", help: "target measure (clears targetvalue)" },
  { key: "targetvalue", type: "number", help: "constant target (clears target measure)" },
  { key: "bands", type: "list", help: "threshold:status — status offTrack | atRisk | onTrack" },
  { key: "description", type: "string", help: "description (empty clears)" },
];

const ROLE_PROPS: CliOptionSpec[] = [
  { key: "filter", type: "string", help: 'row filter "T[col] <op> value"; repeatable (replaces on set)' },
  { key: "deny", type: "list", help: "OLS denial: Table or T[col]; repeatable (replaces on set)" },
];

const PERSPECTIVE_PROPS: CliOptionSpec[] = [
  { key: "tables", type: "list", help: "tables shown in full (replaces on set)" },
  { key: "columns", type: "list", help: "individually shown T[col] refs (replaces on set)" },
  { key: "measures", type: "list", help: "shown measures (replaces on set)" },
  { key: "description", type: "string", help: "description (empty clears)" },
];

const CALCTABLE_PROPS: CliOptionSpec[] = [
  { key: "dynamic", type: "boolean", help: "true = per query (default); false = materialized" },
  { key: "table", type: "string", help: "home table (default: inferred from the expression)" },
  { key: "cascade", type: "boolean", help: "also remove objects bound to the materialized table" },
];

const CASCADE_ONLY: CliOptionSpec[] = [CALCTABLE_PROPS[2]];

const TABLEVAR_PROPS: CliOptionSpec[] = [
  { key: "source", type: "string", help: "base table or another table variable" },
  { key: "filter", type: "string", help: 'row predicate "T[col] <op> value"; repeatable (replaces on set)' },
];

const SCRIPTFUNCTION_PROPS: CliOptionSpec[] = [
  { key: "params", type: "list", help: "name:Type,… — types Int Float Bool String" },
  { key: "returns", type: "string", help: "return type: Int Float Bool String (default Float)" },
];

const WRITEBACK_PROPS: CliOptionSpec[] = [
  { key: "type", type: "enum", values: DATA_TYPE_VALUES, help: "value data type" },
  { key: "keys", type: "list", help: "key columns on the host table (submission identity)" },
  { key: "kind", type: "string", help: "history | masterData" },
  { key: "projection", type: "string", help: "blank | latest | expression" },
  { key: "projexpr", type: "string", help: "projection expression (projection=expression; empty clears)" },
  { key: "required", type: "boolean", help: "value required" },
  { key: "min", type: "number", help: "numeric lower bound" },
  { key: "max", type: "number", help: "numeric upper bound" },
  { key: "enum", type: "list", help: "allowed values a,b,c" },
  { key: "maxlength", type: "number", help: "max text length" },
  { key: "pattern", type: "string", help: "text regex pattern (empty clears)" },
  { key: "editors", type: "list", help: "allowed editor identities (empty = everyone)" },
  { key: "history", type: "boolean", help: "expose the history table to reports" },
];

const SOURCE_PROPS: CliOptionSpec[] = [
  { key: "kind", type: "string", help: "postgres | sqlServer | inMemory | csv | parquet" },
  { key: "host", type: "string", help: "server host (empty clears)" },
  { key: "port", type: "number", help: "server port" },
  { key: "database", type: "string", help: "database, or directory for csv/parquet (empty clears)" },
  { key: "schema", type: "string", help: "default schema (empty clears)" },
  { key: "auth", type: "string", help: "integrated | usernamePassword | environmentVariable" },
  { key: "ssl", type: "string", help: "TLS mode: disable | prefer | require (empty clears)" },
  { key: "trustcert", type: "boolean", help: "trust the server certificate" },
];

// ---------------------------------------------------------------------------
// Insights strategy (app/src-tauri/src/insights/strategy) — the vocabulary the
// Strategy tab writes, reachable from the command line by the same keys.
//
// The measure and column rows are APPENDED to the model-metadata rows for the
// same kinds rather than given a kind of their own, because that is the
// grammar: `set measure Revenue direction=lowerIsBetter` addresses the same
// object as `set measure Revenue format="0.0"`. writers.ts routes per KEY —
// a command carrying both edits both, each through its own endpoint.
// ---------------------------------------------------------------------------

const DIRECTION_VALUES = ["higherIsBetter", "lowerIsBetter", "targetBand", "neutral"];
const UNIT_VALUES = ["currency", "percent", "ratio", "count", "duration", "other"];
const CADENCE_VALUES = ["daily", "weekly", "monthly", "quarterly", "yearly"];
const ROLE_VALUES = ["key", "analysis", "label", "filter", "hierarchy", "ignore"];

const MEASURE_STRATEGY_PROPS: CliOptionSpec[] = [
  { key: "direction", type: "enum", values: DIRECTION_VALUES, help: "which way is good (empty clears)" },
  { key: "unit", type: "enum", values: UNIT_VALUES, help: "the measure's unit (empty clears)" },
  {
    key: "target",
    type: "string",
    help: "1000 | kpi | measure:<Name> | band:<low>,<high> (empty clears)",
  },
  { key: "materiality", type: "string", help: "1000 (absolute) | 2% (relative) (empty clears)" },
  { key: "cadence", type: "enum", values: CADENCE_VALUES, help: "reporting cadence (empty clears)" },
  { key: "priority", type: "number", help: "ranking priority; ties break by it (empty clears)" },
  { key: "analysisdims", type: "list", help: "Table[Column] refs worth breaking this down by (replaces)" },
  { key: "neverslice", type: "list", help: "Table[Column] refs that must never slice it (replaces)" },
  { key: "reviewed", type: "boolean", help: "mark the entry as agreed by a human" },
];

const COLUMN_STRATEGY_PROPS: CliOptionSpec[] = [
  {
    key: "role",
    type: "enum",
    values: ROLE_VALUES,
    help: "what the column is FOR; only analysis/filter/hierarchy may scope a rule",
  },
  { key: "priority", type: "number", help: "ranking priority within its table (empty clears)" },
];

const RULE_PROPS: CliOptionSpec[] = [
  { key: "measure", type: "string", help: "the measure this rule annotates (required)" },
  { key: "scope", type: "string", help: '"Dept=A;Region=Nordics,Baltics"; a date range is from..to' },
  { key: "direction", type: "enum", values: DIRECTION_VALUES, help: "direction in this scope" },
  { key: "target", type: "string", help: "1000 | kpi | measure:<Name> | band:<low>,<high>" },
  { key: "materiality", type: "string", help: "1000 (absolute) | 2% (relative)" },
  { key: "cadence", type: "enum", values: CADENCE_VALUES, help: "cadence in this scope" },
  { key: "suppress", type: "list", help: "fact KINDS to withhold here (it can only take facts away)" },
  { key: "rankweight", type: "number", help: "multiplier on this measure's ranking score here" },
  { key: "note", type: "string", help: "prose; reaches wording only, never which facts exist" },
];

const TRANSLATION_PROPS: CliOptionSpec[] = [
  { key: "caption", type: "string", help: "translated display name (empty clears)" },
  { key: "description", type: "string", help: "translated description (empty clears)" },
];

// ---------------------------------------------------------------------------
// Per-kind tables (verb -> specs). An explicit [] row documents "this verb is
// supported here but takes no options"; a verb absent from a table behaves
// identically under strict validation.
// ---------------------------------------------------------------------------

export const MODEL_OPTION_TABLES: Partial<Record<Kind, CliOptionTable>> = {
  measure: {
    add: MEASURE_PROPS,
    set: [...MEASURE_PROPS, ...MEASURE_STRATEGY_PROPS],
    rename: [],
    delete: [],
  },
  table: {
    set: [
      { key: "displayname", type: "string", help: "display name (empty clears to engine name)" },
      { key: "description", type: "string", help: "description (empty clears)" },
      { key: "hidden", type: "boolean", help: "hide from field lists" },
      { key: "storage", type: "string", help: "storage mode (e.g. InMemory)" },
      {
        key: "refresh",
        type: "list",
        help: "none | interval:<secs> | daily:HH:MM | currentdate:<col> (comma-combine; none clears)",
      },
      { key: "incremental", type: "string", help: "incremental-refresh filter expression (empty clears)" },
      { key: "source", type: "string", help: "bind to a catalog source; empty or none unbinds" },
      { key: "schema", type: "string", help: "source-side schema for the binding" },
      { key: "sourcetable", type: "string", help: "source-side table name for the binding" },
    ],
    rename: [],
    delete: [],
    refresh: [],
    import: [{ key: "schema", type: "string", help: "default schema for unqualified table names" }],
    // `transform table <T> add <stepType> …` — ONE flat row, because the
    // kernel validates options per VERB, not per positional subaction. The
    // specs are declared beside the builder that reads them
    // (transformSteps.ts), which also refuses a key that means nothing to the
    // step type actually being added.
    transform: TRANSFORM_STEP_OPTIONS,
  },
  column: {
    add: [
      { key: "type", type: "enum", values: DATA_TYPE_VALUES, help: "data type (default Float64)" },
      { key: "description", type: "string", help: "description" },
    ],
    set: [
      { key: "type", type: "enum", values: DATA_TYPE_VALUES, help: "data type (calculated/context columns)" },
      { key: "description", type: "string", help: "description (empty clears)" },
      { key: "hidden", type: "boolean", help: "hide from field lists" },
      { key: "format", type: "string", help: "number format in pivots (empty clears)" },
      { key: "displayname", type: "string", help: "display name (empty clears)" },
      { key: "sortby", type: "string", help: "sort this column by another (empty clears)" },
      { key: "lookup", type: "string", help: "lookup-resolution expression (empty clears)" },
      ...COLUMN_STRATEGY_PROPS,
    ],
    rename: [],
    delete: [],
  },
  relationship: {
    add: [
      ...RELATIONSHIP_SET_PROPS,
      { key: "name", type: "string", help: "explicit name (default From_To, uniquified)" },
      {
        key: "ops",
        type: "enum",
        values: ["eq", "gt", "gte", "lt", "lte"],
        help: "join operator(s): one, or one per condition (default eq)",
      },
    ],
    set: RELATIONSHIP_SET_PROPS,
    rename: [],
    delete: [],
  },
  hierarchy: {
    add: HIERARCHY_PROPS,
    set: HIERARCHY_PROPS,
    rename: [],
    delete: [],
  },
  kpi: {
    add: KPI_PROPS,
    set: KPI_PROPS,
    rename: [],
    delete: [],
  },
  role: {
    add: ROLE_PROPS,
    set: ROLE_PROPS,
    rename: [],
    delete: [],
  },
  perspective: {
    add: PERSPECTIVE_PROPS,
    set: PERSPECTIVE_PROPS,
    rename: [],
    delete: [],
  },
  culture: {
    add: [],
    rename: [],
    delete: [],
  },
  translation: {
    set: TRANSLATION_PROPS,
    delete: [],
  },
  calcgroup: {
    add: [],
    rename: [],
    delete: [],
  },
  calcitem: {
    add: [],
    set: [],
    rename: [],
    delete: [],
  },
  calctable: {
    add: CALCTABLE_PROPS,
    set: CALCTABLE_PROPS,
    rename: CASCADE_ONLY,
    delete: CASCADE_ONLY,
    materialize: [],
  },
  tablevar: {
    add: TABLEVAR_PROPS,
    set: TABLEVAR_PROPS,
    rename: [],
    delete: [],
  },
  scriptfunction: {
    add: SCRIPTFUNCTION_PROPS,
    set: SCRIPTFUNCTION_PROPS,
    rename: [],
    delete: [],
  },
  context: {
    add: [],
    set: [],
    rename: [],
    delete: [],
  },
  contextcolumn: {
    delete: [],
  },
  writeback: {
    add: WRITEBACK_PROPS,
    set: [
      ...WRITEBACK_PROPS,
      { key: "name", type: "string", help: "rename the writeback column" },
    ],
    rename: [],
    delete: [],
  },
  source: {
    add: SOURCE_PROPS,
    set: [
      ...SOURCE_PROPS,
      { key: "name", type: "string", help: "display name (empty clears)" },
    ],
    rename: [],
    delete: [],
    connect: [
      { key: "connstr", type: "string", help: "connection string (transient; never persisted)" },
    ],
  },
  sourcetable: {}, // read-only kind (ls sourcetables) — no write options
  extdata: {
    set: [],
    delete: [],
  },
  model: {
    set: [
      { key: "name", type: "string", help: "model name (empty clears)" },
      { key: "version", type: "string", help: "model version (empty clears)" },
      { key: "author", type: "string", help: "model author (empty clears)" },
      { key: "description", type: "string", help: "model description (empty clears)" },
      { key: "datetable", type: "string", help: "mark the date table; empty or none clears" },
      { key: "lookup", type: "string", help: "model-default lookup resolution (empty clears)" },
    ],
  },
  sql: {
    import: [], // import sql <Name> = <SELECT …> — the query is the expr tail
  },
  strategy: {
    // `show strategy` / `validate strategy` are reads and take no options, so
    // they are absent for the same reason ls/show are absent everywhere else.
    test: [],
    infer: [],
  },
  rule: {
    // `add rule <id>` upserts by id: an id already in the document is
    // REPLACED, because a duplicate id is a validation ERROR (a finding names
    // the rule that produced it, so ids have to be unique).
    add: RULE_PROPS,
    delete: [],
  },
};

/** No model verb reads options while cmd.kind === null (audited above), so a
 *  kind-null write validates against an EMPTY table: any `key=` errors with
 *  "takes no options here". */
export const MODEL_KINDLESS_OPTIONS: CliOptionTable = {};

// ---------------------------------------------------------------------------
// Lookup + validation entry points
// ---------------------------------------------------------------------------

export function modelOptionTableFor(kind: Kind | null): CliOptionTable | undefined {
  return kind === null ? MODEL_KINDLESS_OPTIONS : MODEL_OPTION_TABLES[kind];
}

/** Strict option validation for every write-routed model command — called at
 *  the TOP of both previewWrite and runWrite (reads consume no options and
 *  stay lenient). Throws CliError naming the valid keys. */
export function validateModelOptions(cmd: Command): void {
  validateOptions(cmd, modelOptionTableFor(cmd.kind), true);
}

// ---------------------------------------------------------------------------
// Completion derivation (replaces cliLanguage.ts's hand-mirrored OPTION_KEYS)
// ---------------------------------------------------------------------------

/** Verb aliases from the SAME contribution the parser is built from. */
const MODEL_VERB_ALIASES = mergeVocabulary([MODEL_VOCABULARY_CONTRIBUTION]).verbAliases;

/** The option specs to suggest for one typed verb word + normalized kind
 *  ([] when the verb accepts no options there, or is unknown). */
export function modelOptionSpecsFor(verbWord: string, kind: Kind): CliOptionSpec[] {
  const verb = MODEL_VERB_ALIASES[verbWord.toLowerCase()];
  if (!verb) return [];
  return modelOptionTableFor(kind)?.[verb] ?? [];
}
