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
pub const MODEL_FORMAT_VERSION: u32 = 14; // engine-core::model::schema
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
| `10` | KPIs — model gained `kpis` (author-defined status markup over a base measure: target + status bands). |
| `11` | Dynamic row-level security — a role's `FilterPredicate` gained a `dynamic` field (`USERNAME()` / `CUSTOMDATA()` identity tokens). |
| `12` | Context-driven calculated columns — model gained `context_columns` (a groupable column whose row-level expression resolves a scalar measure from the query's filter context). |
| `13` | Query-scoped variables (`GVAR`) — the `Block` (VAR/RETURN) expression gained `query_scoped_bindings`: variables evaluated once per query filter context, ignoring the group-by axis. |
| `14` | Persisted multi-source bindings — model gained `sources` (secret-free `PersistedSource` catalog); tables gained optional `source_binding` (`TableSourceBinding`: source id + schema + table). Also finalizes the presentation-only model metadata fields (`model_name`/`model_version`/`model_author`/`model_description`). |

> **Studio action:** when you write a model that uses a feature, stamp the matching minimum `format_version`. When you open a model, surface `ModelFormatTooNew` as "update the app", never as a parse error.

---

## Persisted multi-source bindings (format version 14)

A model can now record **which data source each table comes from**, so a multi-source ("composite") model — including one that answers cross-source queries in Direct Query mode — can be saved and reopened without the host re-registering and re-binding every table by hand. The engine was already able to hold many connectors at once (`SourceRegistry` is a `Vec` of connectors, and a query spanning sources already falls back to a local cross-source join); this release makes that wiring **persistent, ergonomic, and secret-free**.

- **Model JSON (`format_version` 14, additive).**
  - The model gained `sources`: a catalog of `PersistedSource { id, kind, connection, preferred_auth, display_name? }`. `connection` is `PersistedConnection { host, port?, database, default_schema?, trust_server_certificate }` — the secret-free half of a `ConnectionTarget`. `preferred_auth` is an auth **kind** hint (`integrated` / `username_password` / `environment_variable`), never a credential. `kind` is one of `postgres` / `sql_server` / `in_memory` / `csv` / `parquet`.
  - Each `Table` gained an optional `source_binding` (`TableSourceBinding { source_id, schema, table }`) naming the catalog source and the physical `(schema, table)` it maps to.
  - Both fields are additive (serde `default` + `skip_serializing_if`); a pre-v14 file loads with an empty catalog and no bindings and behaves exactly as before (host wires sources at runtime). **No secrets are ever written** — only the connection target and the preferred-auth kind. Writing a model that uses these fields must stamp `format_version >= 14`.
- **Public API — new types.** `PersistedSource`, `PersistedConnection`, `PersistedAuthKind`, `SourceKind`, `TableSourceBinding` (engine-core, re-exported from `bi_engine`); `SourceCredential` and `WireReport` (facade). `Table::with_source_binding` / `set_source_binding` / `source_binding`; `DataModel::sources` / `source` / `push_source`; `DataModelBuilder::add_source`; `AnyConnector::kind`; `SourceRegistry::add_connector_with_id` / `connector_index_by_source_id`.
- **Public API — new facade methods.** Composite-model authoring: `Engine::add_postgres_source` / `add_sqlserver_source` (async) and `add_csv_source_with_id` / `add_parquet_source_with_id` / `add_in_memory_source_with_id` (sync) — each registers a connector under a stable id and records it in the catalog, returning the connector index; `Engine::bind_source_table` (bind one existing model table) and `Engine::bind_source_tables` (introspect a source, add missing tables, bind all). Reopen: `Engine::wire_sources(resolve)` and `Engine::wire_sources_with_auth(&map)` rebuild the live registry from the persisted catalog. The existing `add_postgres` / `add_sqlserver` / `add_*_source` / `bind_table` are unchanged (they simply do not persist).
- **Behavior / semantics.** `load_model` and `set_model` open **no** connections and require no secrets — reconnection is an explicit `wire_sources` step where the host re-supplies each source's `AuthMethod` (which is never persisted). An in-memory source cannot be rebuilt from the descriptor (its data lives in the host), so it must be wired with `SourceCredential::Connector`; `wire_sources_with_auth` skips in-memory sources and reports them. A source the host chooses to `Skip` — or a table whose `source_binding` names an unwired/unknown source — leaves those tables **unbound** (reported in `WireReport.unbound_tables`); they fail closed at query time, unchanged, with `QueryError::SourceNotRegistered`.
- **Errors the host can observe.** `EngineError::DuplicateName` (a source id already in the catalog). `EngineError::InvalidData` (a `source_binding` referencing an undeclared source — also rejected at `DataModel::build`/`validate`; an in-memory source given `SourceCredential::Auth`; binding to an unregistered source; or a connector connect/build failure, wrapping the underlying `ConnectorError` message such as `AuthMethodNotSupported`). Unchanged: `QueryError::SourceNotRegistered` for an unbound/unwired table at query time.
- **Studio / Calcula action.** To persist a composite model, register sources with the `*_source*`/`*_with_id` methods (or add `PersistedSource`s and bind tables), then `save_model` (stamps v14). On open, call `wire_sources` (or `wire_sources_with_auth`) to reconnect, prompting the user for credentials per source, and treat any `unbound_tables` as "reconnect required" rather than a load failure.

### Direct Query multi-source limitations (unchanged, documented)

A model spanning multiple **live** sources answers cross-source joins by fetching each table from its own source and joining locally (no cross-source pushed aggregation). A few existing Direct-Query fail-closed rules specifically affect such models and are **not** changed here: filter-context time-intelligence (`YTD`/`PRIORYEAR`/…) requires the marked date table to be `InMemory` (a calendar in a live source is refused with `EngineError::TimeIntelligence`); row-level security requires an enforceable single-hop equi relationship to the role's table; and cross-source relationship filter-propagation is single-condition equi-only. Host models that need time-intelligence should mark the date table `InMemory`.

---

## Query-scoped variables — `GVAR` (format version 13)

**Measure authoring — new keyword.** A measure's `VAR … RETURN` block may now also declare `GVAR` (query-scoped) variables. A `GVAR` is evaluated **once per query** — against the query's outer filter/slicer context and active RLS role, but **without** the group-by/row axis — and substituted as a constant everywhere it is referenced. Contrast: a plain `VAR` is inlined and re-evaluated per group. Canonical use is "% of grand total" or "compare each row to a whole-context value":

```
GVAR grand = SUM(Sales[amount])
RETURN DIVIDE(SUM(Sales[amount]), grand)
```

- **Model JSON (`format_version` 13).** The `Block` expression node gained an additive field `query_scoped_bindings` (serde `default` + `skip_serializing_if`), a list of `(name, expression)` pairs parallel to `bindings`. Measures that use no `GVAR` are unchanged on the wire. A pre-v13 engine would silently drop the field and miscompute, so writing a measure that uses `GVAR` must stamp `format_version >= 13`.
- **Public API.** `Expression::Block` gained the `query_scoped_bindings` field; new builder `expr::block_with_globals(query_scoped, bindings, result)`; new inspector `Expression::has_query_scoped_bindings()`. `expression_to_formula` emits `GVAR name = …` lines before `VAR` lines.
- **Semantics / result contract.** No change to the result shape — a `GVAR` measure returns one value column like any measure. The value is a pure function of the query's filter context (already part of the query cache key), so caching is unaffected.
- **Errors the host can observe.** Authoring/validation errors surface as `EngineError::InvalidExpression` (a `GVAR` binding that is not scalar, references a `VAR` or a later/self `GVAR`, duplicate name, collides with a model global-variable name, or is nested below the measure root). Query-time fail-closed combinations surface as `QueryError::InvalidQuery` (currently: `GVAR` together with a calculation group).
- **Not supported (v1, fails closed):** `GVAR` in a calculated column or model global variable; evaluation through the lower-level in-memory `MeasureEngine`; combination with a calculation group; `GVAR` under **multiple active RLS roles** (`set_active_roles` with >1 role — query under a single role instead); and evaluation via `query_auto_tier` / `query_explained` / `query_auto_refresh` (resolution is wired into `Engine::query` / `query_with_meta` — the other entry points fail closed with `QueryError::InvalidQuery` rather than mis-evaluate). Adding `GVAR` to a measure is backward-compatible for authoring: `GVAR` is only a keyword at a declaration start, so existing measures that use `gvar` as a variable name still parse.

---

## Connector pluggability & fail-soft pushdown (no format bump)

Internal restructuring to make adding a database vendor close to plug-in. Mostly invisible to hosts; the host-facing pieces:

- **Behavior fix (correctness).** A compound-measure or star-schema query whose tables bind to a **non-PostgreSQL** source (SQL Server, CSV, Parquet) previously **hard-errored** with `UnsupportedOperation`; it now computes locally and returns the correct result. The query planner gates expression pushdown on a connector capability instead of assuming PostgreSQL. No host code change — queries that used to fail now succeed.
- **New public type `bi_engine::ConnectorCapabilities`** and a `Connector::capabilities(&self) -> ConnectorCapabilities` trait method (defaulted to fetch-only). Hosts that implement their own `Connector` are unaffected (the default applies); a host connector opts into expression pushdown by overriding it.
- **New facade method `Engine::add_source<C: Into<AnyConnector>>(&mut self, connector: C) -> usize`** — register a pre-built connector generically. The typed `add_postgres` / `add_sqlserver` / `add_csv_source` / `add_parquet_source` / `add_in_memory_source` are unchanged and now funnel through it.
- **No model-file or `QueryRequest` change; no `MODEL_FORMAT_VERSION` bump.** Generated source SQL is byte-for-byte unchanged (the pinned-SQL tests across all crates are the oracle), with one corrected exception below; type fidelity and auth handling are unchanged.
- **Behavior fix (correctness).** A context-driven calculated column pushed into a PostgreSQL `GROUP BY` that compares against a resolved **date** scalar (e.g. `IF(fact[orderdate] <= <as-of date>, …)`) previously rendered the date as `CAST(<days> AS DATE)` and **hard-errored** on PostgreSQL (`cannot cast type integer to date`). The Date32 literal now renders per dialect — `DATE 'YYYY-MM-DD'` for PostgreSQL, unchanged `CAST(… AS DATE)` for local DataFusion. No host code change; such queries now return the correct result.

See [adding-a-connector.md](adding-a-connector.md) for the connector-author surface. PostgreSQL remains the only source with expression pushdown; everything else is fetch-only and computes compound/JOIN queries locally.

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

> **Two ranking surfaces.** `rank_by` above is the **request-level** option (post-aggregation, by a named measure). Separately, **measure-level** `RANK` / `ROW_NUMBER` / `DENSE_RANK` functions in a measure expression — `RANK(ORDERBY(fact[amount]) [, PARTITIONBY(dim[col])])` — now **execute** (they previously failed closed). They rank the query's group-by rows by `SUM(<fact order column>)` **descending** (largest = rank 1), partitioned by `PARTITIONBY` columns. v1 limits (fail closed): the query needs a `group_by`; every `ORDERBY` column must be a measure column of the query's genuine fact table (aggregated with `SUM`) — ranking by a **dimension** attribute fails closed (order by a dimension at the request level with `QueryRequest.order_by` instead); every `PARTITIONBY` column must be a `group_by` column. A group whose aggregated order key is `NULL` (e.g. all-blank/voided measure values) ranks **last**, never first. They two-stage like other window measures and combine with ordinary/window measures in one query. No `MODEL_FORMAT_VERSION` change (the AST node already existed).

## Top-N groups (`TopN`, tie-inclusive)

`QueryRequest` gained `top_n: Option<TopN>`. `TopN { measure, limit, partition_by: Vec<ColumnRef>, ascending: bool, output_column: Option<String> }` — builder `TopN::new(measure, limit)` then `.ascending()`, `.within(cols)`, `.with_tie_count(name)`. Keeps the top `limit` **groups** by `measure` with DAX `TOPN` **tie-inclusive** semantics: if several groups tie at the `limit`-th value, **all** are kept, so the result may contain more than `limit` rows — distinct from `order_by` + `limit`, which truncate exactly. Computed after aggregation and after `measure_filters`, before `order_by` + `limit` (so a host can order the tie-inclusive set and cap it exactly). `.with_tie_count("col")` appends an integer column giving, per kept row, how many groups tie at the boundary value (so the host sees how far the result exceeded `limit`). A `NULL` measure sorts last and is kept only when the boundary value is itself `NULL`. The `measure` must be in `measures`; every `partition_by` column must be in `group_by`; the output column must not collide. Not supported with `TotalsMode::Rollup` or a calculation group (fails closed). No `MODEL_FORMAT_VERSION` change (request-time only).

## KPIs (format version 10)

The model gained `kpis: Vec<Kpi>` — author-defined status markup over a base measure. `Kpi { name, base_measure, target: KpiTarget, status_bands: Vec<StatusBand>, description }`; `KpiTarget ∈ { Constant(f64), Measure(name) }`; `StatusBand { threshold: f64, status: KpiStatus }`; `KpiStatus ∈ { OffTrack, AtRisk, OnTrack }`. Builder `Kpi::new(name, base_measure, target).with_status_band(..).with_description(..)`, added via `DataModelBuilder::add_kpi`; accessors `DataModel::kpis()` / `kpi(name)`. Validated at `build()`: unique names, the base measure and any `Measure` target must exist, status-band thresholds must be **strictly ascending**, description within the metadata limit. KPIs are **presentation metadata** — the engine surfaces them in the result-column metadata: `ResultColumn` gained `kpi_name: Option<String>`, set on a base-measure column so the host can render the status indicator (the host computes the status from the base value, target, and bands). `bi_engine::{Kpi, KpiTarget, KpiStatus, StatusBand}`.

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

`Engine::query_with_meta_and_cancellation(request, CancellationToken) -> QueryResult<(Vec<RecordBatch>, Vec<ResultColumn>)>` is the cancellable twin of `query_with_meta` — same metadata sidecar, but stops with `QueryError::Cancelled` when the token fires (the [cancellation](#concurrency--cancellation) contract). Lets a host get column metadata **and** a cancellable long-running query in one call, instead of choosing between them. No `MODEL_FORMAT_VERSION` change.

## Measure-authoring APIs (Studio)

Two **request-free** helpers for the measure editor — neither rebuilds the model:

- `Engine::validate_measure_text(name, text) -> QueryResult<()>` — parse a candidate measure's source text (a `ParseError` with source position on a syntax error) and validate it against the live model: circular / unknown measure references, unknown qualified columns (`Table[Column]`), and unregistered UDF calls. `name` may match an existing measure (validating an edit). A fast pre-check, not a full guarantee (relationship reachability and bare-column refs are not checked here); `add_measure` / planning remain the final authority. Backed by `DataModel::validate_candidate_measure(&Measure)`.
- Dependency graph: `Measure::referenced_measures() -> Vec<&str>` (direct deps), `DataModel::measure_dependents(name) -> Vec<&str>` (reverse edge — "who references X"), and `Expression::measure_references()` / `Expression::qualified_column_references()` walkers. For the lineage panel, safe-rename, and impact-on-delete.

No `MODEL_FORMAT_VERSION` change (read-only/request-time).

## CSV file connector

New `Engine::add_csv_source(ConnectionTarget, AuthMethod) -> ConnectorResult<usize>` registers a directory of CSV files (`<dir>/<table>.csv`, header row required) as a source — load flat-file data with zero database setup. The `target.database` field is the directory; `target.default_schema` (default `"public"`) is the cosmetic source schema. CSV is local, so only `AuthMethod::Integrated` (the process's own file-system access) is accepted — credential methods return `ConnectorError::AuthMethodNotSupported`. Schema is inferred from the file; scalar filters are applied; the engine performs aggregation/joins/ordering locally (a simple scan-with-filters source like the in-memory connector). Table names are validated against path traversal. `bi_engine::CsvConnector`.

## Parquet file connector

New `Engine::add_parquet_source(ConnectionTarget, AuthMethod) -> ConnectorResult<usize>` registers a directory of Apache Parquet files (`<dir>/<table>.parquet`) as a source — the standard columnar interchange format, for data-lake / exported analytical data with zero database setup. Same contract as the [CSV connector](#csv-file-connector): `target.database` is the directory, `target.default_schema` (default `"public"`) is the cosmetic schema, only `AuthMethod::Integrated` is accepted, scalar `filters` / `in_filters` / `or_groups` are applied locally, and table names are validated against path traversal. Unlike CSV, Parquet embeds its Arrow schema, so introspection is **exact** (no header inference). One file per table; types the engine cannot model (nested list/struct) fall back to `String`. `bi_engine::ParquetConnector` / `AnyConnector::Parquet`.

## Context-driven calculated columns (format version 12)

The model gained `context_columns: Vec<ContextColumn>` — a **groupable column whose row-level value is computed per query from a scalar measure resolved against the query's filter context**. It is "dynamic segmentation as a first-class axis": the buckets re-derive from the slicers and can be grouped, ordered, and drilled like an ordinary dimension.

`ContextColumn { name, table, expression, data_type, description }` — builder `ContextColumn::new(name, table, expression, data_type).with_description(...)`, added via `DataModelBuilder::add_context_column`; accessors `DataModel::context_columns()` / `context_column(name)` / `context_columns_for_table(table)`. `bi_engine::ContextColumn`.

**What it is.** Like a `CalculatedColumn`, but the row-level `expression` may reference a scalar **measure** (`Expression::MeasureRef`). At query time, each referenced measure is evaluated **ungrouped** under the query's filters, substituted as a literal, and the resulting CASE is rendered as a GROUP BY key. Example:

```text
PaymentStatus = IF(Invoice[paid_date] <= [AsOfDate], "Paid", "Open")
```

with `AsOfDate = MAX(Calendar[date])`. Grouping by `PaymentStatus` splits revenue into Paid/Open **as of the slicer's date**; changing the date slice moves the as-of date and re-derives the split.

**Build-time validation** (`add_context_column` → `build()`): unique name; the table must exist; the name must not collide with a physical or calculated column; every referenced measure and column must exist; and the expression must be **row-level apart from its measure references** — substituting every reference with a placeholder must leave no aggregates, no context operations, and no window functions (a bare `SUM(...)` directly in the column is rejected; `[Measure]` is allowed). Errors surface as `EngineError::InvalidContextColumn { name, reason }`.

**Why it's safe (no silently-wrong numbers).** The scalar is resolved **only from the filters**, never from the grouping the column defines — it is evaluated ungrouped over the filter-restricted source, which makes a circular definition structurally impossible. The result cache keys on the request's filters and the model version, and the scalar is a deterministic function of those, so two queries with different slices get different cache entries — a slice change never serves a stale segmentation.

**Cross-table references.** The row-level expression may reference the host table's columns **and** a related table's columns over a **fan-out-safe single hop** — an active, equality-only relationship on which the host is the *many* (or one-to-one) side, so the referenced value is a function of the host row (e.g. `IF(Invoice[paid_date] <= [AsOfDate], Customer[tier], "Unpaid")` segments paid invoices by their customer's tier). The referenced table is `LEFT JOIN`ed (an unmatched fact row keeps its place with `NULL` reference columns; the join cannot multiply fact rows), and row-level security on it is enforced by the same two-phase propagation that restricts the fact before the join. Rejected at build time (`InvalidContextColumn`) when no such safe relationship exists (a reference that could inflate the aggregate). At query time, a cross-table reference is supported only when the column's host is the **fact table** being aggregated; otherwise it fails closed. A host-table-only column has no such restriction.

**Other v1 limits (fail closed with `QueryError::InvalidQuery` / `EngineError`):**
- Each referenced scalar measure must be a **single aggregate over one table** (e.g. `MAX`, `MIN`, `SUM`) with **no context operations**. A bare `TODAY()` / `NOW()` is therefore rejected at query time (it is not an aggregate).
- A scalar that resolves to **NULL** under the current filters (e.g. an empty filtered source) is an error, not a guess; an unsupported scalar type (timestamp, interval, …) is also an error.
- Executes **locally only** (never pushed to a source).
- Not combined in one query with: `TotalsMode::Rollup`, a ragged hierarchy, lookup columns, a calculation group, QUERY-in-VAR / window / time-intelligence measures, measures from multiple fact tables, or a many-to-many / non-equi group-by dimension. Request those separately.

**Scalar determinism.** The segmentation is correct and cache-safe as long as the scalar measure is a deterministic function of the data and filters. The cache keys on `filters`, `in_filters`, `or_filters`, and the model version, so a slice change always re-derives the split. The one exception is the engine-wide `TODAY()` / `NOW()` cache-staleness limitation: if a scalar's aggregate reads a calculated column that itself uses `TODAY()`/`NOW()`, its value changes over wall-clock time without changing the cache key (the same caveat applies to any measure using those functions). For a stable as-of axis, drive it from a real date column / slicer rather than a clock function.

In results and `query_with_meta`, a context column appears as an ordinary **dimension** column (`ResultColumnKind::Dimension`) attributed to its host table, carrying its `description`.

**Interdependent columns.** A context column's row-level expression may reference **another context column on the same table** (by name); the reference is inlined in dependency order before the scalars are resolved, so e.g. `PaidTier = IF(Invoice[PaymentStatus] = "Paid" AND Invoice[amount] >= 50, "BigPaid", "Other")` builds on an existing `PaymentStatus` segment. (Multiple *independent* context columns in one query already worked.) A circular reference — direct or indirect — is caught when the column is resolved and fails closed with `QueryError`. No `MODEL_FORMAT_VERSION` change (uses the existing column-reference representation).

**Drillthrough output.** `DetailRequest` gained `context_columns: Vec<ColumnRef>` (builder `with_context_columns`). Each names a context column on the **detail table**; the engine resolves its scalar from the request's filter context (via the same RLS-aware path, so the per-row label matches the segmented cell the user drilled from) and appends the computed value to every returned detail row. The column's physical inputs are fetched automatically. The scalar resolution is RLS-restricted and fails closed on a `NULL` or non-simple-aggregate scalar. v1 drillthrough supports **host-table-only** context columns; a cross-table context column, or combining context columns with `dimension_columns` in one drillthrough, is rejected with `QueryError::InvalidQuery` (request them separately). No `MODEL_FORMAT_VERSION` change (request-time only).

**Fiscal calendars.** A context column's scalar over a fiscal (non-Gregorian) date table is already correct for the supported scalar shape — a plain aggregate such as `MAX(Calendar[date])` is calendar-agnostic (the max date is the max date regardless of the fiscal layout). A period-boundary as-of (e.g. "the end of the current fiscal quarter") would require a richer, period-filtered scalar measure, which the v1 simple-aggregate rule rejects (fail closed); that "richer scalars" capability is deferred.

**Source-side pushdown (PostgreSQL, transparent — no API change).** A context-column query that previously forced local aggregation can now push the resolved `CASE` into the source `GROUP BY` when the shape is unambiguously safe: a single fact on a connector that renders expressions (PostgreSQL today), a **host-table-only** context column, every group-by column on that fact, simple pushable measures, and no `in_filters`/`or_filters`/`measure_filters`/rank/top-N/totals/hierarchy/lookups/calculation-group/window. The engine resolves the scalar to a literal from the (sliced) filter context exactly as before, substitutes it into the `CASE`, and the planner emits a `PushedJoinAggregation` that queries **only** the fact — the as-of reference table is never joined. A filter on the fact is pushed; a filter on a *disconnected* as-of reference (the common slicer) shapes only the already-resolved scalar and is dropped from the fact query; a filter on a fact-related dimension, or any other unhandled shape, falls back to the (unchanged) local path. Active-role RLS predicates are sealed onto the pushed fact query; multi-role queries always go local. There is **no behavioral or result change** — the pushed answer equals the local answer; only the work moves to the source. Any non-PostgreSQL connector keeps aggregating locally. The model-supplied `CASE` (its string branches, the substituted literal) is rendered through the same escaping as every other pushed expression. No `MODEL_FORMAT_VERSION` change (request-time only).

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

**Filter-context time intelligence × `Rollup` and × hierarchies.** Filter-context time intelligence — evaluated when the date is *not* on the group-by axis (the normal pivot shape: subtotal by region/product, slice by date) — now composes with `Rollup` and with a ragged-hierarchy group-by, alone or beside ordinary measures. This covers `YTD`/`QTD`/`MTD`, `DATESINPERIOD`, `CLOSINGBALANCE`/`OPENINGBALANCE`, `PRIORYEAR`/`PRIORPERIOD`/`PARALLELPERIOD`, and compound forms (YoY = `YTD − PRIORYEAR`). Each subtotal / grand total / rolled-up hierarchy level is the time-intelligence measure **re-evaluated over the rolled-up row set** (e.g. a grand-total `CLOSINGBALANCE` is the closing balance over *all* rows on the boundary day, and a grand-total `YTD(DISTINCTCOUNT(...))` recounts distinct values across the level — never a sum of per-group values). A filter-context period shift over a gapped date context still fails closed (the contiguity guard). Axis-mode running windows (a date column *on* the group-by axis) and ranking still fail closed (`InvalidQuery`); see the [`TotalsMode`] unsupported list.

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

> **Known limitations (deferred):** in **axis mode**, an outer `KEEP` around a single window measure now applies (a non-date filter restricts the running total); a `KEEP` around a *compound* one fails closed. **`TotalsMode::Rollup` and ragged hierarchies compose with the full filter-context family** — `YTD`/`QTD`/`MTD`, `DATESINPERIOD`, `CLOSING`/`OPENINGBALANCE`, `PRIORYEAR`/`PRIORPERIOD`/`PARALLELPERIOD`, and compound YoY (see the [Rollup result contract](#totalsmoderollup-result-contract)). **Fiscal (non-Gregorian) calendars** are supported for filter-context `YTD`/`QTD`/`MTD` (period start from the role columns) and `CLOSING`/`OPENINGBALANCE`. Still deferred (they error rather than mislead): axis-mode windows/period-shifts (a date column on the group-by axis), value-based (gap-tolerant) period shifts, fiscal **period shifts**/`DATESINPERIOD`, and compound × hierarchy.

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

### Dynamic RLS — `USERNAME()` / `CUSTOMDATA()` (format version 11)

A role predicate can now resolve to the **runtime identity** instead of a fixed value, so one role restricts each user to their own rows:

```rust
SecurityRole::new("PerUser").with_filters(vec![
    FilterPredicate::username("dim_user", "email", ComparisonOp::Equal),     // = USERNAME()
    // or FilterPredicate::custom_data("dim_tenant", "id", ComparisonOp::Equal) // = CUSTOMDATA()
]);
```

The host sets the identity after authentication:

| Method | Signature | Notes |
|---|---|---|
| `set_user_identity` | `(&mut self, identity: Option<String>)` | Resolves `USERNAME()` predicates (DAX `USERNAME()`). Part of the query-cache key (a result for one user is never served to another); changing it invalidates the cache. |
| `set_custom_data` | `(&mut self, data: Option<String>)` | Resolves `CUSTOMDATA()` predicates (e.g. a tenant id). Same cache/invalidate semantics. |
| `user_identity` / `custom_data` | `(&self) -> Option<&str>` | The current values. |

- The model JSON gains a `dynamic` field on a role's `FilterPredicate` (`"Username"` / `"CustomData"`); absent for a static predicate (back-compat with pre-v11 role files).
- **Fail closed:** a query under a role with a dynamic predicate and **no** matching identity set is refused with `EngineError::RowLevelSecurityNotEnforceable` — never an unrestricted (or placeholder-literal) result. The identity is substituted to a concrete value before any planning or rendering, on every query path.
- The dynamic-ness is a **typed** field, not a magic string: a static predicate whose value is literally `"USERNAME()"` is a plain literal and is **not** substituted.

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
- **Filter-context period shifts (`PRIORYEAR`/`PRIORPERIOD`/`PARALLELPERIOD`/`DATEADD`, date *not* on the axis) over a gapped date context fail closed** (`EngineError::TimeIntelligence`): a filter-context shift moves the whole `[min, max]` window back by calendar periods, so if the filter keeps some periods inside the window but excludes others (e.g. a slicer selecting Jan and Mar but not Feb), the shifted range would silently include the excluded period (an over-count). The engine now verifies the context is contiguous before shifting — the same guarantee the axis path already gives. `YTD`/`QTD`/`MTD`/`DATESINPERIOD` build their range from the as-of date and are unaffected. Remove the internal gap from the date filter, or put a date column on the group-by axis (which shifts each period positionally).
- **Filter-context time intelligence on a fiscal (non-Gregorian) date table:** `YTD`/`QTD`/`MTD` now derive the period start from the date table's `Year`/`Quarter`/`Month` **role columns** (not the Gregorian date key), so fiscal-year-to-date is correct (e.g. a July fiscal-year rollover). `CLOSINGBALANCE`/`OPENINGBALANCE` (boundary-day balances) are calendar-agnostic and also work. Period shifts (`PRIORYEAR`/`PRIORPERIOD`/`PARALLELPERIOD`) and `DATESINPERIOD` over a fiscal calendar still **fail closed** (`EngineError::TimeIntelligence`) — they need fiscal-period arithmetic; put a date column on the group-by axis for those.
- **Multi-fact-table queries no longer cartesian-explode** when a conformed dimension is reachable from the later facts but not the first — the combine now joins on the shared dimension. (A pure correctness fix; no API change.)
- **A `NULL` group-by dimension member is no longer split into two half-blank rows** when results are combined across sides — multi-fact-table queries, `USERELATIONSHIP` override measures, and a window/time-intelligence measure beside an ordinary one all combine their per-side results with a **NULL-safe** join, so a legitimate `NULL` member (a blank attribute) yields **one** row carrying every measure rather than duplicated rows each missing some. Grouping by a nullable dimension now returns correct, un-split rows. (Pure correctness fix; no API change.)
- **Local-source filter type fidelity** (CSV and in-memory connectors): a range filter (`>`, `<`, `>=`, `<=`) on a **dictionary-encoded integer** column now compares numerically rather than lexically (`'100' > '50'` was wrongly false, silently dropping rows); a **Boolean** column filter renders a real boolean literal instead of erroring. Both the connector and the cached-batch filter paths now share one type-aware literal renderer.
- **Window / running / ranking measures over a mixed-case group-by or `PARTITIONBY` column** previously errored (`FieldNotFound` from an identifier-case mismatch); they now resolve. (Affects models whose column names are not all-lowercase.)

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
