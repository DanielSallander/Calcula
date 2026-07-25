# Calcula Engine Lib — Foundation Document

## Overview

The Engine Lib is a shared Rust crate that provides the core analytical processing capabilities for the Calcula BI ecosystem. It is consumed as a library by both **Calcula Studio** (data model design) and **Calcula** (report consumption and rendering). This is the foundational project — both other projects depend on it.

**Design philosophy:** The engine is a **library**, not a server. Like SQLite, it can be embedded into any application that needs analytical processing. This enables local-first computation where data is pulled to the client and processed on the user's machine.

> **For host integrators:** the per-release log of host-facing changes — every new public API, model-file field, `QueryRequest`/`DetailRequest` field, result contract, error variant, and `MODEL_FORMAT_VERSION` bump — lives in [host-integration-changelog.md](host-integration-changelog.md). Start there when moving a model or a host (Calcula / Calcula Studio) onto a newer engine.

## Position in the Ecosystem

```
┌─────────────────┐     ┌─────────────────┐
│  Calcula Studio │     │    Calcula       │
│  (design tool)  │     │  (spreadsheet)   │
└────────┬────────┘     └────────┬─────────┘
         │                       │
         │    ┌──────────────┐   │
         └───►│  Engine Lib  │◄──┘
              │  (Rust crate)│
              └──────┬───────┘
                     │
              ┌──────▼───────┐
              │  Data Sources │
              │  SQL Server   │
              │  PostgreSQL   │
              │  (others)     │
              └──────────────┘
```

## Core Responsibilities

### 1. Columnar In-Memory Storage

The engine stores data in a columnar format optimized for analytical queries. This means:

- Data is organized by column rather than by row
- Compression is applied per-column (similar to VertiPaq in Analysis Services)
- Aggregation operations (SUM, AVG, COUNT, etc.) are extremely fast because they operate on contiguous memory
- The engine handles datasets that fit in local memory (target: millions of rows with reasonable column counts)

### 2. Relational Data Model

The engine manages a multi-table data model with:

- **Tables**: Named collections of typed columns
- **Columns**: Strongly typed (integer, float, string, date, boolean, etc.)
- **Lookup columns**: Columns that can be retrieved post-aggregation rather than included in GROUP BY. Requested per-query via `LookupColumn`, with automatic key inference when unambiguous. The lookup value is resolved using the column's `lookup_resolution` expression (default: `MIN(column)`). This significantly improves performance for pivot tables with many dimension properties.
- **Relationships**: Foreign-key relationships between tables (one-to-many, many-to-one)
- **Star/Snowflake schemas**: Support for fact tables and dimension tables connected via relationships

This is the equivalent of the PowerPivot/Analysis Services Tabular data model.

### 3. Measure Computation

Measures are named calculations defined over the data model:

- Aggregate expressions (SUM, COUNT, AVERAGE, MIN, MAX, DISTINCTCOUNT)
- Calculated columns (row-level computations that produce a new column)
- Measures with context manipulation (filtering, grouping) using a DAX-inspired expression language with KEEP, CLEAR, RESET, and USING context operations
- A built-in text parser converts DAX-like syntax (e.g., `SUM(Sales[amount], KEEP(Calendar, Calendar[Year] = 2024))`) into the internal Expression AST — shared by Calcula Studio and any other tool
- **Time intelligence**: YTD/QTD/MTD running totals, PRIORYEAR/SAMEPERIODLASTYEAR/PRIORPERIOD/PARALLELPERIOD shifts, DATESINPERIOD trailing windows, and CLOSINGBALANCE/OPENINGBALANCE semi-additive balances against a marked date table, evaluated either from the group-by axis or purely from the filter context (no date column on the axis — where period shifts work at year/quarter/month granularity and a running total accepts any range-computable aggregate, including AVERAGE/DISTINCTCOUNT), failing closed rather than returning a silently-wrong value when the window cannot be computed
- **Calculation groups**: named transforms (calculation items, e.g. `Current`/`YTD`/`PY`) applied across the measures in a request via a `SELECTEDMEASURE()` placeholder, producing one value column per measure×item
- **Host-extensible functions**: native Rust scalar UDFs registered by the host, plus optionally sandboxed Rhai script functions carried inside the model file (deny-by-default, host-set budgets)
- The measure computation engine evaluates these against the columnar store

### 4. Query Generation with Maximum Pushdown

When data lives in an external database, the engine generates optimized queries:

- **Pushdown principle**: Let the database do as much work as possible
- WHERE clauses, GROUP BY, JOINs (within the same source), and aggregations are pushed to the database
- Only pre-aggregated result sets cross the network
- The engine handles what the database cannot: cross-source joins, custom measures, context manipulation

**Pushdown decision matrix:**

| Operation | Source DB supports it? | Action |
|-----------|----------------------|--------|
| WHERE filtering | Yes | Push to source |
| GROUP BY aggregation | Yes | Push to source |
| JOINs (same source) | Yes | Push to source |
| Cross-source JOINs | No | Pull both sides, join locally |
| Custom measures | No | Compute locally |
| Context manipulation | No | Compute locally |

### 5. Query Planning

The query planner is responsible for:

- Analyzing the user's request (which measures, which dimensions, which filters)
- Determining which parts can be pushed down to each data source
- Generating source-specific SQL (or other query languages)
- Orchestrating the execution: push down, fetch results, compute locally, return final result
- Caching strategies for repeated queries

### 6. Cross-Source Joins

When a data model spans multiple sources (e.g., sales data in PostgreSQL, product catalog in SQL Server), the engine:

- Fetches pre-aggregated data from each source (with maximum pushdown)
- Performs the join locally in the columnar store
- Resolves relationships defined in the data model across source boundaries

A single model can register **many** connectors at once (`SourceRegistry` holds a `Vec` of connectors; each table binds to one), so multi-source ("composite") models work in both import and Direct Query mode. The wiring is **persisted** in the model file — see [§8](#8-authentication-and-data-source-persistence) — and reconnected on load via `Engine::wire_sources`. As an **opt-in** optimization (`Engine::set_semi_join_config`, default off), a restricted fact's join keys can be pushed to a large, unfiltered, connector-backed dimension so it pulls only the rows that will survive the join; it applies only in the provably result-preserving single-fact case.

### 7. Data Source Connectors

The engine provides a connector abstraction for different data sources:

- **SQL Server** — via TDS protocol
- **PostgreSQL** — via native Rust PostgreSQL drivers
- **Additional sources** — extensible connector interface for future sources (MySQL, REST APIs, CSV/Parquet files, etc.)

Each connector is responsible for:
- Connection management (pooling, authentication)
- Query dialect translation (the planner generates abstract queries; the connector translates to source-specific SQL)
- Result set deserialization into columnar format

### 8. Authentication and Data Source Persistence

Authentication is separated from connection targeting so that **model files never contain secrets**. This mirrors how SSAS models work: the model declares *where* to connect, and each user's own identity resolves the actual authentication.

#### Core Types (in `engine-connectors/src/auth.rs`)

- **`ConnectionTarget`** — host, port, database, schema, TLS settings. Secret-free. The runtime "where to connect" the facade hands a connector.
- **`AuthMethod`** — how to authenticate (Integrated, UsernamePassword, EnvironmentVariable). **Not serializable** because it may contain secrets.
- **`AuthMethodKind`** — secret-free discriminant of `AuthMethod`. Serializable; persisted as a preferred-auth *hint*.
- **`ConnectionSpec`** — a connectors-level convenience bundling `ConnectionTarget` + `AuthMethodKind` (used at the facade boundary; it is **not** itself the serialized model form — see below).
- **`ConnectorAuth`** trait — declares which auth methods a connector type supports.

#### Persisted source catalog (model format ≥ 14)

Because `engine-core` (which owns `DataModel`) must not depend on `engine-connectors`, the model file stores a **neutral, secret-free mirror** rather than `ConnectionTarget`/`ConnectionSpec` directly:

- **`DataModel.sources`** — a catalog of `PersistedSource { id, kind, connection, preferred_auth }` (engine-core). `connection` is a `PersistedConnection` (the secret-free half of a `ConnectionTarget`); `preferred_auth` is an auth-kind hint. No credentials.
- **`Table.source_binding`** — `TableSourceBinding { source_id, schema, table }` naming which catalog source a table's rows come from and where.

The engine facade translates `PersistedSource` ↔ `ConnectionTarget`/`AnyConnector` and rebuilds the live `SourceRegistry` via **`Engine::wire_sources`** (the host re-supplies each source's `AuthMethod` at that point — never persisted; in-memory sources are re-supplied as a connector). Loading a model opens **no** connections. The composite-model authoring helpers (`Engine::add_<kind>_source_with_id`, `bind_source_table`/`bind_source_tables`) record the catalog and bindings as sources are added, so a multi-source model round-trips through save/reopen without the host re-binding every table.

#### Auth Methods

| Method | Description | Secrets stored? |
|--------|-------------|----------------|
| `Integrated` | Windows/SSPI/Kerberos — uses the OS-level identity of the running process | None |
| `UsernamePassword` | Explicit credentials provided by the host app at connection time | In memory only, never persisted by the engine |
| `EnvironmentVariable` | Credentials read from named env vars at connection time | Only variable names are stored |

#### Flow

1. **Model file** stores a secret-free `PersistedSource` per data source (target + preferred auth kind) plus each table's `source_binding`.
2. **Host application** loads the model, then calls `Engine::wire_sources`, resolving an `AuthMethod` per source from the user's environment (e.g., for `Integrated`, it passes through; for `UsernamePassword`, it may prompt the user).
3. **Engine** builds each connector from the persisted `ConnectionTarget` + the supplied `AuthMethod` and re-binds every table whose `source_binding` names a wired source.
4. **Connector** builds its native connection string from the structured parts via `Config::from_target()`.

#### Checklist for New Connector Authors

When adding a new data source connector, you MUST:

1. Implement `ConnectorAuth` for your connector struct.
2. Add `YourConfig::from_target(ConnectionTarget, AuthMethod)` constructor.
3. Handle **every** `AuthMethod` variant — return `AuthMethodNotSupported` for unsupported ones.
4. Add `Engine::add_<name>_source(ConnectionTarget, AuthMethod)` to the facade.
5. Add a variant to `AnyConnector` in `registry.rs` (the compiler enforces `ConnectorAuth`).
6. Add tests for each supported auth method.

### 9. Row-Level Security

Named **security roles** carry per-table row filters that the host activates after authenticating a user (`Engine::set_active_role`, or `set_active_roles` for a set whose permitted rows **union**). The filters are injected as a **sealed pre-aggregation layer** — applied at fetch / pushed-`WHERE` level, *not* through the measure-context machinery — so no `RESET`/`CLEAR`/`ALL`-style context operation can strip them. When multiple roles are active and each restricts the same table with a single predicate, the engine rewrites the set into a sealed single-table `OR` slicer (Power BI union semantics); richer multi-role shapes fail closed. The (canonicalized) role identity is folded into the query-cache key so a result computed under one role or role set can never be served to another.

Enforcement is conservative and **fails closed**: if a role-filtered table is reachable from a queried fact but not via a single-hop, single-column, active, equi relationship, the query is *refused* (`RowLevelSecurityNotEnforceable`) rather than executed with the fact left unrestricted. Because the engine is an embedded client-side library, RLS is **advisory** against a cooperative host — it governs what the engine returns, not what a determined host could read directly from the source.

### 10. Drillthrough / Detail Rows

`Engine::query_rows(DetailRequest)` returns the **raw fact rows** behind a pivot cell with no aggregation — the baseline spreadsheet "show the underlying transactions" gesture. It is RLS-enforced, mandatorily row-capped, and deliberately **not cached** (interactive and per-cell). It can attach related dimension attributes to each row via a deduplicated single-hop `LEFT JOIN`, so a non-unique dimension key cannot fan out or multiply rows.

### 11. The Model File as a Trust Boundary

The shared `.model` file travels between hosts and users, so the engine treats **everything in it except credentials as untrusted input**: identifiers and filter values are escaped through one shared quoting layer, connections are built from typed parts (never string interpolation), disk-cache filenames are sanitized against path traversal, parser recursion is depth-guarded, and a deserialized expression AST is re-validated against the parser allow-list. Sandboxed script bodies are deny-by-default and never execute on load. The file carries a `format_version`; opening a file newer than the engine supports fails closed with `ModelFormatTooNew`, and every new field is additive so older files keep loading. See [host-integration-changelog.md](host-integration-changelog.md) for the version history and the exact field/API names.

## Data Flow

```
User interaction (filter, drill, refresh)
        │
        ▼
┌─────────────────────────┐
│     Query Planner       │
│                         │
│  Analyze request        │
│  Determine pushdown     │
│  Generate source queries│
└───────────┬─────────────┘
            │
     ┌──────┴──────┐
     ▼              ▼
┌─────────┐   ┌─────────┐
│Source A  │   │Source B  │
│(SQL Svr) │   │(PgSQL)  │
│          │   │          │
│Pushed-   │   │Pushed-   │
│down query│   │down query│
└────┬─────┘   └────┬─────┘
     │               │
     ▼               ▼
  Result A        Result B
  (aggregated)    (aggregated)
     │               │
     └───────┬───────┘
             ▼
┌─────────────────────────┐
│   Local Columnar Store  │
│                         │
│  Cross-source joins     │
│  Measure computation    │
│  Context manipulation   │
│  Pivoting / slicing     │
└───────────┬─────────────┘
            │
            ▼
     Final result set
     (to Calcula grid or
      Studio preview)
```

## Key Design Decisions

1. **Library, not server**: The engine is embedded, enabling offline use and local-first computation. No server infrastructure required for basic usage.

2. **Maximum pushdown**: The database does the heavy lifting for filtering and aggregation. The engine only pulls what it needs.

3. **Columnar storage**: Optimized for analytical (OLAP) workloads, not transactional (OLTP). Read-heavy, aggregate-heavy operations are the primary use case.

4. **Source-agnostic data model**: The relational model (tables, relationships, measures) is defined independently of where the data comes from. The same model could pull from different sources in different deployments.

5. **Extensible connectors**: New data sources can be added by implementing the connector interface without changing the core engine.

## Rust Ecosystem — Crates to Investigate

- **Apache Arrow** (`arrow` crate): Columnar in-memory format. Industry standard. Provides the memory layout for columnar data, zero-copy reads, and interoperability.
- **DataFusion** (`datafusion` crate): Query execution engine built on Arrow. Provides SQL parsing, query planning, and execution. Could serve as a foundation for the query planner rather than building from scratch.
- **ConnectorX** or **sqlx**: Database connectivity for PostgreSQL, SQL Server, etc.
- **Parquet** (`parquet` crate): For reading/writing Parquet files as a data source or for local caching.

The recommendation is to evaluate Arrow + DataFusion as the foundation and build the BI-specific layer (relational model, measures, context manipulation, pushdown optimization) on top.

## Relationship to Other Projects

| Project | How it uses Engine Lib |
|---------|----------------------|
| **Calcula Studio** | Uses the engine to validate data models, preview measure results, test connections, and generate query plans. Studio adds a design UI on top. |
| **Calcula** | Embeds the engine to execute queries at runtime, populate components with data, compute measures, and handle refresh cycles. Calcula adds grid rendering and component management on top. |

## Build Priority

**This is the first project to build.** The recommended approach:

1. Start with columnar storage and basic aggregation (SUM, COUNT, AVG over a single table)
2. Add relationship resolution (multi-table model with joins)
3. Add data source connectors (PostgreSQL first, then SQL Server)
4. Add query pushdown logic
5. Add measure computation engine
6. Add cross-source join capability

Each stage produces a usable library that the other projects can start integrating against.

**Current status:** The engine supports columnar storage, star/snowflake relationships (including many-to-many via EXISTS semi-joins, active/inactive relationships and `USERELATIONSHIP`), PostgreSQL and SQL Server connectors with an in-memory connector for testing, query pushdown (filter/aggregation/context/relationship), measure computation with context manipulation, table variables, execution plan visualization, text-based measure definition via a DAX-like parser, DAX-inspired functions (IF, SWITCH, DIVIDE, ROUND, math functions, etc.), named context definitions (CONTEXT), scalar variables (VAR/RETURN), two-stage aggregation via QUERY-in-VAR, per-query lookup columns, and ragged hierarchies.

Beyond that baseline, the engine adds the host-facing capabilities catalogued in [host-integration-changelog.md](host-integration-changelog.md): presentation metadata; pivot-shaped results (`order_by`/`limit`/sort-by-column and `ROLLUP` totals with a `__grouping_id` indicator); multi-select (`in_filters`) and cross-column `OR` (`or_filters`) slicers; measure-value filters (`HAVING`) and `RANKX`-style `rank_by` ranking; window/time-intelligence measures requested **alongside ordinary measures** in one query; a result-column metadata sidecar (`query_with_meta`) and editor-time measure validation + dependency-graph APIs for Studio; sargable integer filter pushdown; `&self` concurrent queries with cooperative cancellation; **time intelligence** (axis and filter-context modes, including semi-additive balances); **row-level security** (single role or multi-role union); **drillthrough / detail rows** with dimension-attribute output; **incremental refresh** (user-defined volatility filter) with structured `RefreshReport`; **calculation groups**; a **CSV file connector** for flat-file sources; **scripting** (native UDF registry + sandboxed Rhai script functions); **persisted multi-source (composite) models** (a secret-free `sources` catalog + per-table `source_binding`, reconnected on load via `Engine::wire_sources`); and an **opt-in cross-source semi-join pushdown** that shrinks large dimension fetches. The shared model file is now a hardened trust boundary with `MODEL_FORMAT_VERSION` evolution (currently `14`). Across these waves the overriding rule is **never return a silently-wrong number — fail closed instead**.

## Ingest-Time Optimization and Caching Architecture

The engine operates as a local-first, per-user library — not a central server. This fundamentally changes the optimization trade-offs compared to systems like VertiPaq (Analysis Services / Power BI):

- In a central model, heavy upfront processing (complex compression, dictionary encoding, sort ordering) pays off because it runs once on a server and benefits many subsequent queries.
- In Calcula's distributed model, each user refreshes independently on their own hardware. Processing cost is paid per user, per refresh, every time. The optimal point on the cost curve is therefore much lower — cheap optimizations that run instantly and reduce memory/disk usage with near-zero overhead.

This philosophy drives the following architectural layers.

### Automatic Batch Optimizer (`engine-core::optimize`)

A single `optimize_batch()` function runs once per ingested `RecordBatch`, applying three transformations:

**1. Integer narrowing.** SQL Server and PostgreSQL routinely return `BIGINT`/`Int64` for columns where the actual values fit in `Int8`, `Int16`, or `Int32`. The optimizer scans min/max (a single SIMD-friendly pass via Arrow's aggregate kernels) and casts to the narrowest type that fits. All-null columns are left unchanged.

**2. Dictionary encoding of low-cardinality strings.** Country codes, status fields, category names — columns where the number of distinct values is small relative to the row count. The optimizer samples up to 8,192 rows and counts distinct values. If the ratio falls below a configurable threshold (default: 50%), the column is wrapped in `DictionaryArray<Int32, Utf8>`. The scan early-exits the moment the ratio exceeds the threshold, so high-cardinality columns (user IDs, free text) cost almost nothing to evaluate. DataFusion handles `DictionaryArray` natively in joins and aggregations.

**3. Timestamp-to-Date32 conversion.** Date-only columns frequently arrive as `Timestamp` (8 bytes) when `Date32` (4 bytes) would suffice. The optimizer checks every non-null value; if all fall on day boundaries (midnight), it converts. Handles all four Arrow `TimeUnit` variants (nanosecond, microsecond, millisecond, second).

Configuration is exposed via `OptimizerConfig` with per-optimization toggles, tunable thresholds, and a `min_rows_to_analyze` floor (default: 1024) that skips analysis on batches too small to benefit.

The optimizer runs at three integration points:

| Path | When | Effect |
|------|------|--------|
| `Engine::refresh_table()` | In-memory table refresh | Persistent — optimized data stays in cache |
| Pipeline fetch registration | Local aggregation queries | Transient — reduces memory during DataFusion execution |
| Auto-tiered dimension tables | First query touching a dimension | Persistent — cached for session lifetime |

### Sort on Load

After optimization, cached tables are sorted by their primary join key, inferred automatically from the data model's relationship graph:

- Fact tables (the "from" side of `ManyToOne` relationships) are sorted by the foreign key column.
- Dimension tables (the "to" side) are sorted by the primary key column.
- When a table appears in multiple relationships, the fact-side FK is preferred (most impactful for join performance).

Sorting improves hash join probe locality (grouped key values → better CPU cache behavior), makes subsequent dictionary encoding more effective (sorted strings produce longer runs), and benefits filter scans when predicates target the sort column. The cost is a single `lexsort_to_indices` + `take` pass — negligible relative to the network fetch that produced the data.

### Auto-Tier Dimension Caching

Dimension tables are typically small (thousands to a few hundred thousand rows) but touched by nearly every query. Fetching the same `dim_customer` table from the source 50 times in a session is pure waste. The auto-tier system addresses this:

**Candidate identification.** A table is eligible if it appears as the "to" (one/dimension) side of a `ManyToOne` relationship, is not explicitly set to `InMemory` by the user, has a registered source binding, and has not been previously rejected (too many rows).

**Lazy caching.** When `query_auto_tier()` is called, the engine identifies which candidates are needed by the current query's `group_by` columns. Those tables are fetched with `LIMIT max_rows + 1`, and if the result fits within the configured threshold (default: 100,000 rows), the data is optimized, sorted, and cached. If it exceeds the threshold, the table is marked as rejected and never re-checked.

**Background pre-warm.** After the query returns results to the user, `auto_tier_remaining()` caches all other eligible dimension tables. The user doesn't wait for this — they're already reading the results of their first query. By the time they pivot to a different dimension, it's likely already warm.

**TTL-based staleness.** Auto-tiered tables have a configurable TTL (default: 1 hour). When the TTL expires, the table is re-fetched. If it has grown beyond the row threshold, it's evicted from cache and rejected.

**Planner awareness.** The pushdown planner is informed of auto-tiered tables via `plan_with_cached()`, ensuring they are treated as local data (forcing `LocalAggregation` rather than attempting to push aggregation to the source). The pipeline serves any table present in the cache, regardless of its `StorageMode` setting in the model.

**Discoverability.** `auto_tiered_tables()` and `auto_tier_rejected_tables()` let the host application show the user which tables were automatically cached and which were skipped.

### Query-Result LRU Cache

The engine caches completed query results so that repeated identical queries return instantly:

**Cache key.** A deterministic hash of the `QueryRequest` (measures, group_by, filters, lookups) combined with a model version counter. The model version is bumped on any change that could affect results (model edits, data refreshes, auto-tier changes).

**LRU eviction.** The cache enforces two limits: maximum entry count (default: 256) and maximum memory (default: 64 MB). When either is exceeded, the least-recently-accessed entry is evicted.

**TTL expiry.** Entries expire after a configurable duration (default: 5 minutes). For DirectQuery tables, the source can change at any time without the engine knowing, so a short TTL provides a conservative safety net. Host applications can increase the TTL if they know data is stable, or call `clear_query_cache()` when data changes are detected.

**Transparent integration.** The cache is checked before query execution in `query()`, `query_auto_tier()`, and `query_auto_refresh()`. `query_explained()` intentionally bypasses the cache because plans and timing differ per execution.

**Automatic invalidation.** The entire cache is invalidated (all entries cleared, model version bumped) when:
- `refresh_table()` is called (underlying data changed)
- `set_model()` is called (measure definitions or schema changed)
- An auto-tiered table is newly cached (available local data changed)

This is whole-cache invalidation — simple and safe. Per-table invalidation tracking could be added later for finer granularity, but the cache refills quickly due to LRU and the common case (user re-runs the same report) hits on the first query after invalidation.

### Compressed Disk Cache

The engine persists cached in-memory tables to disk on shutdown and restores them on startup, avoiding full re-fetches from the source. The format is Arrow IPC with **Zstd compression**, which typically reduces file sizes by 60–80% compared to uncompressed Arrow IPC.

The Arrow IPC reader handles decompression transparently, so the load path requires no special handling. Metadata (cache age, schema hash, fingerprint) is stored alongside in `metadata.json` to support TTL-based staleness checks and schema compatibility validation across sessions.

### Optimization Observability

Optimization statistics are reported at two levels:

**ExecutionPlan nodes.** Each `SourceFetch` plan node includes properties showing what the optimizer did: columns narrowed, strings dictionary-encoded, timestamps converted, percentage of bytes saved, and absolute byte counts. These appear in `query_explained()` output and can be rendered by the host application for debugging and tuning.

**`refresh_table_explained()`.** Returns `OptimizationStats` after refreshing a cached table, letting the host app surface diagnostics like "Refreshed dim_products: 3 cols narrowed, 2 dictionary-encoded, 45% smaller."
