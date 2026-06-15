# Host-Integration Changelog

This document tracks **host-facing** changes to the engine — every new public API, model-file (JSON) field, `QueryRequest`/`DetailRequest` field, query result contract, error variant, and `MODEL_FORMAT_VERSION` bump that a host application (**Calcula** and **Calcula Studio**) must know about to integrate a new engine version.

It is the authoritative hand-off surface between the engine and its hosts. It is **not** an internal refactor log — only changes visible across the library boundary are recorded here. For the full vision and internal architecture see [architecture.md](architecture.md); for the public type reference see [api-reference.md](api-reference.md); for the measure/expression syntax see [expression-language.md](expression-language.md).

**Conventions used below**
- "Model JSON" = a field that serializes into the shared `.model` file (a trust boundary — see [the model-file note](#model-file-format--versioning)).
- Engine facade methods are on `bi_engine::Engine` (crate `bi-engine`, lib `bi_engine`).
- A field marked *additive* deserializes with a serde default, so older model files load unchanged.

---

## Model-file format & versioning

The shared model file carries a `format_version: u32` field (serde key `format_version`, defaults to `0` for legacy files). The engine's current maximum is:

```rust
pub const MODEL_FORMAT_VERSION: u32 = 9; // engine-core::model::schema
```

Opening a model whose `format_version` is **higher** than the engine supports fails closed with:

```
EngineError::ModelFormatTooNew { found: u32, supported: u32 }
// "Model file format version {found} is newer than this engine supports
//  (max {supported}). Update the application to open this model."
```

All new model fields are additive (serde `default` + `skip_serializing_if`), so a newer engine reads older files and a file that uses only old features still round-trips through an older engine. **A file that uses a new feature must not be opened by an engine built before that feature** — the version gate enforces this.

### Version history

| Version | Adds |
|--------:|------|
| `0` | Legacy files with no `format_version` field. |
| `1` | `format_version` introduced; measures may carry `source` text. |
| `2` | Presentation metadata — measures: `format_string`, `description`, `is_hidden`; columns: `display_name`, `description`, `is_hidden`, `default_aggregation`; tables: `display_name`, `description`, `is_hidden`. |
| `3` | Time-intelligence metadata — columns gained `date_role`, model gained `date_table`; expression AST gained `ToDate` / `PeriodShift`. |
| `4` | Sandboxed script functions — model gained `script_functions` (Rhai bodies as scalar UDFs); expression AST gained `Call`. |
| `5` | Row-level security — model gained `security_roles` with per-table row filters. |
| `6` | Incremental refresh — tables gained optional `incremental_refresh` policy. |
| `7` | Calculation groups — model gained `calculation_groups`; expression AST gained `SelectedMeasure`. |
| `8` | `DATESINPERIOD` trailing-window time intelligence — expression AST gained `DatesInPeriod`. |
| `9` | Semi-additive balances `CLOSINGBALANCE` / `OPENINGBALANCE` — expression AST gained `SemiAdditiveBalance`. |

> **Studio action:** when you write a model that uses a feature, stamp the matching minimum `format_version`. When you open a model, surface `ModelFormatTooNew` as "update the app", never as a parse error.

---

## Presentation metadata (format version 2)

Pure serde additions for host display. The engine does not interpret them (except `default_aggregation`, which is advisory); they exist so both hosts agree on field-list presentation.

**`Measure`** (`engine-core::compute::measure`):
| Model JSON key | Type | Builder | Getter |
|---|---|---|---|
| `format_string` | `Option<String>` | `.with_format_string(s)` | `format_string() -> Option<&str>` |
| `description` | `Option<String>` | `.with_description(s)` | `description() -> Option<&str>` |
| `is_hidden` | `bool` | `.hidden()` | `is_hidden() -> bool` |
| `group` | `Option<String>` | (measure group) | — |
| `source` | `Option<String>` | original measure text | — |

**`Column`** (`engine-core::model::column`):
| Model JSON key | Type | Builder | Getter |
|---|---|---|---|
| `display_name` | `Option<String>` | `.with_display_name(s)` | `display_name()` |
| `description` | `Option<String>` | `.with_description(s)` | `description()` |
| `is_hidden` | `bool` | `.hidden()` | `is_hidden()` |
| `default_aggregation` | `Option<AggregateOp>` | `.with_default_aggregation(op)` | `default_aggregation()` |
| `date_role` | `Option<DateRole>` | `.with_date_role(r)` | `date_role()` (see [time intelligence](#time-intelligence)) |

**`Table`** (`engine-core::model::table`): `display_name`, `description`, `is_hidden` with the same `.with_display_name` / `.with_description` / `.hidden()` builders and getters.

---

## Multi-select (IN-list) slicers

`QueryRequest` gained `in_filters: Vec<InFilter>` — keep only rows whose column is one of a set of values (`column IN (...)`), the multi-value form of a slicer:

```rust
QueryRequest {
    measures: vec!["Revenue".into()],
    group_by: vec![ColumnRef::new("Product", "name")],
    in_filters: vec![InFilter::new("region", ["East", "West"])],   // slice to two regions
    ..Default::default()
}
```

`InFilter { column, values: Vec<String> }` (builder `InFilter::new(column, values)`). The filter applies to whichever table owns `column` (matched by name), is **pushed to the source**, and ANDs with the scalar `filters`. A slicer on a dimension column restricts the related fact through relationship propagation — including a dimension that is **not** on the group-by axis (slice by Region, group by Product). Integer columns compare numerically (sargable); other types as escaped/quoted text. An **empty** `values` list matches nothing (an empty result), never everything. No model-file or `MODEL_FORMAT_VERSION` change (request-time only).

> IN-list = multi-select on one column, AND-combined with scalar filters. Cross-column boolean OR is the separate `or_filters` field below.

## Cross-column OR slicers

`QueryRequest` gained `or_filters: Vec<FilterCondition>` — a disjunction (`OR`) of single-column conditions, ANDed with the rest of the request. It expresses the slicer shape `in_filters` cannot: a boolean OR **across columns** (`amount > 90 OR region_id = 1`):

```rust
QueryRequest {
    measures: vec!["Revenue".into()],
    group_by: vec![ColumnRef::new("Product", "name")],
    or_filters: vec![
        FilterCondition { column: "amount".into(),    operator: FilterOperator::GreaterThan, value: "90".into() },
        FilterCondition { column: "region_id".into(), operator: FilterOperator::Equal,       value: "1".into() },
    ],
    ..Default::default()
}
// → rows where amount > 90 OR region_id = 1
```

The conditions OR together; the whole disjunction ANDs with the scalar `filters` and any `in_filters`. Every condition is **pushed to the source** (rendered as `((cond) OR (cond) …)`). Like a slicer, an OR over a **dimension** column restricts the related fact through relationship propagation, even when that dimension is off the group-by axis.

**Single-table only (fail closed):** every `or_filters` column must resolve to **one** table (the per-table fetch can push a single `OR` group). Conditions spanning different tables are rejected with `QueryError::InvalidQuery` ("must reference columns of a single table") rather than executed with a wrong scope. No model-file or `MODEL_FORMAT_VERSION` change (request-time only).

## Measure-value filters (HAVING)

`QueryRequest` gained `measure_filters: Vec<MeasureFilter>` — keep only result rows whose computed measure value satisfies a comparison:

```rust
QueryRequest {
    measures: vec!["Revenue".into()],
    group_by: vec![ColumnRef::new("Product", "name")],
    order_by: vec![OrderByClause::measure_desc("Revenue")],
    limit: Some(10),
    measure_filters: vec![MeasureFilter::new("Revenue", FilterOperator::GreaterThan, 1000.0)],
    ..Default::default()
}
// → the top 10 products whose Revenue exceeds 1000
```

`MeasureFilter { measure, operator: FilterOperator, value: f64 }` (builder `MeasureFilter::new`). The referenced `measure` must be one of the request's `measures`. Filters are applied **after** aggregation and **before** `limit`, so `order_by` a measure + `limit` + a measure filter expresses top-N-over-threshold. A `NULL` measure value never passes (the row is dropped), matching SQL `HAVING`. Not supported with `TotalsMode::Rollup` or a calculation group — those fail closed (`QueryError::InvalidQuery`). No model-file or `MODEL_FORMAT_VERSION` change (request-time only).

## Measure-value ranking (`RANKX`)

`QueryRequest` gained `rank_by: Option<RankBy>` — append an integer ranking column computed from a measure value (DAX `RANKX`-style):

```rust
QueryRequest {
    measures: vec!["Revenue".into()],
    group_by: vec![ColumnRef::new("Product", "name")],
    rank_by: Some(RankBy::new("Revenue", "Revenue Rank")),   // rank 1 = largest
    ..Default::default()
}
```

`RankBy { measure, output_column, partition_by: Vec<ColumnRef>, dense: bool, ascending: bool }` — builder `RankBy::new(measure, output_column)` then `.ascending()`, `.dense()`, `.within(cols)`. Defaults: descending (rank `1` = largest), standard competition ranking (`1,1,3` — ties share a rank, the next rank skips), ranked over all rows. `.dense()` gives gap-free ranks (`1,1,2`); `.within(group_by_cols)` restarts the rank inside each group. Computed **after** aggregation (like `measure_filters`), so it composes with `order_by` + `limit` for "top N by measure". The `measure` must be in `measures`; every `partition_by` column must be in `group_by`; `output_column` must not collide with an existing result column. A `NULL` measure value ranks **last**. Not supported with `TotalsMode::Rollup` or a calculation group (fails closed). No `MODEL_FORMAT_VERSION` change (request-time only).

> **Two ranking surfaces.** `rank_by` above is the **request-level** option (post-aggregation, by a named measure). Separately, **measure-level** `RANK` / `ROW_NUMBER` / `DENSE_RANK` functions in a measure expression — `RANK(ORDERBY(fact[amount]) [, PARTITIONBY(dim[col])])` — now **execute** (they previously failed closed). They rank the query's group-by rows by `SUM(<fact order column>)` **descending** (largest = rank 1), partitioned by `PARTITIONBY` columns. v1 limits (fail closed): the query needs a `group_by`; every `ORDERBY` column must be a measure column of the query's genuine fact table (aggregated with `SUM`) — ranking by a **dimension** attribute fails closed (order by a dimension at the request level with `QueryRequest.order_by` instead); every `PARTITIONBY` column must be a `group_by` column. They two-stage like other window measures and combine with ordinary/window measures in one query. No `MODEL_FORMAT_VERSION` change (the AST node already existed).

## Window/time-intelligence measure beside an ordinary measure

A window / running / time-intelligence measure (`YTD`, `PRIORYEAR`, a `WINDOW(...)` running total, a YoY compound, …) may now be requested **in the same query** as an ordinary aggregate (plain `Revenue`). Previously this was rejected and the host had to run two queries and stitch them.

```rust
QueryRequest {
    measures: vec!["YTD Revenue".into(), "Revenue".into()],   // trend + base, one grid
    group_by: vec![ColumnRef::new("Calendar", "year"), ColumnRef::new("Calendar", "month")],
    ..Default::default()
}
```

The engine computes the ordinary measures on the normal grouped path and FULL OUTER JOINs them onto the window result on the group-by axis, producing one `[dims…, measures-in-request-order…]` table. **Fail-closed guarantee:** if a side is not uniquely keyed by `group_by` (the running/shift axis is finer than the axis) the join would multiply rows, so it errors (`QueryError::InvalidQuery`) rather than mislead — add the finer column to `group_by`, or request the measures separately. Lookup columns combined with this specific mix are not yet supported (fail closed); `ROLLUP`/hierarchy with window measures remain fail-closed as before. No `MODEL_FORMAT_VERSION` change.

## Result-column metadata sidecar

New `Engine::query_with_meta(request) -> (Vec<RecordBatch>, Vec<ResultColumn>)` returns the same results as `query` **plus** a [`ResultColumn`] describing each output column, so a host need not re-derive it by string-matching column names:

```rust
pub struct ResultColumn {
    pub name: String,                       // exact result column name
    pub kind: ResultColumnKind,             // Dimension | Measure | GroupingId | Rank
    pub data_type: Option<DataType>,        // engine type (dictionary-encoded dims report String)
    pub source_table: Option<String>,       // dimension: owning model table
    pub source_column: Option<String>,      // dimension: model column
    pub measure: Option<String>,            // measure (base measure for a calc-group column)
    pub calculation_item: Option<String>,   // calc-group item, if any
    pub format_string: Option<String>,      // measure format string
    pub display_name: Option<String>,       // measure/column display name
    pub description: Option<String>,
    pub is_hidden: bool,
}
```

The engine owns the `format_string`/`display_name`/`is_hidden` (from the `Measure`/`Column`), the `"M [I]"` calculation-group → (base measure, item) mapping, and which column is the `__grouping_id` or rank column — so Calcula and Calcula Studio cannot drift on that mapping. Derived from the executed request + result schema, so it reflects calculation-group expansion and the appended rank column. No `MODEL_FORMAT_VERSION` change.

## Measure-authoring APIs (Studio)

Two **request-free** helpers for the measure editor — neither rebuilds the model:

- `Engine::validate_measure_text(name, text) -> QueryResult<()>` — parse a candidate measure's source text (a `ParseError` with source position on a syntax error) and validate it against the live model: circular / unknown measure references, unknown qualified columns (`Table[Column]`), and unregistered UDF calls. `name` may match an existing measure (validating an edit). A fast pre-check, not a full guarantee (relationship reachability and bare-column refs are not checked here); `add_measure` / planning remain the final authority. Backed by `DataModel::validate_candidate_measure(&Measure)`.
- Dependency graph: `Measure::referenced_measures() -> Vec<&str>` (direct deps), `DataModel::measure_dependents(name) -> Vec<&str>` (reverse edge — "who references X"), and `Expression::measure_references()` / `Expression::qualified_column_references()` walkers. For the lineage panel, safe-rename, and impact-on-delete.

No `MODEL_FORMAT_VERSION` change (read-only/request-time).

## CSV file connector

New `Engine::add_csv_source(ConnectionTarget, AuthMethod) -> ConnectorResult<usize>` registers a directory of CSV files (`<dir>/<table>.csv`, header row required) as a source — load flat-file data with zero database setup. The `target.database` field is the directory; `target.default_schema` (default `"public"`) is the cosmetic source schema. CSV is local, so only `AuthMethod::Integrated` (the process's own file-system access) is accepted — credential methods return `ConnectorError::AuthMethodNotSupported`. Schema is inferred from the file; scalar filters are applied; the engine performs aggregation/joins/ordering locally (a simple scan-with-filters source like the in-memory connector). Table names are validated against path traversal. `bi_engine::CsvConnector`.

## Pivot-shaped queries: ordering, limit, totals

`QueryRequest` (`engine-query::request`) gained the fields hosts need to render sorted, capped, and subtotaled pivots:

| Field | Type | Notes |
|---|---|---|
| `order_by` | `Vec<OrderByClause>` | Sort by a group-by column **or** by a measure value (TOP-N). |
| `limit` | `Option<usize>` | Row cap, applied after ordering. |
| `totals` | `TotalsMode` | `None` (default) or `Rollup`. |
| `hierarchy_group_by` | `Option<HierarchyGroupBy>` | Group by the levels of a model hierarchy. |

**`OrderByClause`** is built with `OrderByClause::column(table, col)` / `::column_desc(...)` / `::measure(name)` / `::measure_desc(name)`. Its `target: OrderTarget` is either `Column(ColumnRef)` or `Measure(String)`; `descending: bool`.

**Sort-by-column:** a `Column` may declare `sort_by_column: Option<String>` (model JSON key `sort_by_column`); when a host sorts by that column the engine enforces sorting by the designated key column.

### `TotalsMode::Rollup` result contract

With `totals = Rollup`, the engine computes detail rows **plus** subtotal rows (per group-by prefix) and the grand total in a single query (real SQL `ROLLUP` pushed to PostgreSQL / SQL Server; `GROUPING()`-based locally). The result carries an extra indicator column:

```rust
pub const GROUPING_ID_COLUMN: &str = "__grouping_id"; // engine-connectors::traits
```

`__grouping_id` is a 32-bit bitmask: bit `i` (LSB = the first `group_by` column) is **set** when that column is rolled up (aggregated away) in the row. Detail rows are `0`; the grand total has all participating bits set. Non-additive measures are recomputed per level (not summed from children).

> **Host action:** read `__grouping_id` to distinguish detail rows from subtotals/grand total and to render indentation/labels.

---

## Concurrency & cancellation

`Engine::query` and the detail/explain paths now take `&self` (interior mutability for the caches), so a host may run **multiple queries concurrently** on one `Engine`. The refresh paths still take `&mut self` because they replace cached data.

A `CancellationToken` threads through the executor and connectors. Cancellable entry points:
- `query_with_cancellation(QueryRequest, CancellationToken) -> QueryResult<Vec<RecordBatch>>`
- `query_rows_with_cancellation(DetailRequest, CancellationToken)` (see [drillthrough](#drillthrough--detail-rows))

Cancellation is cooperative and raced against connector fetches; a cancelled query returns `QueryError::Cancelled`.

---

## Time intelligence

YTD/QTD/MTD running totals and prior-period shifts, computed against a **marked date table**.

### Marking the date table (model)

- `DataModelBuilder::mark_date_table(table_name)` → serializes as model JSON `date_table: Option<String>`.
- `DataModel::date_table() -> Option<&str>`.
- Each calendar column declares its role via `Column::with_date_role(DateRole)` → model JSON `date_role`.

```rust
pub enum DateRole { Year, Quarter, Month, Week, Day, DateKey }
```

`DateKey` is the full `Date`/`Timestamp` column; the rest are the extracted parts. The date table **must be `StorageMode::InMemory`** for filter-context time intelligence (see the fail-closed note below).

### Measure syntax

The parser accepts these built-ins (case-insensitive):

| Function | Meaning |
|---|---|
| `YTD(expr)` | Year-to-date running aggregate. |
| `QTD(expr)` | Quarter-to-date. |
| `MTD(expr)` | Month-to-date. |
| `PRIORYEAR(expr)` | Same window, shifted back one calendar year. |
| `SAMEPERIODLASTYEAR(expr)` | Synonym of `PRIORYEAR` (whole-window shift). |
| `PRIORPERIOD(expr, offset, "YEAR"\|"QUARTER"\|"MONTH")` | Generic period shift; negative `offset` = earlier. |
| `PARALLELPERIOD(expr, offset, "YEAR"\|"QUARTER"\|"MONTH")` | Synonym of `PRIORPERIOD`: the whole window shifted by `offset` periods of the given granularity (for a single-period context this equals the parallel prior/next period). |
| `DATESINPERIOD(expr, intervals, "YEAR"\|"QUARTER"\|"MONTH")` | Trailing window of \|intervals\| periods ending at the as-of date (e.g. `-12, MONTH` = trailing 12 months). `intervals` must be **negative**. **Filter-context only** — fails closed with a date column on the axis. |
| `CLOSINGBALANCE(expr)` | **(format version 9)** Semi-additive balance: `expr` evaluated at the **last** date of the current context (e.g. inventory/account balance at period end — summing across days would be wrong). **Filter-context only** — fails closed with a date column on the axis. |
| `OPENINGBALANCE(expr)` | **(format version 9)** As `CLOSINGBALANCE` but at the **first** date of the current context (period start). |

These lower to the expression AST variants `Expression::ToDate { expr, granularity }`, `Expression::PeriodShift { expr, offset, granularity }` (with `DateGranularity::{Year,Quarter,Month}`), and `Expression::SemiAdditiveBalance { expr, opening }`.

> **Behavior change:** in **filter-context** mode, `YTD`/`QTD`/`MTD` now accept **any** range-computable aggregate inner — including `AVERAGE` / `DISTINCTCOUNT` / `MEDIAN` — because the window lowers to a single evaluation over the date range. (The **axis** running-window path still rejects non-additive aggregates, which genuinely cannot accumulate from per-period values.) Previously `YTD(AVERAGE(x))` failed closed even in filter context; it now computes the correct range average.

### Two evaluation modes (this is the v2 change)

The engine now routes each time-intelligence measure automatically:

1. **Axis mode (v1):** the date is on the `group_by` axis → running window over the axis (as before).
2. **Filter-context mode (new):** the date is **only in the filters**, not on the axis → the engine probes the as-of date from the active date filters and rewrites the window into a date-range filter (`Keep(Clear(date) + [DateKey ≥ start, DateKey < end])`, half-open). This makes `YTD`/`PRIORYEAR`/… work in a card or a non-date pivot, with no date column on the axis.

**Fail-closed guarantees (no silently-wrong numbers):**
- A `KEEP`/`USING`/`CLEAR` wrapped around a filter-context time-intelligence measure that carries **non-date** filters is rejected (would otherwise drop the non-date filter). 
- Role (RLS) predicates and non-`DateRole` filters on the date table are **preserved**; only the `DateRole` columns are cleared for the window.
- If the date table is **not in-memory** (served from a connector), the query fails closed rather than returning a blank prior-period value.
- Non-contiguous / gapped calendars are documented as unsupported for value-based matching.

All of the above surface as:

```rust
EngineError::TimeIntelligence { function: String, reason: String }
// "Time intelligence: {function} cannot be evaluated: {reason}"
```

### Compound time intelligence (YoY)

Time-intelligence terms may be combined with arithmetic into a single measure, e.g. year-over-year delta and growth %:

```
YTD(SUM(Sales[amount])) - PRIORYEAR(SUM(Sales[amount]))            // YoY delta
DIVIDE(YTD(SUM(...)) - PRIORYEAR(SUM(...)), PRIORYEAR(SUM(...)))   // YoY %
```

Supported combinators: `+ - * /`, `DIVIDE`, `IF`, `COALESCE`, `IFERROR` over time-intelligence terms and numeric constants. The engine evaluates each time-intelligence term, joins them on the group-by axis, and applies the arithmetic. A compound that mixes a time-intelligence term with a **bare aggregate** (`YTD(...) - SUM(...)`), or that is wrapped in an **outer** `KEEP`/context op, fails closed (`QueryError::InvalidQuery`) — apply context *inside* each term, or compute the bare aggregate as a separate measure.

**Period shift at any granularity (filter-context):** a `PRIORPERIOD`/`PARALLELPERIOD` shift in filter-context mode now lowers at **any** granularity (year, quarter, **and month**), not just year — the as-of window is shifted by `offset × months-per-period` calendar months. Previously a non-year filter-context shift was rejected.

> **Known limitations (deferred):** in **axis mode**, an outer `KEEP` around a single window measure now applies (a non-date filter restricts the running total); a `KEEP` around a *compound* one fails closed. Fiscal calendars (non-Gregorian date tables) fail closed on the filter-context path. Opening/closing balances, value-based (gap-tolerant) period shifts, and totals×time-intel / hierarchy×time-intel composition remain deferred (they error rather than mislead).

---

## Row-level security (format version 5)

Client-side RLS: named roles whose per-table row filters are injected as a **sealed pre-aggregation layer** that no measure-context operation (`RESET`/`CLEAR`/`ALL`-style) can strip.

### Model

```rust
SecurityRole::new(name)
    .with_filter(table, column, ComparisonOp, value)   // ANDs within a table
```

- `DataModelBuilder::add_security_role(SecurityRole)`; model JSON `security_roles: Vec<SecurityRole>`.
- A `SecurityRole` holds `table_filters: Vec<FilterPredicate>` (`{ table, column, operator: ComparisonOp, value }`).
- `DataModel::security_roles()` / `security_role(name) -> EngineResult<&SecurityRole>`.

### Engine facade

| Method | Signature | Notes |
|---|---|---|
| `set_active_role` | `(&mut self, role: Option<String>)` | Host calls **after** authenticating the user. `None` = unrestricted. Changing the role invalidates the query cache. |
| `set_active_roles` | `(&mut self, roles: Vec<String>)` | Activate a **set** of roles whose permitted rows **union** (a row is visible if any active role permits it). Empty = unrestricted; one element ≡ `set_active_role(Some(_))`. Changing the set invalidates the query cache. |
| `active_role` | `(&self) -> Option<&str>` | The first active role (or `None`). |
| `active_roles` | `(&self) -> &[String]` | All active roles. |

A non-existent role name is **not** rejected by `set_active_role(s)` — it is caught at query time so a typo can never silently degrade into an unrestricted query.

#### Multi-role union (a row is visible if **any** active role permits it)

When two or more roles are active, `query`/`query_with_cancellation` combine them with Power BI's union semantics. v1 supports the union when **every active role restricts the same table with exactly one predicate** — the engine rewrites the set into a sealed single-table `OR` slicer that rides the same enforceable single-hop propagation as a single role. Cross-role isolation is preserved: the canonicalized (order-independent) role set is part of the query-cache key.

Shapes that are **not** a flat single-table disjunction **fail closed** (`QueryError::InvalidQuery`), never under-restrict:
- roles filtering **different** tables ("requires all active roles to filter the same table");
- a role with **more than one** predicate ("supports one predicate per role");
- a table that is not enforceable for this query (refused with `RowLevelSecurityNotEnforceable`, same gate as single-role);
- combining multi-role with a calculation group or a user `or_filters` (rejected).

Multi-role union is wired only through the aggregate `query` path. The other query paths — `query_auto_refresh`, `query_explained`, and drillthrough `query_rows` — **fail closed under multiple active roles** ("this path requires a single active role") rather than run with no restriction. Activate a single role for those paths.

### Error variants

```rust
EngineError::SecurityRoleNotFound(String)               // "Security role '{0}' not found"
EngineError::RowLevelSecurityNotEnforceable { table, reason }
// "row-level security for the active role cannot be enforced for table
//  '{table}' in this query: {reason}"
```

**Enforcement model (v1):** a single active role, or a union of roles under the constraint above; static AND-combined predicates within a role; enforcement only through **single-hop, single-column, active, equi** relationships. If a role-filtered table is reachable from a queried fact but **not** via such a relationship, the query is refused (`RowLevelSecurityNotEnforceable`) rather than left unrestricted — the engine fails closed. The (canonicalized) active-role identity is folded into the query-cache key so results never leak across roles or role sets.

> **Honesty note for hosts:** RLS in an embedded, client-side library is **advisory** against a cooperative host — it prevents a role from *seeing* rows through the engine, not from bypassing the engine and reading the source directly. Document it as such to end users.

---

## Drillthrough / detail-rows

Return the **raw fact rows** behind a pivot cell — no aggregation. RLS-enforced, mandatorily capped, and **not cached** (interactive/per-cell).

### Engine facade

```rust
query_rows(&self, DetailRequest) -> QueryResult<Vec<RecordBatch>>
query_rows_with_cancellation(&self, DetailRequest, CancellationToken) -> QueryResult<Vec<RecordBatch>>
```

### `DetailRequest` (`engine-query::request`)

```rust
DetailRequest::new(table, limit)            // limit is mandatory (0 = empty)
    .with_columns(["col", ...])             // detail-table columns; empty = all
    .with_dimension_columns(vec![ColumnRef::new(table, col), ...])
    .with_filters(vec![FilterCondition { column, operator, value }])
    .with_order_by(vec![OrderByClause::column(...)])   // detail-table columns only
```

| Field | Type | Meaning |
|---|---|---|
| `table` | `String` | The detail (fact) table. |
| `columns` | `Vec<String>` | Detail-table columns; **empty = all**. |
| `dimension_columns` | `Vec<ColumnRef>` | Related dimension attributes to attach per row (see below). |
| `filters` | `Vec<FilterCondition>` | Cell-coordinate and slicer filters. |
| `order_by` | `Vec<OrderByClause>` | Detail-table columns only. |
| `limit` | `usize` | Mandatory row cap, applied after ordering. |

A cell filter on a **dimension** propagates to the fact via a single-hop equi semi-join (`IN`). A dimension filter that matches **zero** rows yields zero detail rows (it never falls back to "all rows").

### Dimension-attribute output columns

`dimension_columns` joins related dimension attributes onto each detail row (e.g. show `Category.name` and `Geography.region` next to each raw `Sales` row). Contract:
- Relationship must be **single-hop, single-condition, equi**; orientation is auto-detected (the detail table may be either end).
- A `LEFT JOIN` — a detail row whose FK matches no dimension row is **kept** with a `NULL` attribute, never dropped.
- The join **deduplicates** the dimension to one row per key (so a non-unique-keyed dimension cannot fan out / multiply detail rows or exceed `limit`).
- Result column naming: the bare column name, or `"{Table}.{column}"` when that collides with an existing result column; a residual collision fails closed.
- Per-dimension fetch is RLS-restricted (the active role's predicates apply to the dimension too).

> **Security:** because this exposes raw rows, the active role is sealed onto the detail-table fetch, and a role filtering a sibling/snowflake dimension reachable only via a non-equi/M2M/multi-hop relationship fails closed (`RowLevelSecurityNotEnforceable`).

`ColumnRef` (`engine-query::request`): `{ table: String, column: String }`, built with `ColumnRef::new(table, column)`.

---

## Incremental refresh (format version 6)

Refresh only the **volatile** rows of an in-memory table, retaining the stable cached rows — defined by a user-supplied filter, not a fixed time window.

### Model

```rust
Table::new(...).with_incremental_refresh(IncrementalRefresh::new(refresh_filter))
```

- Model JSON: `Table.incremental_refresh: Option<IncrementalRefresh>` (only meaningful on `StorageMode::InMemory`; build-time validation rejects it on DirectQuery).
- `IncrementalRefresh { refresh_filter: String }` — a DAX-like boolean identifying the volatile rows (e.g. `order_date >= DATEADD(TODAY(), -7, "DAY")`, or a non-temporal predicate like `status <> "closed"`). Accessor `refresh_filter()`.

On a stale refresh, the engine folds `TODAY()`/`NOW()` once, fetches only rows matching the filter from the source (pushed down), retains the cached rows that do **not** match, and concatenates. The filter is the **source of truth for volatility**: a row that changes at source but does not match the filter is not re-fetched (by design). v1 supports AND-of-comparisons (column op const-foldable-rhs); OR/raw-SQL is deferred.

### Refresh reporting & policy (host-facing surface)

`Engine::refresh_stale(&mut self) -> EngineResult<RefreshReport>` and `query_auto_refresh` now return/retain a structured report:

```rust
pub struct RefreshReport { pub refreshed: Vec<String>, pub failures: Vec<RefreshFailure> }
pub struct RefreshFailure { pub table: String, pub detail: String }
```

A failure on one table never aborts the others; inspect via `Engine::last_refresh_report()` (also populated by `query_auto_refresh`, which proceeds despite partial failures). A table's poll fingerprint is committed only **after** its refresh succeeds, so a failed refresh stays detectably stale.

Model-supplied `RefreshStrategy::SourceQuery { sql, source_table }` SQL is gated by a host policy:

```rust
Engine::set_source_query_policy(SourceQueryPolicy)   // default ValidatedSelectOnly
// SourceQueryPolicy::ValidatedSelectOnly — single SELECT only (CTEs ok); DML/DDL/multi-statement rejected
// SourceQueryPolicy::Disabled            — never executes model-supplied SQL; recorded as a poll failure
```

Rejected SQL surfaces as `EngineError::SourceQueryRejected { table, reason }`.

---

## Calculation groups (format version 7)

A calculation group applies a set of named transforms (calculation items) across the measures in a request — e.g. a "Time Intelligence" group with items `Current`, `YTD`, `PY` applied to whatever measures the user dropped in.

### Model

```rust
CalculationItem::new(name, expression)            // expression is a transform of SELECTEDMEASURE()
CalculationItem::from_text(name, "YTD(SELECTEDMEASURE())")   // parses + retains source text
CalculationGroup::new(name, items).with_item(item)
DataModelBuilder::add_calculation_group(group)
```

- Model JSON: `DataModel.calculation_groups: Vec<CalculationGroup>`; `CalculationGroup { name, items }`; `CalculationItem { name, expression, source? }`.
- `DataModel::calculation_groups()` / `calculation_group(name) -> EngineResult<&CalculationGroup>`.
- New AST placeholder `Expression::SelectedMeasure` — the parser produces it from `SELECTEDMEASURE()`. It is legal **only** inside a calculation item (`Expression::validate_calc_item` permits it; `validate` rejects it for ordinary measures/calc-columns). It must never reach SQL unsubstituted — the renderers reject it like an unexpanded `MeasureRef`.

### Applying a group to a query

```rust
QueryRequest { ..., calculation_group: Option<CalculationGroupApplication> }
CalculationGroupApplication::new(group, items)   // empty items = all items, in declaration order
// { group: String, items: Vec<String> }
```

### Result contract

For requested measures `[M1, M2]` and applied items `[I1, I2]`, the result has `measures.len() * items.len()` value columns, ordered **measures-outer / items-inner**:

```
"M1 [I1]", "M1 [I2]", "M2 [I1]", "M2 [I2]"
```

Naming pattern: `"{measure} [{item}]"` (see `calculation_group::synthetic_measure_name`). The application (group + item list, **in order**) is folded into the query-cache key, since item order determines column order.

Lookup error: `EngineError::CalculationGroupNotFound(String)`.

> **Host action:** a `Current = SELECTEDMEASURE()` item yields the base measure unchanged; render the group as a row/column axis on the host side (the engine produces the value columns, not the layout).

---

## Scripting — script functions (format version 4)

Host-extensible scalar functions usable in measure expressions, in two tiers.

### Native UDF registry (host code)

Unknown function names parse to `Expression::Call { name, args }`, resolved post-parse against host-registered scalar UDFs. A `Call` is treated as unpushable (forces local aggregation). This is the zero-sandbox-risk tier for host-implemented functions.

### Rhai script functions in model files

A model may carry sandboxed Rhai function bodies:

```rust
ScriptFunction::builder(name) ... ;          // { name, params: [ScriptParam{name, ty}], return_type, body }
DataModelBuilder::add_script_function(ScriptFunction)
```

- Model JSON: `DataModel.script_functions`; `ScriptType ∈ { Int, Float, Bool, String }`.
- Each script function becomes a per-row DataFusion `ScalarUDF`.
- Sandbox limits are **host policy**, never model content: `ScriptSandboxConfig { max_operations, max_call_levels, max_expr_depth, max_string_size, max_array_size, max_map_size }`.

**Trust boundary:** opening a model is inert — load = deserialize only, never execute. The sandbox is deny-by-default I/O (no file/module/`sleep`/`print`) with operation/size budgets. Failures surface as:

```rust
EngineError::ScriptError { function: String, position: Option<usize>, message: String }
// "Script '{function}' error[ at position {p}]: {message}"
```

---

## Correctness sweep — new fail-closed behaviors

A sweep of silently-wrong-number paths (the engine's #1 prohibited failure) changed several queries that previously returned a wrong/mis-shaped result to either compute correctly or **fail closed** with a typed error. Host-visible effects:

- **`PERCENTILE` is documented as approximate** and is now always computed locally (DataFusion `approx_percentile_cont`), so its value no longer changes when a model gains a second source or an in-memory table. Treat percentile results as approximate. **`MODE`, population `STDEV`/`VAR`** on the direct engine-core aggregation API now return correct values (`STDEVP`/`VARP` use the genuine population formula) or fail closed (`MODE` has no engine support) instead of silently substituting sample-stats / `MIN`.
- **Multiple window/running/time-intelligence measures in one request are now joined** on the shared group-by axis into one `[dims…, m1, m2, …]` result (e.g. `YTD Sales` + `PRIORYEAR Sales` side by side), **as is a window measure mixed with an ordinary (non-window) measure** (see [the dedicated section](#windowtime-intelligence-measure-beside-an-ordinary-measure)). They must be uniquely keyed by the group-by columns (add the finer date column to `group_by` if the running axis is finer); otherwise the request fails closed. Multiple `QUERY`-in-VAR measures in one request are still rejected (`QueryError::InvalidQuery`) — request those separately.
- **Axis-mode time intelligence now honors a wrapping `KEEP` filter** (e.g. `KEEP(YTD(SUM(amount)), region='east')` is east-only). A window measure wrapped in context the path can't represent (boolean conditions, IN filters, CLEAR/RESET, USERELATIONSHIP, table-variable traversal) is rejected rather than silently dropped.
- **Period shifts (`PRIORYEAR`/`PRIORPERIOD`) over a gapped axis fail closed** (`EngineError::TimeIntelligence`): a missing period would otherwise read the wrong period. Supply a contiguous date axis.
- **Filter-context time intelligence over a non-Gregorian (fiscal) date table fails closed** (`EngineError::TimeIntelligence`): the filter-context window math is calendar-based and would disagree with the axis path. Put a date column on the group-by axis (which honors the role columns), or use a Gregorian calendar table.
- **Multi-fact-table queries no longer cartesian-explode** when a conformed dimension is reachable from the later facts but not the first — the combine now joins on the shared dimension. (A pure correctness fix; no API change.)

The `WINDOW(inner, func, …)` primitive's two-stage semantics are now documented: `func` is applied over the per-period values of `inner` (so `WINDOW(SUM(x), AVG, ROWS…)` is a moving average of period totals; for a true row-level windowed average, window `SUM`/`COUNT` and divide).

## Security hardening visible to hosts

The shared model file is a **trust boundary**. Beyond the per-feature notes above, the engine now:
- Escapes/validates all model-supplied identifiers and filter values through one shared quoting layer (no SQL injection from a hostile model; no `O'Brien` correctness bug).
- Builds connections from typed parts (`PgConnectOptions` / tiberius `Config` setters), never string interpolation; defaults to verifying TLS.
- Sanitizes table names used as disk-cache filenames (no path traversal).
- Guards parser recursion depth and re-validates the deserialized expression AST against the parser allow-list.
- Preserves numeric fidelity on fetch (fraction-preserving unconstrained `NUMERIC`, checked+rounded decimal scaling, wire-typed decode of `float4`/`timestamptz`/`smallint`/`tinyint`/`real`/`money`/`datetimeoffset`, `COUNT_BIG` on SQL Server).

These do not change the host API surface but **do** change behavior: a model that previously produced wrong numbers or relied on lax types now produces correct numbers or a clear error.

## Performance (transparent — no API change)

- **Sargable integer filters.** A scalar filter or `OR`-slicer condition on a column the model declares as an **integer** type now renders to the source as an uncast, unquoted comparison (`col = 5`), so a source index on that column is usable — previously every filter was text-cast (`col::text = $1`), forcing a sequential scan. This closes the asymmetry with the IN-list path, which was already sargable by the same model-type rule. (Date/decimal sargability remains future work; those still text-cast.) **Contract:** a model's declared column type must match the source's physical type. The optimization keys off the *declared* type, so a column declared integer but physically `VARCHAR` at the source now renders `col = 5` — on PostgreSQL this is a loud error (operator type mismatch); on SQL Server it compares numerically rather than as text, which can differ for non-canonical strings (`'05'`). This only affects models that misdeclare their own column types; a faithful model is unaffected. (Same caveat already applied to the IN-list slicer path.)

---

## Quick reference: new error variants this cycle

| Variant | Message shape |
|---|---|
| `ModelFormatTooNew { found, supported }` | model file newer than engine |
| `TimeIntelligence { function, reason }` | time-intel can't be evaluated |
| `SecurityRoleNotFound(name)` | role name not in model |
| `RowLevelSecurityNotEnforceable { table, reason }` | RLS can't be enforced → query refused |
| `CalculationGroupNotFound(name)` | calc group not in model |
| `SourceQueryRejected { table, reason }` | model poll SQL failed validation/policy |
| `ScriptError { function, position, message }` | script compile/runtime failure |

---

*Maintained going forward: every change that crosses the library boundary gets an entry here, with the `MODEL_FORMAT_VERSION` bump (if any) and the exact public names.*
