// FILENAME: app/extensions/ModelEditor/cli/help.ts
// PURPOSE: `help` output for the Model Editor command line: a general index
//          plus per-topic detail (verb or object kind). Kept as plain data so
//          the Monaco completion provider can reuse the syntax lines.

import { KINDS, normalizeKind } from "./parse";
import type { Kind } from "./parse";

const GENERAL = `Model Editor command line — one command per line.

Verbs:
  ls <kind> [pattern]          list objects (glob * and ? allowed)
  show <kind> <name>           full details of one object
  add <kind> …                 create an object
  set <kind> <name> key=value  change properties (wildcards allowed)
  rename <kind> <old> <new>    rename one object
  delete <kind> <name>         delete (wildcards allowed, asks first)
  refresh table <name>         re-fetch an InMemory table from its source
  materialize calctable <name> materialize a calculated table now
  validate                     model consistency check
  import tables|sql …          import source tables / a SQL query table
  connect source <name> …      wire a catalog source live
  undo / redo                  model edit history
  help [topic]  clear          this text / clear the output

Kinds:
  ${KINDS.join(", ")}

Notes:
  [Bracketed Names] or "quoted names" for names with spaces.
  A free-standing = starts a formula and takes THE REST OF THE COMMAND —
  put key=value options before it; indented lines continue the formula.
  Wildcard or multi-object edits preview + confirm, run as ONE undo step,
  and roll back entirely if any step fails.
  Full-line comments start with # or //.

'help <kind>' or 'help <verb>' shows details, e.g. 'help measure'.
The Reference button in the panel header opens the full guide as a side pane.`;

const TOPICS: Record<string, string> = {
  measure: `Measures:
  ls measures [pattern]
  show measure [Name]
  add measure [Name] [format="#,0"] [formatexpr="…"] [folder="Sales\\KPIs"]
              [hidden=true] [description="…"] [detailrows=T[c1],T[c2]] = <DAX>
  set measure [Pattern] folder="Archive" hidden=true format=…   (wildcards ok)
  set measure [Name] = <DAX>                                    (one measure)
  rename measure [Old] [New]
  delete measure [Pattern]
  Options go BEFORE the = (the formula takes the rest of the command).
  Empty value clears: format= description= folder=`,
  table: `Tables:
  ls tables [pattern]
  show table <name>
  set table <pattern> displayname="…" description="…" hidden=true
  set table <name> storage=<mode>
  set table <name> refresh=none|interval:300|daily:06:30|currentdate:Col [incremental="expr"]
  set table <name> source=<source>|none [schema=public] [sourcetable=orders]
  rename table <old> <new>        (sets the DISPLAY name)
  delete table <pattern>          (drops relationships that reference it)
  refresh table <pattern>         (re-fetch rows now)
  New tables come from: import tables, import sql, add calctable, add source.`,
  column: `Columns:
  ls columns [Table] | ls columns Table[pattern]
  show column Table[Column]
  add column Table[Name] [type=Float64] [description="…"] = <expression>
      (a formula referencing a measure becomes a context column automatically)
  set column T[pattern] hidden=true format="#,0" displayname= sortby= lookup=
  set column T[Name] = <expression>  [type=…]     (calculated columns)
  rename column Table[Old] [New]
  delete column T[pattern]        (calculated/context columns only)`,
  relationship: `Relationships:
  ls relationships [pattern | From -> To]
  add relationship From[col] -> To[col] [cardinality=m:1] [active=true]
      [propagation=auto|none|both] [name="…"] [ops=eq|gt|gte|lt|lte]
      Multi-column: From[a],From[b] -> To[x],To[y]
  set relationship <name | From -> To> active=false cardinality=1:1 …
  rename relationship <old> <new>
  delete relationship <name>
  delete relationship * -> Customer      (every relationship into Customer)
  delete relationship Sales -> *         (every relationship out of Sales)`,
  hierarchy: `Hierarchies:
  ls hierarchies [pattern]        show hierarchy <name>
  add hierarchy <Name> table=<T> levels=Col1,Col2,Col3
  set hierarchy <pattern> levels=… [table=…]
  rename hierarchy <old> <new>    delete hierarchy <pattern>`,
  kpi: `KPIs:
  ls kpis [pattern]               show kpi <name>
  add kpi <Name> base=[Measure] target=[Measure]|targetvalue=100
          bands=0:offTrack,50:atRisk,100:onTrack [description="…"]
  set kpi <pattern> …             rename kpi <old> <new>
  delete kpi <pattern>`,
  role: `Security roles (RLS/OLS):
  ls roles [pattern]              show role <name>
  add role <Name> filter="Sales[Region] = 'West'" filter="T[User] = @username"
           deny=SecretTable deny=T[SecretColumn]
  set role <pattern> filter=… deny=…    (given lists REPLACE existing ones)
  rename role <old> <new>         delete role <pattern>
  @username / @customdata make a filter dynamic.`,
  perspective: `Perspectives:
  ls perspectives [pattern]       show perspective <name>
  add perspective <Name> tables=A,B columns=T[c1],T[c2] measures=[M1],[M2]
  set perspective <pattern> tables=… columns=… measures=… description=…
  rename perspective <old> <new>  delete perspective <pattern>`,
  culture: `Cultures / translations:
  ls cultures                     ls translations <locale>
  add culture <locale>            (e.g. add culture sv-SE)
  rename culture <old> <new>      delete culture <pattern>
  set translation <locale> table <T> caption="…" [description="…"]
  set translation <locale> column T[c] caption="…"
  set translation <locale> measure [M] caption="…"
  delete translation <locale> measure [M]`,
  translation: `See 'help culture'.`,
  calcgroup: `Calculation groups:
  ls calcgroups                   show calcgroup <name>
  add calcgroup <Name>
  add calcitem Group[Item] = <DAX over SELECTEDMEASURE()>
  set calcitem Group[Item] = <DAX>
  rename calcgroup <old> <new>    rename calcitem Group[Old] [New]
  delete calcgroup <pattern>      delete calcitem Group[pattern]
  ls calcitems <group>`,
  calcitem: `See 'help calcgroup'.`,
  calctable: `Calculated tables (QUERY expressions):
  ls calctables [pattern]         show calctable <name>
  add calctable <Name> [dynamic=false] [table=<home>] = QUERY(…)
  set calctable <name> = QUERY(…) | set calctable <name> dynamic=false [cascade=true]
  materialize calctable <name>
  rename calctable <old> <new> [cascade=true]
  delete calctable <pattern> [cascade=true]`,
  tablevar: `Table variables:
  ls tablevars [pattern]          show tablevar <name>
  add tablevar <Name> source=<table> [filter="T[c] = value" …]
  set tablevar <pattern> source=… filter=…
  rename tablevar <old> <new>     delete tablevar <pattern>`,
  scriptfunction: `Script functions (Rhai):
  ls funcs [pattern]              show func <name>
  add func <Name> params=a:Int,b:Float returns=Float = <body>
  set func <name> params=… returns=… | set func <name> = <body>
  rename func <old> <new>         delete func <pattern>`,
  context: `Contexts:
  ls contexts [pattern]           show context <name>   (operations as JSON)
  add context <Name> ops='[{"type":"clear","filters":[],"clearTargets":[…],"inPredicates":[]}]'
  set context <name> ops='…'      (replaces the operation list)
  rename context <old> <new>      delete context <pattern>`,
  contextcolumn: `Context columns (measure-driven columns):
  ls contextcolumns [pattern]     show contextcolumn <name>
  delete contextcolumn <pattern>
  Create one with: add column Table[Name] = <expression referencing a [Measure]>`,
  writeback: `Writeback columns:
  ls writebacks [pattern]         show writeback <name>
  add writeback Table[Name] type=Float64 keys=colA,colB [kind=history|masterData]
      [projection=blank|latest|expression] [projexpr="…"] [required=true]
      [min=0] [max=100] [enum=a,b] [maxlength=50] [pattern="…"]
      [editors=user@x,user@y] [history=true]
  set writeback <pattern> …       rename writeback <old> <new>
  delete writeback <pattern>`,
  source: `Data sources:
  ls sources                      show source <name>
  add source [Display] kind=postgres|sqlServer|inMemory|csv|parquet
      host=… port=… database=… [schema=…] [auth=integrated|usernamePassword|environmentVariable]
      [ssl=require] [trustcert=true]
  set source <name> …             rename source <old> <new>
  delete source <pattern>
  connect source <name> connstr="<connection string>"
  ls sourcetables                 (tables visible in the connected source)
  set table <T> source=<name> schema=… sourcetable=…   (bind a table)`,
  sourcetable: `See 'help source'.`,
  extdata: `Extension data (namespaced vendor.feature JSON entries):
  ls extdata                      show extdata <key>
  set extdata <key> = <json>      delete extdata <key>`,
  model: `Model settings:
  show model
  set model name="…" version="…" author="…" description="…"
  set model datetable=<table>|none
  set model lookup="<default lookup expression>"    (lookup= clears)
  validate`,
  ls: `ls [kind] [pattern] — bare 'ls' prints a model summary. Patterns use
* and ? and match case-insensitively. Examples:
  ls tables Dim*        ls measures *YTD*      ls relationships * -> Customer
  ls columns Sales      ls calcitems TimeCalc  ls translations sv-SE`,
  show: `show <kind> <name> — every stored property of one object, formulas
included. 'show model' shows model metadata and settings.`,
  add: `add <kind> … — see 'help <kind>' for each kind's fields. The formula
comes LAST, after a free-standing = (options go before it), and indented
lines continue it:
  add measure [Margin] folder="KPIs" =
      VAR p = [Profit]
      RETURN DIVIDE(p, [Revenue])`,
  set: `set <kind> <target> key=value … — read-modify-write: anything you
don't mention is kept. Empty value clears (format=). Wildcards fan out over
every match (with a confirmation first), e.g.:
  set measure [Sales*] folder="Sales" hidden=false`,
  rename: `rename <kind> <old> <new> — 'to' reads naturally too:
  rename measure [Total] to [Total Sales]
Tables/physical columns keep their engine names; rename sets display names.`,
  delete: `delete <kind> <pattern> [cascade=true] — wildcards fan out and ask
first. Multi-deletes run as one undo step and roll back wholesale on error.
  delete relationship * -> Customer
  delete measure [tmp*]`,
  refresh: `refresh table <pattern> — re-fetch InMemory rows from the bound
source now. Not undoable (data, not model).`,
  materialize: `materialize calctable <name> — write a non-dynamic calculated
table's rows into its derived model table now.`,
  validate: `validate — run the engine's model consistency checks.`,
  import: `import tables schema.table,schema.other [schema=<default>]
import sql <TableName> = SELECT … — both need a connected source.`,
  connect: `connect source <name> connstr="<connection string>" — wire a
catalog source live so import/refresh can reach it.`,
  undo: `undo / redo — step through the model edit history (same stack as the
toolbar buttons). Must be run alone, not inside a script.`,
  redo: `See 'help undo'.`,
  help: GENERAL,
  clear: `clear — empty the output log.`,
};

export function helpText(topicWords: string[]): string {
  if (topicWords.length === 0) return GENERAL;
  const word = topicWords[0].toLowerCase();
  if (TOPICS[word]) return TOPICS[word];
  const kind = normalizeKind(word);
  if (kind && TOPICS[kind]) return TOPICS[kind];
  return `No help for '${topicWords.join(" ")}'. ${"\n\n"}${GENERAL}`;
}

/** Syntax summaries for the Monaco hover/completion (kind → first help line). */
export function kindSummary(kind: Kind): string {
  const t = TOPICS[kind];
  return t ? t.split("\n")[0] : kind;
}
