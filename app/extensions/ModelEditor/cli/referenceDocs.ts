// FILENAME: app/extensions/ModelEditor/cli/referenceDocs.ts
// PURPOSE: The command line's full reference guide, as Markdown topics
//          rendered by the shared docs renderer (FunctionDocsPanel's
//          Markdown subset: headings, lists, tables, fenced code, and
//          `topic.md` cross-links that navigate within the pane).
// NOTE:    Topic ids must be [A-Za-z0-9_] — the renderer's link regex only
//          navigates `(id.md)` targets of that shape.

export interface CliRefTopic {
  /** Link target id ([A-Za-z0-9_] only). */
  id: string;
  title: string;
  group: "Guide" | "Verbs" | "Objects";
  /** One-line summary for the topic list. */
  summary: string;
  markdown: string;
}

export const CLI_REFERENCE: CliRefTopic[] = [
  // =========================================================================
  // Guide
  // =========================================================================
  {
    id: "overview",
    title: "Overview",
    group: "Guide",
    summary: "What the command line is and how a run executes.",
    markdown: `# Command line overview

Everything the visual Model Editor can do, as typed commands. The panel opens
with **Ctrl+\`** or the **Command Line** button in the top bar. Commands go
through the exact same gateway as the visual editor's buttons, so every edit
is undoable, persists with the workbook, and notifies the main window.

## Two modes

- **Prompt** — one command at a time. **Enter** runs, **↑ / ↓** browse history.
- **Script** — many commands, one per line. **Ctrl+Enter** (or the Run button)
  runs the whole script. Scripts can be saved by name (see [scripts](scripts.md)).

## Anatomy of a command

\`\`\`
verb  kind    target            options              formula
set   measure [Margin]          folder="KPIs"
add   measure [Margin]          format="0.0%"        = DIVIDE([P], [R])
\`\`\`

| Verb | Does |
| --- | --- |
| [ls](ls.md) | list objects (patterns allowed) |
| [show](show.md) | full details of one object |
| [add](add.md) | create an object |
| [set](set.md) | change properties (read-modify-write) |
| [rename](rename.md) | rename one object |
| [delete](delete.md) | delete objects (patterns allowed) |
| refresh | re-fetch an InMemory [table](table.md)'s rows |
| materialize | materialize a [calculated table](calctable.md) now |
| validate | model consistency check (see [model](model.md)) |
| import | import [source](source.md) tables or a SQL query table |
| connect | wire a [source](source.md) live |
| [undo / redo](undo_redo.md) | step through model edit history |
| help | in-panel quick help (\`help\`, \`help measure\`, …) |
| clear | empty the output log |

## Safety

- A run with **more than one edit**, or any [wildcard](wildcards.md) edit,
  first shows the affected objects and asks for confirmation.
- Multi-edit runs execute as **one undo step** and roll back **entirely**
  if any step fails (see [scripts](scripts.md)).
- Read-only models (package subscriptions) reject every edit.`,
  },
  {
    id: "syntax",
    title: "Syntax & grammar",
    group: "Guide",
    summary: "Names, quoting, options, the formula tail, continuations, comments.",
    markdown: `# Syntax & grammar

## Names

- Plain names are bare words: \`Sales\`, \`sv-SE\`, \`Orders_Customer\`.
- Names with spaces or symbols use **[brackets]** or **"quotes"**:
  \`[Total Sales]\`, \`"Dim Customer"\`.
- Double a quote or bracket to escape it inside a name: \`"He said ""hi"""\`,
  \`[weird ]] name]\`.
- Column references are qualified: \`Sales[Amount]\`, \`"Dim Customer"[Full Name]\`.
- Measures are conventionally bracketed: \`[Total Sales]\` (a single bare word
  also works: \`delete measure Profit\`).

## Options — \`key=value\`, before the formula

Options are \`key=value\` pairs with the \`=\` **glued to the key**:

\`\`\`
set measure [M] folder="Sales\\Core" hidden=true format="#,0"
\`\`\`

- Booleans: \`true/false\`, \`yes/no\`, \`on/off\`, \`1/0\`.
- Lists use commas: \`levels=Country,State,City\`, \`keys=T[a],T[b]\`.
- An **empty value clears** the property: \`format=\` \`description=\` \`folder=\`.
- Repeatable options repeat the key: \`filter="…" filter="…"\`.

## The formula tail — a free-standing \`=\`

A \`=\` with space around it starts the **formula**, which takes the entire
rest of the command, verbatim — nothing after it is parsed as CLI syntax.
That is why options must come **before** the \`=\`:

\`\`\`
add measure [Margin] format="0.0%" = DIVIDE([Profit], [Revenue])
\`\`\`

**Indented lines continue the command** — this is how multi-line DAX works:

\`\`\`
add measure [Margin] folder="KPIs" =
    VAR p = [Profit]
    RETURN DIVIDE(p, [Revenue])
\`\`\`

## Comments

Full-line comments start with \`#\` or \`//\` (only at the start of a line —
a \`#\` inside a format string is safe).

## Case

Verbs, kinds, option keys and name **matching** are case-insensitive.
Kinds accept singular or plural and common shorthands: \`rel(s)\`,
\`col(s)\`, \`func(s)\`, \`calculationgroup(s)\`, \`global(s)\`, …`,
  },
  {
    id: "wildcards",
    title: "Wildcards",
    group: "Guide",
    summary: "Glob patterns: where they work and how confirmation behaves.",
    markdown: `# Wildcards

Patterns use \`*\` (any run of characters) and \`?\` (one character), matching
case-insensitively against the whole name.

- **Reads** filter listings: \`ls measures *YTD*\`, \`ls tables Dim*\`.
- **Writes** fan out over every match: \`set\`, \`delete\`, \`refresh\`.
  Before running, the panel lists every affected object and asks for
  confirmation. The expanded edits run as **one undo step** and roll back
  together on any error.

Both parts of a column reference can be patterns: \`Sales[*]\`, \`*[*Id]\`.

[Relationships](relationship.md) also match by **endpoint pattern**:

\`\`\`
delete relationship * -> Customer        # every relationship INTO Customer
delete relationship Sales -> *           # every relationship OUT OF Sales
ls relationships Sales[CustomerId] -> *
\`\`\`

Restrictions:

- \`rename\` and \`add\` require exact names (no patterns).
- A formula \`= …\` can be set on **one** object only, never a pattern match
  of several.`,
  },
  {
    id: "scripts",
    title: "Scripts & batches",
    group: "Guide",
    summary: "Multi-command runs: one undo step, all-or-nothing, saved scripts.",
    markdown: `# Scripts & batches

Switch the panel to **Script** mode for multi-command runs — one command per
line, \`#\` comments, indented continuation lines for formulas. **Ctrl+Enter**
runs the script.

\`\`\`
# Rebuild the Customer relationships
delete relationship * -> Customer
add relationship Sales[CustomerId] -> Customer[Id] cardinality=m:1
add relationship Orders[CustomerId] -> Customer[Id] cardinality=m:1
set measure [Total Sales] folder="Core"
\`\`\`

## Batch semantics

Any run with more than one edit (a script, or a single wildcard command that
expands to several objects) executes inside a backend **edit batch**:

- The whole run is **one undo step** — one click of Undo restores the model
  as it was before the run.
- It is **all-or-nothing** — if any command fails, everything already done
  in the run is rolled back and the error (with its line number) is printed.
- \`undo\` / \`redo\` cannot appear inside a script (they would consume the
  batch's own snapshot). Run them alone from the prompt.

## Saved scripts

In Script mode the header has a saved-scripts picker plus **Save…** and
**Delete**. Saved scripts are stored on this machine (browser storage of the
Model Editor window), so treat them as personal snippets — for sharing,
paste the text anywhere you like; it is plain text.

## Execution order details

- Commands run **sequentially**; each sees the model as the previous
  command left it. A wildcard on line 5 matches what exists *after* lines
  1–4 ran.
- The confirmation preview expands wildcards against the model as it is
  **before** the run — the live expansion can differ if earlier lines
  create or remove matches.`,
  },

  // =========================================================================
  // Verbs
  // =========================================================================
  {
    id: "ls",
    title: "ls — list",
    group: "Verbs",
    summary: "List objects of a kind, optionally filtered by a pattern.",
    markdown: `# ls

\`\`\`
ls                      # model summary (counts of everything)
ls <kind> [pattern]
\`\`\`

Lists are aligned text tables; long cells (formulas) are truncated — use
[show](show.md) for the full text. Patterns are [wildcards](wildcards.md).

\`\`\`
ls tables Dim*
ls columns Sales                # all columns of tables matching "Sales"
ls columns *[*Id]               # every column ending in Id
ls measures *YTD*
ls relationships * -> Customer
ls calcitems TimeCalc           # items of one calculation group
ls translations sv-SE           # one culture's entries
ls sourcetables                 # tables visible in the connected source
ls extdata
\`\`\`

\`list\` is an alias.`,
  },
  {
    id: "show",
    title: "show — details",
    group: "Verbs",
    summary: "Every stored property of one object, formulas included.",
    markdown: `# show

\`\`\`
show <kind> <name>
show model
\`\`\`

Prints every stored property of the object, including full formulas,
role filters, KPI bands, hierarchy levels, and (for tables) the column list.

\`\`\`
show measure [Total Sales]
show table Sales
show column Sales[Margin]
show relationship Sales_Customer
show calcgroup TimeCalc
show extdata vendor.feature
show model
\`\`\``,
  },
  {
    id: "add",
    title: "add — create",
    group: "Verbs",
    summary: "Create an object; formulas come last after a free-standing =.",
    markdown: `# add

\`\`\`
add <kind> <Name> [options] [= <formula>]
\`\`\`

Creates a new object. Names must be exact (no [wildcards](wildcards.md)).
Options come **before** the \`=\`; the formula takes the rest of the command
(see [syntax](syntax.md)). \`create\` and \`new\` are aliases.

Each kind's fields are on its own page:
[measure](measure.md), [column](column.md), [relationship](relationship.md),
[hierarchy](hierarchy.md), [kpi](kpi.md), [role](role.md),
[perspective](perspective.md), [culture](culture.md),
[calcgroup](calcgroup.md), [calctable](calctable.md),
[tablevar](tablevar.md), [scriptfunction](scriptfunction.md),
[context](context.md), [writeback](writeback.md), [source](source.md).

There is no \`add table\` — tables come from \`import tables\`, \`import sql\`,
\`add calctable\`, or writeback columns (see [table](table.md)).`,
  },
  {
    id: "set",
    title: "set — change properties",
    group: "Verbs",
    summary: "Read-modify-write: only the keys you give change.",
    markdown: `# set

\`\`\`
set <kind> <target> key=value …
set <kind> <name> = <formula>
\`\`\`

**Read-modify-write**: properties you don't mention keep their values.
An **empty value clears**: \`format=\` \`description=\` \`folder=\`.

The target may be a [wildcard](wildcards.md) — the change fans out over
every match (with confirmation):

\`\`\`
set measure [tmp*] folder="Scratch" hidden=true
set column Sales[*] format="#,0"
set relationship * -> Customer active=false
\`\`\`

A formula (\`= …\`) can be set on **one** object only:

\`\`\`
set measure [Margin] = DIVIDE([Profit], [Revenue])
set calctable TopCustomers = QUERY(...)
\`\`\`

Special forms: \`set model …\` ([model](model.md)) and
\`set translation …\` ([culture](culture.md)).`,
  },
  {
    id: "rename",
    title: "rename",
    group: "Verbs",
    summary: "Rename one object; 'to' is optional filler.",
    markdown: `# rename

\`\`\`
rename <kind> <old> <new>
rename <kind> <old> to <new>
\`\`\`

The old name must match exactly one object; the new name is taken literally.
Everything else about the object is carried over unchanged. \`mv\` is an alias.

\`\`\`
rename measure [Total] to [Total Sales]
rename relationship Sales_Customer SalesToCustomer
rename calcitem TimeCalc[YTD] [Year to Date]
rename culture sv sv-SE
\`\`\`

**Tables and physical columns keep their engine names** (bindings and
formulas depend on them) — renaming those sets the *display name*, exactly
like the visual editor. Calculated/context columns and every other kind get
a true rename.`,
  },
  {
    id: "delete",
    title: "delete",
    group: "Verbs",
    summary: "Delete objects; wildcards fan out with confirmation + rollback.",
    markdown: `# delete

\`\`\`
delete <kind> <pattern> [cascade=true]
\`\`\`

\`rm\`, \`del\` and \`remove\` are aliases. Patterns fan out (see
[wildcards](wildcards.md)); multi-deletes are one undo step and roll back
together on error.

\`\`\`
delete measure [tmp*]
delete relationship * -> Customer
delete column Sales[Margin]          # calculated/context columns only
delete calctable OldSnapshot cascade=true
delete translation sv-SE measure [Total Sales]
delete extdata vendor.feature
\`\`\`

Notes:

- Deleting a **table** drops the relationships that reference it; it is
  refused while measures/columns still reference the table.
- Deleting a **measure** is refused while other measures reference it —
  delete dependents first (the rollback keeps a half-done script safe).
- \`cascade=true\` on a [calculated table](calctable.md) also removes
  everything bound to its materialized table.`,
  },
  {
    id: "undo_redo",
    title: "undo / redo",
    group: "Verbs",
    summary: "Step through the model edit history.",
    markdown: `# undo / redo

\`\`\`
undo
redo
\`\`\`

The same per-model history as the toolbar buttons (each holds up to 50
snapshots). A multi-command run is **one** entry, so one \`undo\` reverses a
whole script.

They must be run **alone** — not inside a script — because a script executes
inside an edit batch whose own snapshot they would consume.

Model-edit history is separate from the grid's cell undo stack in the main
window.`,
  },

  // =========================================================================
  // Objects
  // =========================================================================
  {
    id: "measure",
    title: "Measures",
    group: "Objects",
    summary: "DAX measures: formula, format, folder, visibility, detail rows.",
    markdown: `# Measures

\`\`\`
ls measures [pattern]
show measure [Name]
add measure [Name] [options] = <DAX>
set measure [pattern] key=value …
set measure [Name] = <DAX>
rename measure [Old] [New]
delete measure [pattern]
\`\`\`

| Option | Value | Effect |
| --- | --- | --- |
| \`format=\` | \`"#,0"\` | Excel-style number format (empty clears) |
| \`formatexpr=\` | \`"…"\` | dynamic format expression, evaluated per query |
| \`folder=\` | \`"Sales\\KPIs"\` | display folder; \`\\\` nests (empty = ungrouped) |
| \`hidden=\` | \`true/false\` | hide from field lists |
| \`description=\` | \`"…"\` | description |
| \`detailrows=\` | \`T[c1],T[c2]\` | DETAILROWS drill projection (empty = default) |

The home table is inferred from the formula's column references.

\`\`\`
add measure [Margin %] format="0.0%" folder="KPIs" =
    VAR p = [Profit]
    RETURN DIVIDE(p, [Total Sales])

set measure [Sales*] folder="Sales" hidden=false
set measure [Total Sales] detailrows=Sales[Id],Sales[Amount]
delete measure [tmp*]
\`\`\``,
  },
  {
    id: "table",
    title: "Tables",
    group: "Objects",
    summary: "Display name, visibility, storage mode, refresh, source binding.",
    markdown: `# Tables

\`\`\`
ls tables [pattern]
show table <name>
set table <pattern> displayname="…" description="…" hidden=true
set table <name> storage=<mode>
set table <name> refresh=… [incremental="…"]
set table <name> source=<source>|none [schema=…] [sourcetable=…]
rename table <old> <new>            # sets the DISPLAY name
delete table <pattern>
refresh table <pattern>
\`\`\`

| Option | Value | Effect |
| --- | --- | --- |
| \`displayname=\` | \`"…"\` | display name (empty clears back to engine name) |
| \`description=\` | \`"…"\` | description |
| \`hidden=\` | \`true/false\` | hide from field lists |
| \`storage=\` | mode string | storage mode (see current values in \`ls tables\`) |
| \`refresh=\` | see below | InMemory auto-refresh strategies |
| \`incremental=\` | \`"expr"\` | incremental-refresh filter (empty clears) |
| \`source=\` | source name or \`none\` | bind/unbind a catalog [source](source.md) |
| \`schema=\` \`sourcetable=\` | names | source-side location for the binding |

**Refresh strategies** (comma-combine several; \`refresh=none\` clears):

\`\`\`
set table Sales refresh=interval:300            # every 300 s
set table Sales refresh=daily:06:30             # daily after 06:30
set table Sales refresh=currentdate:OrderDate   # rows containing today
set table Sales refresh=interval:900,daily:06:00 incremental="[Date] >= TODAY()-7"
\`\`\`

\`refresh table <pattern>\` re-fetches rows **now** (data, not model — it is
not an undo step).

New tables come from \`import tables\` / \`import sql\` (see
[source](source.md)), [calculated tables](calctable.md), or
[writeback](writeback.md) columns.`,
  },
  {
    id: "column",
    title: "Columns",
    group: "Objects",
    summary: "Physical column metadata + calculated/context expression columns.",
    markdown: `# Columns

\`\`\`
ls columns [Table]  |  ls columns Table[pattern]
show column Table[Column]
add column Table[Name] [type=Float64] [description="…"] = <expression>
set column T[pattern] key=value …
set column T[Name] [type=…] = <expression>       # calculated columns
rename column Table[Old] [New]
delete column T[pattern]                          # calculated/context only
\`\`\`

| Option | Value | Effect |
| --- | --- | --- |
| \`type=\` | \`String Int32 Int64 Float64 Boolean Date Timestamp\` | data type (aliases: int, float, bool, text, datetime) |
| \`hidden=\` | \`true/false\` | hide from field lists |
| \`format=\` | \`"#,0"\` | number format in pivots |
| \`displayname=\` | \`"…"\` | display name |
| \`description=\` | \`"…"\` | description |
| \`sortby=\` | column name | sort this column by another (physical only) |
| \`lookup=\` | \`"expr"\` | lookup-resolution expression (physical only) |

Column kinds (the \`kind\` column in \`ls\`):

- **physical** — from the source; metadata editable, formula not.
- **calculated** — user expression, evaluated at refresh.
- **context** — expression references a [measure]; re-derived per query.
  \`add column\` routes automatically by formula — reference a measure and
  the column becomes a context column ([contextcolumn](contextcolumn.md)).

\`\`\`
add column Sales[Margin] type=Float64 = Sales[Amount] - Sales[Cost]
add column Sales[Share] = DIVIDE(Sales[Amount], [Total Sales])   # context
set column Sales[*] format="#,0"
set column Customer[Name] sortby=SortKey
delete column Sales[Margin]
\`\`\``,
  },
  {
    id: "relationship",
    title: "Relationships",
    group: "Objects",
    summary: "Joins between tables: cardinality, direction, endpoint patterns.",
    markdown: `# Relationships

\`\`\`
ls relationships [pattern | From -> To]
show relationship <name | From -> To>
add relationship From[col] -> To[col] [options]
set relationship <name | From -> To> key=value …
rename relationship <old> <new>
delete relationship <name | From -> To>
\`\`\`

| Option | Value | Effect |
| --- | --- | --- |
| \`cardinality=\` | \`m:1 1:m 1:1 m:m\` (or long names) | join cardinality (default m:1) |
| \`active=\` | \`true/false\` | active vs inactive (USERELATIONSHIP) |
| \`propagation=\` | \`auto none both\` | filter propagation |
| \`name=\` | \`"…"\` | explicit name (default \`From_To\`, uniquified) |
| \`ops=\` | \`eq gt gte lt lte\` | join operator(s) for range joins (default eq) |

Multi-column joins pair the endpoints in order:

\`\`\`
add relationship Sales[Year],Sales[Month] -> Budget[Year],Budget[Month]
\`\`\`

**Endpoint patterns** select relationships by their tables/columns —
the table side, the column side, or both can be [wildcards](wildcards.md):

\`\`\`
delete relationship * -> Customer
set relationship Sales -> * active=false
ls relationships Sales[CustomerId] -> *
\`\`\`

\`rel\` / \`rels\` are kind aliases.`,
  },
  {
    id: "hierarchy",
    title: "Hierarchies",
    group: "Objects",
    summary: "Drill hierarchies: a table plus an ordered level list.",
    markdown: `# Hierarchies

\`\`\`
ls hierarchies [pattern]
show hierarchy <name>
add hierarchy <Name> table=<T> levels=Col1,Col2,Col3
set hierarchy <pattern> levels=… [table=…]
rename hierarchy <old> <new>
delete hierarchy <pattern>
\`\`\`

| Option | Value | Effect |
| --- | --- | --- |
| \`table=\` | table name | the hierarchy's home table |
| \`levels=\` | \`Col1,Col2,…\` | ordered column list, top level first |

\`levels=\` on \`set\` **replaces** the whole list. Ragged-hierarchy level
metadata (optional levels, stopper values) survives \`rename\` and other
edits but is authored in the visual editor.

\`\`\`
add hierarchy Geography table=Customer levels=Country,Region,City
set hierarchy Geography levels=Country,City
\`\`\``,
  },
  {
    id: "kpi",
    title: "KPIs",
    group: "Objects",
    summary: "Base measure + target + status bands.",
    markdown: `# KPIs

\`\`\`
ls kpis [pattern]
show kpi <name>
add kpi <Name> base=[Measure] target=[Measure]|targetvalue=<n> bands=…
set kpi <pattern> key=value …
rename kpi <old> <new>
delete kpi <pattern>
\`\`\`

| Option | Value | Effect |
| --- | --- | --- |
| \`base=\` | \`[Measure]\` | the measured value (required on add) |
| \`target=\` | \`[Measure]\` | target measure (clears targetvalue) |
| \`targetvalue=\` | number | constant target (clears target measure) |
| \`bands=\` | \`t:status,…\` | thresholds: \`0:offTrack,50:atRisk,100:onTrack\` |
| \`description=\` | \`"…"\` | description |

\`\`\`
add kpi SalesGoal base=[Total Sales] targetvalue=1000000
        bands=0:offTrack,80:atRisk,100:onTrack
set kpi SalesGoal target=[Sales Target]
\`\`\``,
  },
  {
    id: "role",
    title: "Security roles",
    group: "Objects",
    summary: "Row-level (RLS) and object-level (OLS) security.",
    markdown: `# Security roles (RLS / OLS)

\`\`\`
ls roles [pattern]
show role <name>
add role <Name> filter="T[col] <op> value" … deny=<T>|T[col] …
set role <pattern> filter=… deny=…
rename role <old> <new>
delete role <pattern>
\`\`\`

| Option | Value | Effect |
| --- | --- | --- |
| \`filter=\` | \`"Table[Col] = value"\` | row filter; repeat for several |
| \`deny=\` | \`Table\` or \`Table[Col]\` | object-level denial; repeat for several |

Filter syntax inside the quotes: \`Table[Column]\` then one of
\`= != > >= < <=\` then a value. String values may be quoted:
\`"Sales[Region] = 'West'"\`. Two special values make a filter **dynamic**:

- \`@username\` — the querying user's identity
- \`@customdata\` — the session's custom data

On \`set\`, a given \`filter=\` / \`deny=\` list **replaces** the existing one
(\`deny=\` with no value clears all denials).

\`\`\`
add role Regional filter="Sales[Region] = 'West'"
add role PerUser filter="Sales[Owner] = @username" deny=Payroll deny=HR[SSN]
set role Regional filter="Sales[Region] = 'North'"
\`\`\`

Note: roles are editable here because the command line is you clicking —
sandboxed scripts (the \`bi.model\` capability) deliberately cannot touch
security roles.`,
  },
  {
    id: "perspective",
    title: "Perspectives",
    group: "Objects",
    summary: "Named presentation subsets of the model.",
    markdown: `# Perspectives

\`\`\`
ls perspectives [pattern]
show perspective <name>
add perspective <Name> tables=A,B columns=T[c1],T[c2] measures=[M1],[M2]
set perspective <pattern> tables=… columns=… measures=… description=…
rename perspective <old> <new>
delete perspective <pattern>
\`\`\`

| Option | Value | Effect |
| --- | --- | --- |
| \`tables=\` | \`A,B\` | tables shown in full |
| \`columns=\` | \`T[c],…\` | individually shown columns |
| \`measures=\` | \`[M],…\` | shown measures |
| \`description=\` | \`"…"\` | description |

On \`set\`, each given list **replaces** the existing one; omitted lists are
kept.

\`\`\`
add perspective Sales tables=Sales,Customer measures=[Total Sales],[Margin %]
set perspective Sales columns=Product[Name],Product[Category]
\`\`\``,
  },
  {
    id: "culture",
    title: "Cultures & translations",
    group: "Objects",
    summary: "Per-locale display names/descriptions for tables, columns, measures.",
    markdown: `# Cultures & translations

Cultures hold per-locale **display** translations — field lists swap labels;
queries and formulas keep the raw names.

\`\`\`
ls cultures
ls translations <locale>
add culture <locale>                     # e.g. add culture sv-SE
rename culture <old> <new>               # re-keys the locale
delete culture <pattern>

set translation <locale> table <T> caption="…" [description="…"]
set translation <locale> column T[c] caption="…"
set translation <locale> measure [M] caption="…"
delete translation <locale> <table|column|measure> <object>
\`\`\`

| Option | Value | Effect |
| --- | --- | --- |
| \`caption=\` | \`"…"\` | translated display name (empty clears) |
| \`description=\` | \`"…"\` | translated description (empty clears) |

\`\`\`
add culture sv-SE
set translation sv-SE table Customer caption="Kund"
set translation sv-SE measure [Total Sales] caption="Total försäljning"
delete translation sv-SE table Customer
\`\`\``,
  },
  {
    id: "calcgroup",
    title: "Calculation groups",
    group: "Objects",
    summary: "Groups of calc items applied over SELECTEDMEASURE().",
    markdown: `# Calculation groups

A calculation group is a set of named items whose formulas transform
whatever measure is in play (\`SELECTEDMEASURE()\`), e.g. time intelligence.

\`\`\`
ls calcgroups
ls calcitems <group>
show calcgroup <name>
add calcgroup <Name>
add calcitem Group[Item] = <DAX>
set calcitem Group[Item] = <DAX>
rename calcgroup <old> <new>
rename calcitem Group[Old] [New]
delete calcgroup <pattern>
delete calcitem Group[pattern]
\`\`\`

Items are addressed like columns: \`Group[Item]\`.

\`\`\`
add calcgroup TimeCalc
add calcitem TimeCalc[YTD] = TOTALYTD(SELECTEDMEASURE(), 'Date'[Date])
add calcitem TimeCalc[PY]  = CALCULATE(SELECTEDMEASURE(), SAMEPERIODLASTYEAR('Date'[Date]))
set calcitem TimeCalc[YTD] = TOTALYTD(SELECTEDMEASURE(), 'Date'[Date], "6-30")
delete calcitem TimeCalc[PY]
\`\`\``,
  },
  {
    id: "calctable",
    title: "Calculated tables",
    group: "Objects",
    summary: "QUERY-expression tables: dynamic or materialized at refresh.",
    markdown: `# Calculated tables

Query-defined tables (the engine's QUERY-only globals). **Dynamic** ones
evaluate per query in the live filter context; **materialized** ones are
written to a real model table at refresh.

\`\`\`
ls calctables [pattern]
show calctable <name>
add calctable <Name> [dynamic=false] [table=<home>] = QUERY(…)
set calctable <name> = QUERY(…)
set calctable <name> dynamic=true|false [cascade=true]
materialize calctable <name>
rename calctable <old> <new> [cascade=true]
delete calctable <pattern> [cascade=true]
\`\`\`

| Option | Value | Effect |
| --- | --- | --- |
| \`dynamic=\` | \`true/false\` | default true; false = materialized at refresh |
| \`table=\` | table name | home table (default: inferred from the expression) |
| \`cascade=\` | \`true/false\` | also remove objects bound to the materialized table |

Un-materializing, renaming or deleting a **materialized** calculated table
fails closed while relationships/hierarchies/role filters/table variables
still bind to its derived table — pass \`cascade=true\` to remove them too.

\`\`\`
add calctable TopCustomers = QUERY(Customer, TOPN(10, [Total Sales]))
set calctable TopCustomers dynamic=false
materialize calctable TopCustomers
\`\`\``,
  },
  {
    id: "tablevar",
    title: "Table variables",
    group: "Objects",
    summary: "Named, filtered views over a table for reuse in expressions.",
    markdown: `# Table variables

A named subset of a base table (or of another table variable), reusable in
expressions and [contexts](context.md).

\`\`\`
ls tablevars [pattern]
show tablevar <name>
add tablevar <Name> source=<table> [filter="T[c] <op> value"] …
set tablevar <pattern> source=… filter=…
rename tablevar <old> <new>
delete tablevar <pattern>
\`\`\`

| Option | Value | Effect |
| --- | --- | --- |
| \`source=\` | table / table variable | what it filters |
| \`filter=\` | \`"T[c] = value"\` | row predicate; repeat for several (same syntax as [role](role.md) filters) |

On \`set\`, a given \`filter=\` list **replaces** the existing one.

\`\`\`
add tablevar WestSales source=Sales filter="Sales[Region] = 'West'"
\`\`\``,
  },
  {
    id: "scriptfunction",
    title: "Script functions",
    group: "Objects",
    summary: "Rhai functions callable from model expressions.",
    markdown: `# Script functions

Model-stored Rhai functions callable from expressions. \`func\` is an alias.

\`\`\`
ls funcs [pattern]
show func <name>
add func <Name> [params=a:Int,b:Float] [returns=Float] = <body>
set func <name> params=… returns=…
set func <name> = <body>
rename func <old> <new>
delete func <pattern>
\`\`\`

| Option | Value | Effect |
| --- | --- | --- |
| \`params=\` | \`name:Type,…\` | parameters; types \`Int Float Bool String\` |
| \`returns=\` | \`Int Float Bool String\` | return type (default Float) |

The body is everything after the free-standing \`=\` — indent lines to
continue it:

\`\`\`
add func Clamp params=x:Float,lo:Float,hi:Float returns=Float =
    if x < lo { lo } else if x > hi { hi } else { x }
\`\`\``,
  },
  {
    id: "context",
    title: "Contexts",
    group: "Objects",
    summary: "Named filter-context transforms (keep/clear/reset operations).",
    markdown: `# Contexts

Named filter-context transforms applied by expressions. Their operation
lists are structured (keep / keepIn / clear / reset / inherit /
useRelationship), so the CLI takes them as **JSON** — the same shape
\`show context\` prints. For rich editing, the visual Contexts section is the
comfortable surface; the CLI is handy for list/rename/delete/copy.

\`\`\`
ls contexts [pattern]
show context <name>
add context <Name> [ops='<json array>']
set context <name> ops='<json array>'
rename context <old> <new>
delete context <pattern>
\`\`\`

| Option | Value | Effect |
| --- | --- | --- |
| \`ops=\` | \`'[ … ]'\` | the full operation list as JSON (replaces on set) |

Tip: copy a starting point from an existing context —
\`show context X\`, edit the JSON, then \`set context Y ops='…'\` (single
quotes keep the JSON's double quotes intact).`,
  },
  {
    id: "contextcolumn",
    title: "Context columns",
    group: "Objects",
    summary: "Measure-driven columns, re-derived per query.",
    markdown: `# Context columns

Columns whose expression embeds a \`[Measure]\` — re-derived per query
instead of at refresh. They are **created through** \`add column\`: the
formula routing sends any measure-referencing expression here automatically
(see [column](column.md)).

\`\`\`
ls contextcolumns [pattern]
show contextcolumn <name>
delete contextcolumn <pattern>
\`\`\`

\`delete column T[Name]\` also works — it routes by the column's kind.

\`\`\`
add column Sales[Share] = DIVIDE(Sales[Amount], [Total Sales])
ls contextcolumns
delete contextcolumn Share
\`\`\``,
  },
  {
    id: "writeback",
    title: "Writeback columns",
    group: "Objects",
    summary: "Designer-declared columns that collect user input.",
    markdown: `# Writeback columns

Designer-declared columns that collect values from users (engine v21):
keyed submissions, validation rules, and a projection onto the host table.

\`\`\`
ls writebacks [pattern]
show writeback <name>
add writeback Table[Name] type=<type> keys=colA,colB [options]
set writeback <pattern> key=value …
rename writeback <old> <new>
delete writeback <pattern>
\`\`\`

| Option | Value | Effect |
| --- | --- | --- |
| \`type=\` | data type | value type (see [column](column.md) types) |
| \`keys=\` | \`colA,colB\` | key columns on the host table (submission identity) |
| \`kind=\` | \`history masterData\` | append-only history vs master data |
| \`projection=\` | \`blank latest expression\` | how values project onto the table |
| \`projexpr=\` | \`"…"\` | projection expression (projection=expression) |
| \`required=\` | \`true/false\` | value required |
| \`min=\` \`max=\` | numbers | numeric bounds |
| \`enum=\` | \`a,b,c\` | allowed values |
| \`maxlength=\` | number | max text length |
| \`pattern=\` | \`"regex"\` | text pattern |
| \`editors=\` | \`id,id\` | allowed editor identities (empty = everyone) |
| \`history=\` | \`true/false\` | expose the history table to reports |

\`\`\`
add writeback Costs[Forecast] type=Float64 keys=Month,Department
        kind=history projection=latest required=true min=0
set writeback Forecast enum=Low,Mid,High
\`\`\`

Deleting removes the model's store tables; collected entries stay in the
workbook store.`,
  },
  {
    id: "source",
    title: "Data sources & import",
    group: "Objects",
    summary: "The model's source catalog: connect, bind, import tables/SQL.",
    markdown: `# Data sources & import

The model's persisted, secret-free source catalog. Credentials are only
passed transiently via \`connect\`.

\`\`\`
ls sources
show source <name>
add source [Display] kind=<kind> host=… port=… database=… [options]
set source <name> key=value …
rename source <old> <new>
delete source <pattern>
connect source <name> connstr="<connection string>"
ls sourcetables
import tables <schema.table>[,<schema.table>…] [schema=<default>]
import sql <TableName> = SELECT …
set table <T> source=<name> schema=… sourcetable=…     # bind a table
\`\`\`

| Option | Value | Effect |
| --- | --- | --- |
| \`kind=\` | \`postgres sqlServer inMemory csv parquet\` | source type |
| \`host=\` \`port=\` | address | server location |
| \`database=\` | name / path | database, or directory for csv/parquet |
| \`schema=\` | name | default schema |
| \`auth=\` | \`integrated usernamePassword environmentVariable\` | preferred auth |
| \`ssl=\` | \`disable prefer require\` | TLS mode |
| \`trustcert=\` | \`true/false\` | trust the server certificate |
| \`connstr=\` | \`"…"\` | connection string (connect only; never persisted) |

\`\`\`
add source Warehouse kind=postgres host=db.local port=5432 database=dw
connect source Warehouse connstr="host=db.local user=me password=…"
ls sourcetables
import tables public.orders,public.customers
import sql BigCustomers = SELECT * FROM customers WHERE revenue > 100000
\`\`\``,
  },
  {
    id: "extdata",
    title: "Extension data",
    group: "Objects",
    summary: "Namespaced vendor.feature JSON entries stored on the model.",
    markdown: `# Extension data

Namespaced (\`vendor.feature\`) opaque JSON entries stored on the model
itself — they travel with the workbook and with \`.calp\` packages. Mostly
written by extensions; the CLI gives you direct inspection and repair.

\`\`\`
ls extdata
show extdata <key>
set extdata <key> = <json>
delete extdata <key>
\`\`\`

The value must be **valid JSON** (strings need quotes). Per-key size limit
256 KB.

\`\`\`
set extdata acme.reportmeta = {"owner": "sales", "reviewed": true}
show extdata acme.reportmeta
delete extdata acme.reportmeta
\`\`\``,
  },
  {
    id: "model",
    title: "Model settings",
    group: "Objects",
    summary: "Metadata, date table, default lookup resolution, validation.",
    markdown: `# Model settings

\`\`\`
show model
set model name="…" version="…" author="…" description="…"
set model datetable=<table>|none
set model lookup="<default lookup expression>"
validate
\`\`\`

| Option | Value | Effect |
| --- | --- | --- |
| \`name= version= author= description=\` | \`"…"\` | descriptive metadata (empty clears) |
| \`datetable=\` | table or \`none\` | mark the model's date table |
| \`lookup=\` | \`"expr"\` | model-default lookup resolution (empty clears) |

\`validate\` runs the engine's consistency checks and prints each issue with
its severity.

\`\`\`
set model name="Sales model" author="Daniel" version="2.1"
set model datetable=Date
validate
\`\`\``,
  },
];
