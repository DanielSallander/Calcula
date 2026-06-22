# Calcula Engine Lib

A columnar analytical engine library (Rust crate) that provides in-memory data modeling, query planning with pushdown, and measure computation. Embedded by both **Calcula** (spreadsheet) and **Calcula Studio** (data model designer).

**Design philosophy:** This is a **library**, not a server. Like SQLite, it is embedded into host applications. It enables local-first analytical computation.

See `docs/architecture.md` for the full vision, data flow diagrams, and feature roadmap.

## Tech Stack

- **Language:** Rust (latest stable)
- **Columnar Format:** Apache Arrow (`arrow` crate) — in-memory columnar representation
- **Query Engine:** Apache DataFusion (`datafusion` crate) — SQL parsing, query planning, execution
- **Database Connectors:** `sqlx` for PostgreSQL, `tiberius` for SQL Server
- **Serialization:** `serde` + `serde_json` for model definitions and configuration
- **Error Handling:** `thiserror` for library errors, `anyhow` in tests/examples only
- **Testing:** Built-in Rust tests (`cargo test`), with integration tests in `tests/`
- **Async Runtime:** `tokio` (required by sqlx, DataFusion)

## Project Structure

```
calcula-engine/
├── CLAUDE.md
├── Cargo.toml                  # Workspace root
├── docs/
│   └── architecture.md         # Vision document, data flows, feature roadmap
│
├── crates/
│   ├── engine-core/            # Core columnar engine
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── model/          # Data model (tables, columns, relationships)
│   │       │   ├── mod.rs
│   │       │   ├── table.rs
│   │       │   ├── column.rs
│   │       │   ├── relationship.rs
│   │       │   └── schema.rs
│   │       ├── store/          # Columnar storage backed by Arrow
│   │       │   ├── mod.rs
│   │       │   └── memory.rs
│   │       ├── compute/        # Aggregation and measure computation
│   │       │   ├── mod.rs
│   │       │   ├── aggregate.rs
│   │       │   └── measure.rs
│   │       └── types.rs        # Shared type definitions
│   │
│   ├── engine-query/           # Query planning and pushdown
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── planner/        # Query planner with pushdown decisions
│   │       │   ├── mod.rs
│   │       │   ├── pushdown.rs
│   │       │   └── optimizer.rs
│   │       └── executor/       # Query execution orchestration
│   │           ├── mod.rs
│   │           └── pipeline.rs
│   │
│   └── engine-connectors/      # Data source connectors
│       ├── Cargo.toml
│       └── src/
│           ├── lib.rs
│           ├── traits.rs       # Connector trait definition
│           ├── postgres.rs
│           ├── sqlserver.rs
│           └── csv.rs          # For testing and simple file sources
│
├── tests/                      # Integration tests
│   ├── model_tests.rs
│   ├── aggregation_tests.rs
│   ├── query_tests.rs
│   └── connector_tests.rs
│
└── examples/                   # Usage examples
    └── basic_model.rs
```

### Crate Responsibilities

- **`engine-core`**: Data model definitions, columnar storage, aggregation, measure computation. Zero network dependencies. This is the heart of the library.
- **`engine-query`**: Query planning, pushdown logic, execution orchestration. Depends on `engine-core` and `engine-connectors`.
- **`engine-connectors`**: Data source connector trait and implementations. Each connector translates abstract queries to source-specific SQL. Depends on `engine-core` for types only.

### Dependency Direction

```
engine-query → engine-core
engine-query → engine-connectors
engine-connectors → engine-core (types only)
```

`engine-core` depends on neither of the other crates. It must be usable standalone for pure in-memory computation with no network dependencies.

## Architecture Constraints

1. **Library, not server.** No listening on ports, no HTTP endpoints, no global state. The host application manages lifecycle.

2. **`engine-core` is self-contained.** It must never depend on `engine-query` or `engine-connectors`. It works with in-memory data only. If you need to add something that involves I/O or networking, it goes in another crate.

3. **Arrow is the internal format.** All columnar data is represented as Arrow `RecordBatch` and `ArrayRef` types internally. Do not create custom columnar representations — use Arrow.

4. **DataFusion for query execution.** Use DataFusion's query planning and execution infrastructure rather than building a custom query engine. Build BI-specific capabilities (measures, context manipulation, relationship traversal) as custom DataFusion extensions (custom `TableProvider`, `ExecutionPlan`, or UDFs).

5. **Connectors are pluggable.** All data source access goes through the `Connector` trait defined in `engine-connectors/src/traits.rs`. Adding a new source means implementing this trait — no changes to core or query crates.

6. **Maximum pushdown.** The query planner must push as much work as possible to data sources. Filters, aggregations, joins within a single source — all pushed down. Only cross-source joins and custom measures execute locally.

7. **No panics in library code.** All fallible operations return `Result<T, EngineError>`. Reserve `unwrap()` and `expect()` for cases where failure is truly impossible (and add a comment explaining why). Panics are acceptable in tests only.

8. **Every connector must support the auth abstraction.** Authentication is separated from connection targets so that model files never contain secrets. When adding a new data source connector, you MUST:
   - a. Implement `ConnectorAuth` for your connector struct (declares supported auth methods).
   - b. Add a `from_target(ConnectionTarget, AuthMethod) -> ConnectorResult<Self>` constructor to your config type alongside any raw-string constructor.
   - c. Add an `Engine::add_<name>_source(ConnectionTarget, AuthMethod)` method to the `Engine` facade.
   - d. Add a variant to `AnyConnector` in `registry.rs` (the compiler enforces `ConnectorAuth` via the `supported_auth_methods()` dispatch).
   - e. Handle **all** `AuthMethod` variants in `from_target` — return `ConnectorError::AuthMethodNotSupported` for methods you don't support.
   See `engine-connectors/src/auth.rs` for the full type definitions and checklist.

9. **Document every host-facing change.** `docs/host-integration-changelog.md` is the committed log that the **Calcula Studio** and **Calcula** teams rely on to track changes to the library boundary. Whenever you make a change that those host applications need to know about, you MUST add an entry to that changelog in the same change. A change is host-facing — and therefore requires a changelog entry — if it touches any of:
   - The public API surface (new/changed/removed public types, functions, methods, or trait signatures host apps call).
   - The model JSON format (any serialized field, including a `MODEL_FORMAT_VERSION` bump).
   - A request contract (`QueryRequest`, `DetailRequest`, or any other host-supplied request type — new/changed/removed fields).
   - The result contract (shape, columns, or metadata of returned data).
   - Error variants the host can observe.
   - Behavioral changes in existing surface that alter what a host sees (semantics, defaults, fail-closed conditions).

   Purely internal changes (refactors, private helpers, test-only code, performance work with no observable difference) do NOT need an entry. When in doubt, ask: *"Would the Calcula Studio or Calcula team have to change their code, model files, or expectations because of this?"* If yes, log it. Follow the existing per-feature format and keep the version-history table in sync.

## Coding Conventions

### Rust Style

- Follow standard Rust conventions (`rustfmt`, `clippy` with default lints)
- Run `cargo fmt` before every commit
- Run `cargo clippy` and address all warnings
- Use `snake_case` for functions, methods, variables, modules
- Use `PascalCase` for types, traits, enums
- Use `SCREAMING_SNAKE_CASE` for constants

### Error Handling

Define a crate-level error enum using `thiserror` in each crate:

```rust
// engine-core/src/error.rs
use thiserror::Error;

#[derive(Debug, Error)]
pub enum EngineError {
    #[error("Table '{0}' not found")]
    TableNotFound(String),

    #[error("Column '{column}' not found in table '{table}'")]
    ColumnNotFound { table: String, column: String },

    #[error("Type mismatch: expected {expected}, got {actual}")]
    TypeMismatch { expected: String, actual: String },

    // ...
}
```

- Use specific error variants, not generic string errors
- Implement `From` conversions for underlying errors (Arrow, DataFusion, sqlx)
- Propagate errors with `?` — do not silently swallow errors

### Public API Design

- Every public type, function, and method must have a doc comment (`///`)
- Public APIs should be minimal — expose only what host applications need
- Use the builder pattern for complex configuration:

```rust
let model = DataModel::builder()
    .add_table(sales_table)
    .add_table(products_table)
    .add_relationship(sales_to_products)
    .add_measure("Revenue", sum("Sales", "Amount"))
    .build()?;
```

- Return owned types from public APIs, not references to internal state
- Mark internal modules and types as `pub(crate)` — not everything needs to be public

### Module Organization

- Use the folder-as-module pattern: `model/mod.rs` re-exports from `model/table.rs`, `model/column.rs`, etc.
- Keep files under 400 lines. If a file grows beyond this, split it into submodules.
- Each module's `mod.rs` should primarily contain re-exports and brief module-level documentation
- Put tests in the same file as the code they test (`#[cfg(test)] mod tests { ... }`) for unit tests
- Put integration tests that span multiple modules in the top-level `tests/` directory

### Naming

- Model types: `Table`, `Column`, `LookupColumn`, `LookupSpec`, `Relationship`, `Measure`, `DataModel`
- Storage types: `ColumnStore`, `TableData`
- Compute types: `AggregateOp`, `MeasureEngine`
- Query types: `QueryPlan`, `PushdownDecision`, `QueryExecutor`
- Connector types: `Connector` (trait), `PostgresConnector`, `SqlServerConnector`
- Avoid abbreviations in public APIs (use `relationship`, not `rel`; `aggregate`, not `agg`)
- Internal/private code may use common abbreviations (`col`, `ctx`, `cfg`)

## Data Types

The engine supports these column data types, mapped to Arrow types:

| Engine Type | Arrow Type | Rust Type |
|------------|------------|-----------|
| `Int32` | `Int32Array` | `i32` |
| `Int64` | `Int64Array` | `i64` |
| `Float64` | `Float64Array` | `f64` |
| `Decimal` | `Decimal128Array` | `i128` (with precision/scale) |
| `String` | `StringArray` | `String` |
| `Boolean` | `BooleanArray` | `bool` |
| `Date` | `Date32Array` | `i32` (days since epoch) |
| `Timestamp` | `TimestampMicrosecondArray` | `i64` |

Use Arrow's native null handling — do not use `Option<T>` wrappers around Arrow arrays.

## Testing

### Requirements
- Every public function must have at least one test
- Tests must be deterministic — no reliance on timing, external services, or random data
- Use descriptive test names: `test_sum_aggregate_with_null_values`, not `test1`
- Integration tests for connector crates may use Docker-based test databases (document setup in the crate README)

### Test Structure
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sum_aggregate_returns_correct_total() {
        // Arrange
        let table = create_test_table_with_amounts(vec![10.0, 20.0, 30.0]);

        // Act
        let result = compute_aggregate(&table, "amount", AggregateOp::Sum).unwrap();

        // Assert
        assert_eq!(result, 60.0);
    }
}
```

### Test Utilities
- Create shared test helpers in a `test_utils` module (or `tests/common/mod.rs` for integration tests)
- Provide factory functions for common test data: `create_test_table`, `create_test_model`, `create_test_relationship`
- For connector tests that need a real database, use `#[ignore]` and document how to run them

## Build and Run

```bash
# Build all crates
cargo build

# Run all tests
cargo test

# Run tests for a specific crate
cargo test -p engine-core

# Run clippy
cargo clippy --all-targets

# Format code
cargo fmt

# Build documentation
cargo doc --no-deps --open
```

## Build Order / Milestones

Development should follow this order. Each milestone produces a usable library:

1. **Columnar storage + basic aggregation** — Define tables with typed columns, insert data, compute SUM/COUNT/AVG/MIN/MAX over a single table. Arrow-backed storage.
2. **Data model + relationships** — Multiple tables with foreign-key relationships. Relationship traversal. Star schema support.
3. **Connector trait + PostgreSQL connector** — Abstract connector interface. First real data source. Basic query generation.
4. **Query pushdown** — Query planner that decides what to push to the source vs. compute locally. Filter and aggregation pushdown.
5. **Measure engine** — Named measures, calculated columns, measure groups. Evaluation against the columnar store.
6. **Cross-source joins** — Fetch from multiple sources, join locally. Relationship-based join resolution.
7. **SQL Server connector** — Second data source implementation.
8. **Context manipulation** — Filter context, evaluation context for measures (DAX-inspired semantics).

## Common Mistakes to Avoid

- Creating custom columnar types instead of using Arrow arrays
- Building a custom query engine instead of extending DataFusion
- Adding network I/O to `engine-core` (it must stay I/O-free)
- Using `String` errors instead of typed error enums
- Making internal types public "just in case"
- Writing connector code that is tightly coupled to a specific database (use the trait)
- Forgetting null handling — analytical data always has nulls
- Using `panic!` / `unwrap()` in library code paths
- Adding a new connector without implementing `ConnectorAuth` or `from_target()`
- Storing credentials in model files (only `ConnectionTarget` is serializable; `AuthMethod` is not)
- Making a host-facing change (public API, model JSON, request/result contract, error variant, or `MODEL_FORMAT_VERSION` bump) without adding an entry to `docs/host-integration-changelog.md`
