# Adding a database vendor

This engine is designed so a new data source plugs in by implementing a small,
fixed surface — never by editing the query planner, the expression renderer, or
the registry dispatch by hand. This document lists exactly what you implement.

## The universal floor: a fetch-only connector

Every connector implements the [`Connector`] trait
(`crates/engine-connectors/src/traits.rs`):

```rust
trait Connector {
    fn capabilities(&self) -> ConnectorCapabilities { ConnectorCapabilities::fetch_only() }
    async fn list_tables(&self) -> ConnectorResult<Vec<SourceTable>>;
    async fn introspect_table(&self, schema: &str, table: &str) -> ConnectorResult<Table>;
    async fn fetch_data(&self, request: &FetchRequest) -> ConnectorResult<Vec<RecordBatch>>;
    async fn execute_query(&self, sql: &str) -> ConnectorResult<Vec<RecordBatch>>;
    async fn row_count(&self, schema: &str, table: &str) -> ConnectorResult<usize>;
    // execute_join_aggregation has a default that returns UnsupportedOperation.
}
```

The **only** required behavior is `fetch_data`: return the table's rows (as Arrow
`RecordBatch`es) with the full [`FetchRequest`] restriction contract applied —
`filters` **and** `in_filters` **and** `or_groups`. Honoring all three is a
hard correctness/security requirement: dropping any of them over-returns rows,
which is both a wrong aggregate and a row-level-security leak. A connector that
cannot push these down to its source must apply them locally (the
`InMemoryConnector`/`CsvConnector`/`ParquetConnector` do this with DataFusion).

A fetch-only connector advertises no pushdown. The planner computes everything
except the per-source scan locally — which is correct, just not maximally
pushed. **A non-SQL source (REST API, document store, columnar files) is a
perfectly good connector**: it implements `fetch_data` by translating
`FetchRequest` to its own API and pushes nothing else. It does *not* need a SQL
dialect.

## The six things you implement (a full SQL vendor with pushdown)

1. **A `Connector` impl** — open the pool, run the catalog queries
   (`list_tables`/`introspect_table`/`row_count`), and convert wire rows to
   Arrow via a [`RowReader`] (next item). Override `capabilities()` to opt into
   pushdown once you have a dialect (item 4).

2. **A [`RowReader`] impl** (`crates/engine-connectors/src/arrow_build.rs`) — ~30
   lines of typed `try_get` wrappers over your driver's row type, handling its
   wire-type quirks. The shared generic `rows_to_record_batches` owns all the
   Arrow-builder dispatch, the `Date32` epoch math, the microsecond timestamp
   packing, and the decimal rescaling (via `crate::decimal`). You write the thin
   per-column getters; you do **not** re-implement the ~150-line builder match.

3. **A `name_to_engine_type` table** — map your source's column type names to the
   engine `DataType`, reusing the shared `DEFAULT_DECIMAL_PRECISION`/`SCALE`
   constants for unconstrained decimals. This is the genuine "which spellings
   exist" knowledge only you have.

4. **(Optional) A [`Dialect`] impl + an [`ExpressionDialect`] impl** — only if
   you want expression pushdown (compound measures, star-schema JOIN
   aggregation, context columns). `Dialect` (`engine-core`,
   `crates/engine-core/src/compute/expression/render/dialect.rs`) owns the SQL
   *text* spellings that differ between vendors (aggregates, `CAST` targets,
   percentile syntax, scalar-function rewrites, ordered-set aggregates, the
   materialized-node policy). Every method returns `EngineResult`: if your
   dialect cannot spell a node, return `Err` — the renderer propagates it and
   the planner falls back to local aggregation (**fail-soft; never a
   silently-wrong query**). `ExpressionDialect`
   (`crates/engine-connectors/src/sql_builder.rs`) ties your engine-core
   `Dialect` to the connector layer so the shared `build_join_aggregation_sql`
   can render your measures; the join/where/group-by structure is shared.

5. **A [`ConnectorAuth`] impl + a `from_target(ConnectionTarget, AuthMethod)`
   constructor** — declare which `AuthMethodKind`s you support; resolve
   credentials with the shared `auth::resolve_credentials` (env-var lookup,
   NUL-byte rejection, and the single place every `AuthMethod` variant is
   handled) and `auth::validate_target`. Build your driver config from the typed
   `ConnectionTarget` (never assemble a connection string from untrusted parts).
   `ConnectionTarget` is the only serializable half — secrets live in
   `AuthMethod`, which never reaches a model file.

6. **One line in `define_any_connector!`** (`crates/engine-query/src/registry.rs`)
   — add `MyVendor => MyConnector,`. The macro generates the `AnyConnector`
   variant, every dispatch arm, and the `From<MyConnector>` conversion. The
   generated `supported_auth_methods` arm statically calls
   `MyConnector::supported_auth_methods()`, so **forgetting `ConnectorAuth`
   fails to compile**. Then register with `engine.add_source(my_connector)` (or
   add a typed `Engine::add_my_vendor_source` wrapper for ergonomics).

## What the engine gives you for free

- **The capability gate.** Because `capabilities()` defaults to fetch-only and
  the planner gates every pushed-join branch on it, a new connector is
  *structurally incapable* of being handed a query it cannot answer — until it
  both declares the capability and ships the dialect. Partially-capable vendors
  push only what they support and compute the rest locally.
- **The shared SQL builders** (`sql_builder.rs`): plain/aggregate/join SQL,
  filter binding, inline IN-lists, temp-table staging, ROLLUP — all generic over
  the connector-side `SqlDialect` (identifier quoting, placeholders, `LIMIT` vs
  `TOP`, …). You supply the dialect primitives; the structure is shared.
- **The shared row→Arrow path, decimal rescaling, and auth resolution.**

## What is deliberately closed (and why)

- `AnyConnector` is a closed enum, not `Box<dyn Connector>`. It is the only thing
  that makes a missing `ConnectorAuth` impl a compile error, and the trait's
  `async fn` methods are not `dyn`-compatible anyway. The macro removes the
  boilerplate without losing the enforcement.
- `AuthMethod` is `#[non_exhaustive]` and never serialized; `ConnectionTarget`'s
  serialized shape carries no vendor-specific fields, so adding a vendor needs no
  `MODEL_FORMAT_VERSION` bump.

## Status

PostgreSQL is the only connector with full expression pushdown today
(`PostgresDialect` + `ExpressionDialect`). SQL Server, CSV, Parquet, and the
in-memory connector are fetch-only and compute compound/JOIN queries locally.
Giving SQL Server pushdown is now "implement a `SqlServerDialect` (engine-core)
+ `ExpressionDialect`, return the capability" — no planner or builder changes.
