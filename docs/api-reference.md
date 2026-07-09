# Calcula Engine — API Reference

This document covers the public types and methods available through the `engine` facade crate.

## Engine

The top-level facade that coordinates model, sources, and queries.

```rust
use engine::*;
```

### Creating an Engine

```rust
let model = DataModel::builder()
    .add_table(Table::new("Sales", vec![
        Column::new("id", DataType::Int64),
        Column::new("amount", DataType::Float64),
    ])?)
    .add_measure(sum_measure("Revenue", "Sales", "amount"))
    .build()?;

let mut engine = Engine::new(model);
```

### Connecting Data Sources

```rust
// PostgreSQL
let pg_idx = engine
    .add_postgres(
        ConnectionTarget::new("localhost", "db").with_port(5432),
        AuthMethod::UsernamePassword {
            username: "user".into(),
            password: "pass".into(),
        },
    )
    .await?;

// SQL Server
let ss_idx = engine
    .add_sqlserver(
        ConnectionTarget::new("localhost", "mydb").with_port(1433),
        AuthMethod::UsernamePassword {
            username: "sa".into(),
            password: "secret".into(),
        },
    )
    .await?;
```

### Binding Tables to Sources

Map model table names to physical source tables:

```rust
engine.bind_table("Sales", pg_idx, SourceBinding::new("public", "sales"));
engine.bind_table("Products", ss_idx, SourceBinding::new("dbo", "product"));
```

`add_postgres` / `add_sqlserver` / `add_*_source` + `bind_table` wire sources **at runtime only** — nothing is written to the model file, so the host must re-issue them every load.

### Persisted Multi-Source (Composite) Models

To let a multi-source model **save and reopen** without re-wiring, register sources under a stable id (recorded in the model's secret-free `sources` catalog) and bind tables through the composite API. Model format ≥ 14.

```rust
// Author time — register + persist, then bind (records Table.source_binding):
engine.add_postgres_source("sales_pg", pg_target, pg_auth).await?;   // async; also add_sqlserver_source
engine.add_csv_source_with_id("catalog_csv", csv_target, AuthMethod::Integrated)?; // sync file/in-memory variants
engine.bind_source_table("sales_pg", "public", "sales", Some("Sales"))?;
engine.bind_source_tables("catalog_csv").await?;  // introspect + add + bind every table the source exposes
engine.save_model(path)?;                          // catalog + bindings persisted; NO secrets

// Load time — reconnect; the host re-supplies each source's AuthMethod here:
let model = Engine::load_model(path)?;             // opens no connections
let mut engine = Engine::new(model);
let report = engine.wire_sources_with_auth(&auth_by_source_id).await?;  // or wire_sources(|src| ...)
// report.unbound_tables → surface as "reconnect required" (they fail closed at query time).
```

`SourceCredential` (`Auth(AuthMethod)` | `Connector(AnyConnector)` — required for in-memory sources | `Skip`) drives the `wire_sources(resolver)` form. Secrets are **never** persisted — only a `ConnectionTarget`-equivalent and a preferred-auth *kind* hint. See the persisted-source types (`PersistedSource`, `TableSourceBinding`, `SourceKind`) under [Connectors](#connectors).

### Cross-Source Semi-Join Pushdown (opt-in)

For composite models with large cross-source dimensions, enable reverse (fact → dimension) key pushdown so a restricted fact shrinks the dimension's fetch. Off by default; result-preserving (single-fact case only). See the [changelog](host-integration-changelog.md#cross-source-semi-join-pushdown-opt-in--no-format-change).

```rust
engine.set_semi_join_config(SemiJoinConfig { reverse_pushdown: true, ..Default::default() });
```

### Querying

```rust
let results = engine.query(QueryRequest {
    measures: vec!["Revenue".into()],
    group_by: vec![ColumnRef::new("Sales", "region")],
    filters: vec![FilterCondition::new("year", FilterOperator::Equal, "2024")],
    ..Default::default()
}).await?;
```

`QueryRequest` implements `Default`, so set only the fields you need and spread
`..Default::default()` for the rest. The full field set:

| Field | Type | Purpose |
|---|---|---|
| `measures` | `Vec<String>` | Measure names to compute (required). |
| `group_by` | `Vec<ColumnRef>` | Dimension columns to group by. |
| `filters` | `Vec<FilterCondition>` | Scalar slicers, ANDed and pushed to the source. |
| `in_filters` | `Vec<InFilter>` | Multi-select (`IN`-list) slicers. |
| `or_filters` | `Vec<FilterCondition>` | Cross-column `OR` slicer (single table). |
| `measure_filters` | `Vec<MeasureFilter>` | `HAVING` — keep rows by computed measure value. |
| `rank_by` | `Option<RankBy>` | Append a `RANKX`-style ranking column. |
| `order_by` | `Vec<OrderByClause>` | Result ordering (by group-by column or measure). |
| `limit` | `Option<usize>` | Max result rows (after ordering / ranking). |
| `totals` | `TotalsMode` | `Rollup` adds subtotals + a `__grouping_id` column. |
| `hierarchy_group_by` | `Option<HierarchyGroupBy>` | Group by a model hierarchy's levels. |
| `calculation_group` | `Option<CalculationGroupApplication>` | Cross-apply calculation items. |
| `lookups` | `Vec<LookupColumn>` | Resolve dimension attributes post-aggregation. |

For results **with per-column metadata** (dimension vs. measure, format string,
display name, calculation-item attribution), use `engine.query_with_meta(req)`,
which returns `(Vec<RecordBatch>, Vec<ResultColumn>)`.

### Query with Execution Plan

Returns results alongside a structured execution plan describing each phase:

```rust
let (results, plan) = engine.query_explained(QueryRequest {
    measures: vec!["Revenue".into()],
    group_by: vec![ColumnRef::new("Products", "category")],
    ..Default::default()
}).await?;

// plan.summary → "Query: [Revenue] grouped by [Products.category]"
// plan.total_duration.ms → 45.2
// plan.root.children → [PushdownDecision, SourceFetch, ..., LocalAggregation]

let json = serde_json::to_string_pretty(&plan)?;
println!("{json}");
```

See [Execution Plan](#execution-plan) section below for the plan tree types.

### Saving / Loading Models

```rust
engine.save_model(Path::new("model.json"))?;
let model = Engine::load_model(Path::new("model.json"))?;
```

### Replacing the Model

Replace the data model at runtime while preserving all registered connectors and table bindings:

```rust
let new_model = DataModel::builder()
    // ... rebuild with additional measures ...
    .build()?;
engine.set_model(new_model);
```

This is useful for dynamically adding user-defined measures without reconnecting to data sources.

### Accessors

| Method | Returns | Description |
|--------|---------|-------------|
| `model()` | `&DataModel` | Reference to the data model |
| `set_model(model)` | `()` | Replace the data model, keeping the registry |
| `registry()` | `&SourceRegistry` | Reference to the source registry |
| `registry_mut()` | `&mut SourceRegistry` | Mutable reference to the source registry |

---

## Data Model

### DataModel

Built via `DataModel::builder()`. Contains tables, relationships, measures, calculated columns, and named contexts.

```rust
let model = DataModel::builder()
    .add_table(sales_table)
    .add_table(products_table)
    .add_relationship(Relationship::many_to_one(
        "Sales_Products", "Sales", "product_id", "Products", "id",
    ))
    .add_measure(sum_measure("Revenue", "Sales", "amount"))
    .add_context(ContextDefinition::new("ctx_2024", vec![
        ContextOp::Keep(vec![
            FilterPredicate::new("Calendar", "Year", ComparisonOp::Equal, "2024"),
        ]),
    ]))
    .build()?;
```

Key accessors on `DataModel`:

| Method | Returns | Description |
|--------|---------|-------------|
| `tables()` | `&[Table]` | All tables |
| `table(name)` | `EngineResult<&Table>` | Lookup table by name |
| `relationships()` | `&[Relationship]` | All relationships |
| `measures()` | `&[Measure]` | All measures |
| `measure(name)` | `EngineResult<&Measure>` | Lookup measure by name |
| `calculated_columns()` | `&[CalculatedColumn]` | All calculated columns |
| `contexts()` | `&[ContextDefinition]` | All named context definitions |
| `context(name)` | `EngineResult<&ContextDefinition>` | Lookup context by name |
| `table_variables()` | `&[TableVariable]` | All table variables |
| `table_variable(name)` | `EngineResult<&TableVariable>` | Lookup table variable by name |
| `validate()` | `EngineResult<()>` | Validate model integrity |

The model serializes to/from JSON via `serde`.

### Table

```rust
let table = Table::new("Sales", vec![
    Column::new("id", DataType::Int64),
    Column::new("product_id", DataType::Int64),
    Column::new("amount", DataType::Float64),
    Column::new("region", DataType::String),
])?;
```

#### Storage Mode

Tables can be configured for **in-memory caching** to avoid repeated network fetches for small, rarely-changing dimension tables. By default, all tables use `DirectQuery` (fetched from the source on every query).

```rust
use engine::StorageMode;

// Mark a dimension table for in-memory caching.
let products = Table::new("Products", vec![
    Column::new("id", DataType::Int64),
    Column::new("name", DataType::String),
])?.with_storage_mode(StorageMode::InMemory);
```

After adding the table to the model and binding it to a source, refresh it:

```rust
// Load data into the in-memory cache.
engine.refresh_table("Products").await?;

// Refresh all in-memory tables at once.
engine.refresh_all_in_memory().await?;
```

Subsequent queries that reference `Products` will read from the cache instead of fetching from the database. The cache tracks memory usage with a configurable budget (default 256 MB):

```rust
// Custom memory budget (e.g. 512 MB).
let engine = Engine::with_memory_budget(model, 512 * 1024 * 1024);

// Check staleness.
if engine.needs_refresh("Products", std::time::Duration::from_secs(3600)) {
    engine.refresh_table("Products").await?;
}
```

**Design notes:**
- In-memory tables always use `LocalAggregation` (aggregation is never pushed to the source).
- The two-phase relationship filter propagation (IN-filter optimization) works transparently with cached dimensions.
- The host application controls refresh timing — the engine does not run timers.
- JSON serialization is backward-compatible: `storage_mode` is omitted when `DirectQuery`.

#### Lookup Columns

Lookup columns are dimension columns that are retrieved post-aggregation rather than included in the GROUP BY clause. This avoids unnecessary GROUP BY complexity and improves performance for pivot tables with many dimension properties.

**The problem:** In tabular models, every column added to a pivot table becomes a GROUP BY level. If you group by `Product.CategoryId` and also want to display `Product.CategoryName`, both end up in GROUP BY — even though `CategoryName` is fully determined by `CategoryId`.

**The solution:** Request `CategoryName` as a lookup column. The engine automatically:
1. Groups by the key column only (smaller, faster aggregation)
2. Joins the dimension table back after aggregation to look up the requested column
3. Auto-infers the key column when exactly one `group_by` column is from the same table

Lookups are defined per-query via `QueryRequest.lookups`, not on the model:

```rust
// Group by category_id, look up category_name and category_description
// after aggregation. Key is auto-inferred (category_id is the only
// group_by column from Products).
let results = engine.query(QueryRequest {
    measures: vec!["Revenue".into()],
    group_by: vec![ColumnRef::new("Products", "category_id")],
    filters: vec![],
    lookups: vec![
        LookupColumn::new("Products", "category_name"),
        LookupColumn::new("Products", "category_description"),
    ],
}).await?;
```

#### Explicit Key

When there are multiple `group_by` columns from the same table, auto-inference cannot determine the key. Specify it explicitly:

```rust
let results = engine.query(QueryRequest {
    measures: vec!["Revenue".into()],
    group_by: vec![
        ColumnRef::new("Products", "category_id"),
        ColumnRef::new("Products", "subcategory_id"),
    ],
    filters: vec![],
    lookups: vec![
        LookupColumn::with_key("Products", "category_name", "category_id"),
    ],
}).await?;
```

#### Custom Resolution Expression

By default, lookup columns are resolved using `MIN(column)`. For columns that need a different resolution strategy, set `lookup_resolution` on the `Column` definition:

```rust
let products = Table::new("Products", vec![
    Column::new("id", DataType::Int64),
    Column::new("category_id", DataType::Int32),
    Column::new("category_name", DataType::String)
        .with_lookup_resolution("MAX(category_name)"),
    Column::new("color", DataType::String),
])?;
```

### LookupColumn

Specifies a column to look up post-aggregation.

```rust
// Auto-infer key from group_by context
let lookup = LookupColumn::new("Products", "category_name");

// Explicit key column
let lookup = LookupColumn::with_key("Products", "category_name", "category_id");
```

| Method | Returns | Description |
|--------|---------|-------------|
| `table()` | `&str` | The table containing the lookup column |
| `column()` | `&str` | The column to look up |
| `key()` | `Option<&str>` | Explicit key column (None = auto-infer) |

**Key auto-inference rules:**
- If exactly one `group_by` column is from the same table as the lookup, it is used as the key
- If zero or multiple `group_by` columns match, an explicit key must be provided (otherwise `InvalidLookup` error)

**How it works internally:**

1. **Query planning** (`PushdownPlanner`): Resolves each `LookupColumn` into a `LookupSpec` with pre-rendered SQL and the inferred or explicit key.
2. **SQL generation** (`pipeline.rs`): Builds the aggregation SQL with key-only GROUP BY.
3. **Post-aggregation lookup**: Registers the aggregation result as a temporary table, JOINs back to the dimension table on the key column, and SELECTs the lookup value using the resolution expression (default: `MIN(column)`).
4. **Execution plan**: Reports `lookups` in the plan for transparency.

Lookup columns only affect the `LocalAggregation` path (multi-table queries). Filtering on lookup columns works normally -- the lookup designation only affects GROUP BY behavior.

### Column

```rust
let col = Column::new("amount", DataType::Float64);

// With optional lookup resolution expression
let col = Column::new("category_name", DataType::String)
    .with_lookup_resolution("MAX(category_name)");
```

| Method | Returns | Description |
|--------|---------|-------------|
| `with_lookup_resolution(expr)` | `Self` | Set custom resolution expression for post-aggregation lookups (default: `MIN(column)`) |
| `lookup_resolution()` | `Option<&str>` | The resolution expression, if set |

### DataType

Supported column types:

| DataType | Arrow Type | Rust Type |
|----------|------------|-----------|
| `Int32` | `Int32Array` | `i32` |
| `Int64` | `Int64Array` | `i64` |
| `Float64` | `Float64Array` | `f64` |
| `String` | `StringArray` | `String` |
| `Boolean` | `BooleanArray` | `bool` |
| `Date` | `Date32Array` | `i32` |
| `Timestamp` | `TimestampMicrosecondArray` | `i64` |

### Relationship

```rust
// Standard star-schema relationship (ManyToOne, Auto propagation)
let rel = Relationship::many_to_one(
    "Sales_Products", "Sales", "product_id", "Products", "id",
);

// With explicit propagation control
let rel = Relationship::new(
    "Sales_Products", "Sales", "product_id", "Products", "id",
    Cardinality::ManyToOne,
).with_propagation(FilterPropagation::None);
```

**Cardinality options:** `ManyToOne`, `OneToMany`, `OneToOne`

**FilterPropagation options:**

| Propagation | Behavior | Default for |
|-------------|----------|-------------|
| `Auto` | Filters on dimension auto-propagate to fact table | `ManyToOne` |
| `None` | No auto-propagation; requires `traverse()` | `OneToMany`, `OneToOne` |
| `Both` | Bidirectional propagation | — |

---

## Measures

### Convenience Constructors

```rust
let revenue   = sum_measure("Revenue", "Sales", "amount");
let orders    = count_measure("OrderCount", "Sales", "id");
let avg_price = average_measure("AvgPrice", "Sales", "amount");
let products  = distinct_count_measure("ProductCount", "Sales", "product_id");
```

### Expression Measures

For complex calculations, use `expression_measure` with the expression builder:

```rust
use engine::expression::{self as expr, ComparisonOp, FilterPredicate};
use engine::AggregateOp;

// SUM(price * quantity)
let revenue = expression_measure(
    "Revenue",
    "Sales",
    expr::agg(AggregateOp::Sum, expr::col("price").multiply(expr::col("quantity"))),
);

// SUM(amount) / COUNT(id)
let avg_order = expression_measure(
    "AvgOrder",
    "Sales",
    expr::agg(AggregateOp::Sum, expr::col("amount"))
        .divide(expr::agg(AggregateOp::Count, expr::col("id"))),
);

// Safe division: DIVIDE(SUM(amount), COUNT(id))
let avg_order = expression_measure(
    "AvgOrder",
    "Sales",
    expr::safe_divide(
        expr::agg(AggregateOp::Sum, expr::col("amount")),
        expr::agg(AggregateOp::Count, expr::col("id")),
        None, // returns BLANK on zero
    ),
);

// COUNTROWS
let total = expression_measure(
    "TotalRows",
    "Sales",
    expr::count_rows(),
);

// ROUND(DIVIDE(...), 2)
use engine::expression::ScalarFunction;
let rounded_avg = expression_measure(
    "RoundedAvg",
    "Sales",
    expr::scalar_fn(ScalarFunction::Round, vec![
        expr::safe_divide(
            expr::agg(AggregateOp::Sum, expr::col("amount")),
            expr::count_rows(),
            None,
        ),
        expr::lit_int(2),
    ]),
);

// COALESCE(SUM(amount), 0)
let safe_sum = expression_measure(
    "SafeRevenue",
    "Sales",
    expr::coalesce(vec![
        expr::agg(AggregateOp::Sum, expr::col("amount")),
        expr::lit_int(0),
    ]),
);

// With context manipulation (see Expression Functions doc)
let us_revenue = expression_measure(
    "US_Revenue",
    "Sales",
    expr::agg(
        AggregateOp::Sum,
        expr::keep(
            expr::col("amount"),
            vec![FilterPredicate::new("Sales", "region", ComparisonOp::Equal, "US")],
        ),
    ),
);
```

### Measure Expression Parser

Parse DAX-like text expressions into the internal `Expression` AST. The parser lives in `engine-core` and is re-exported by the `engine` facade.

```rust
use engine::{parse_measure, parse_measure_expression, parse_table_variable, expression_measure, infer_fact_table};

// Parse expression text into an Expression AST
let expr = parse_measure_expression("SUM(Sales[amount])")?;

// Parse with fact-table validation — errors if no qualified column ref
let expr = parse_measure("SUM(Sales[amount], KEEP(dim_date, dim_date[year] = 2024))")?;
// infer_fact_table(&expr) == Some("Sales".to_string())

// Create a named measure from the parsed expression
let measure = expression_measure("Revenue 2024", expr);

// Parse a table variable definition
let (source, filters) = parse_table_variable(r#"KEEP(Products, Products[category] = "Bikes")"#)?;
// source == "Products", filters == [category = "Bikes"]
let var = TableVariable::new("bikes", source, filters);
```

Supported syntax:
- Aggregations: `SUM`, `COUNT`, `AVG`/`AVERAGE`, `MIN`, `MAX`, `DISTINCTCOUNT`, `COUNTROWS`
- Conditional: `IF(condition, true, false)`, `SWITCH(expr, val, result, ..., default)`
- Safe division: `DIVIDE(num, den [, alt])`
- Null handling: `BLANK()`, `ISBLANK(expr)`, `COALESCE(expr, expr, ...)`
- Math: `ABS`, `ROUND`, `ROUNDUP`, `ROUNDDOWN`, `INT`, `TRUNC`, `CEILING`, `FLOOR`, `MOD`, `POWER`, `SQRT`, `LN`, `LOG10`, `SIGN`
- Arithmetic: `+`, `-`, `*`, `/` with standard precedence
- Column refs: `table[column]` or `variable[column]`
- Table variables: `KEEP(source_table, filter, ...)` (standalone for VAR definitions)
- Context ops: `KEEP(table, table[col] op value)`, `CLEAR(table)`, `CLEAR(table[col])`, `RESET()`, `USING(name)`
- Named contexts: bare name references (e.g., `SUM(t[col], ctx_bikes)`)
- Scalar variables: `VAR name = expr ... RETURN result`
- Two-stage aggregation: `VAR tbl = QUERY(AGG(t[col]) AS alias BY t[col], ...) RETURN AGG(tbl[alias])`
- Comparison operators: `=`, `!=`, `>`, `>=`, `<`, `<=`
- Logical operators (in IF conditions): `AND`, `OR`, `NOT`
- String literals: `"quoted"`, Numeric literals: `42`, `3.14`

### Parsing Context Definitions

```rust
use engine::parse_context;

// Parse a named context from text syntax
let ctx = parse_context("ctx_bikes", r#"KEEP(dim_product, dim_product[categoryname] = "Bikes")"#)?;
// Returns a ContextDefinition ready to add to the model

// Composed context referencing another context
let ctx = parse_context("ctx_bikes_2024", r#"ctx_2024, KEEP(dim_product, dim_product[categoryname] = "Bikes")"#)?;
```

### Measure

| Method | Returns | Description |
|--------|---------|-------------|
| `name()` | `&str` | Measure name |
| `table()` | `&str` | Table the measure operates on |
| `expression()` | `&Expression` | The expression tree |
| `group()` | `Option<&str>` | Optional measure group name |
| `is_simple_aggregate()` | `bool` | True if `AGG(column)` or `COUNTROWS` — pushable to source |
| `simple_column()` | `Option<&str>` | Column name for simple aggregates |
| `simple_operation()` | `Option<AggregateOp>` | Operation for simple aggregates |

### MeasureGroup

Group related measures for organization:

```rust
let group = MeasureGroup::new("Financial", vec!["Revenue", "Cost", "Profit"]);
```

---

## Query

### QueryRequest

```rust
let request = QueryRequest {
    measures: vec!["Revenue".into()],
    group_by: vec![
        ColumnRef::new("Products", "category"),
        ColumnRef::new("Calendar", "year"),
    ],
    filters: vec![
        FilterCondition {
            column: "region".into(),
            operator: FilterOperator::Equal,
            value: "US".into(),
        },
    ],
    lookups: vec![],
};
```

### ColumnRef

Fully qualified table + column reference:

```rust
let col_ref = ColumnRef::new("Products", "category");
```

### Query Execution

The engine automatically decides what to push down to sources vs. compute locally:

- **Single table + simple aggregates** (including `COUNTROWS`) → Pushed to data source (SQL `GROUP BY` + aggregation)
- **Expression measures** (`DIVIDE`, `IF`, `ROUND`, etc.) → Fetches raw data, aggregates locally via DataFusion
- **Multi-table / cross-source / context ops** → Fetches raw data, joins and aggregates locally via DataFusion

---

## Named Contexts

Define reusable filter configurations at the model level:

```rust
let ctx = ContextDefinition::new("bikes_2024", vec![
    ContextOp::Keep(vec![
        FilterPredicate::new("Calendar", "Year", ComparisonOp::Equal, "2024"),
        FilterPredicate::new("Products", "Category", ComparisonOp::Equal, "Bikes"),
    ]),
]);
```

### ContextOp

| Variant | Description |
|---------|-------------|
| `Keep(Vec<FilterPredicate>)` | AND filter conditions into context |
| `Clear(Vec<ClearTarget>)` | Remove specific filters (both sources) |
| `Reset` | Remove all filters (both sources) |
| `ClearInner(Vec<ClearTarget>)` | Remove inner (group-by) filters only |
| `ClearOuter(Vec<ClearTarget>)` | Remove outer (query-level) filters only |
| `ResetInner` | Remove all inner (group-by) filters |
| `ResetOuter` | Remove all outer (query-level) filters |
| `KeepIn(Vec<InPredicate>)` | Apply IN-membership filters |
| `Inherit(String)` | Include another named context's operations |

### ClearTarget

| Variant | Description |
|---------|-------------|
| `Column { table, column }` | Clear filters on a specific column |
| `Table(String)` | Clear all filters on a table |

### FilterSource

Identifies where a filter originated (runtime only, not serialized):

| Variant | Description |
|---------|-------------|
| `Query` | Outer: slicer/page filters from `QueryRequest.filters` (default) |
| `GroupBy` | Inner: matrix row/column context from `QueryRequest.group_by` |

Source-specific operations (`clear_inner`, `clear_outer`, `reset_inner`, `reset_outer`) only affect filters matching their source.

---

## Table Variables

Named, pre-filtered table references. Composable — a variable can be based on another variable.

```rust
let premium = TableVariable::new(
    "premium",
    "Products",
    vec![FilterPredicate::new("Products", "category", ComparisonOp::Equal, "Premium")],
);

// Compose: named_premium inherits premium's filters + adds its own
let named = TableVariable::new(
    "named_premium",
    "premium",
    vec![FilterPredicate::new("Products", "name", ComparisonOp::NotEqual, "")],
);
```

Added to the model via `DataModelBuilder::add_table_variable()`. Variable names must be unique and not collide with table names. Circular references are detected and rejected.

### Referencing Columns

Use `qualified_col()` to reference a column through a table variable:

```rust
// premium.category — resolves variable's filters into context
expr::qualified_col("premium", "category")
```

### InPredicate

Set-membership filter testing column values against a table variable:

```rust
let pred = InPredicate::new("Sales", "product_id", "premium", "id");
// Generates: Sales.product_id IN (SELECT id FROM Products WHERE category = 'Premium')
```

Used in `keep_in()` expressions or `ContextOp::KeepIn`.

---

## Connectors

### ConnectionTarget

```rust
let target = ConnectionTarget::new("host", "db").with_port(5432);
```

| Method | Returns | Description |
|--------|---------|-------------|
| `new(host, database)` | `Self` | Create a target with host and database |
| `with_port(port)` | `Self` | Set the port (default: 5432 for PG, 1433 for SQL Server) |
| `host()` | `&str` | The hostname |
| `database()` | `&str` | The database name |
| `port()` | `Option<u16>` | The port, if set |

### AuthMethod

```rust
let auth = AuthMethod::UsernamePassword {
    username: "user".into(),
    password: "pass".into(),
};
```

### SourceBinding

Maps a model table to a physical source location (runtime registry):

```rust
let binding = SourceBinding::new("schema_name", "table_name");
```

### Persisted source types (model format ≥ 14)

Secret-free descriptors serialized into the model for composite models (see [Persisted Multi-Source Models](#persisted-multi-source-composite-models)):

| Type | Purpose |
|------|---------|
| `PersistedSource { id, kind, connection, preferred_auth, display_name? }` | One entry in `DataModel.sources`. `connection` is a `PersistedConnection` (secret-free `ConnectionTarget` mirror); `preferred_auth` is a `PersistedAuthKind` hint. |
| `TableSourceBinding { source_id, schema, table }` | `Table.source_binding` — which catalog source a table maps to, and where. |
| `SourceKind` | `Postgres` \| `SqlServer` \| `InMemory` \| `Csv` \| `Parquet`. |
| `SourceCredential` | Passed back from a `wire_sources` resolver: `Auth(AuthMethod)` \| `Connector(AnyConnector)` \| `Skip`. |
| `WireReport { wired, skipped, bound_tables, unbound_tables }` | Result of `wire_sources`; `unbound_tables` = "reconnect required". |

### SemiJoinConfig

Opt-in cross-source reverse pushdown tuning (default: disabled). Set via `Engine::set_semi_join_config`.

```rust
SemiJoinConfig { reverse_pushdown: false, key_set_abort_max: 100_000 } // defaults
```

---

## Error Types

| Error Type | Crate | Description |
|------------|-------|-------------|
| `EngineError` | engine-core | Model and computation errors |
| `ConnectorError` | engine-connectors | Data source errors |
| `QueryError` | engine-query | Query planning and execution errors |

Common `EngineError` variants: `TableNotFound`, `ColumnNotFound`, `MeasureNotFound`, `ContextNotFound`, `TableVariableNotFound`, `InvalidLookup`, `InvalidContext`, `InvalidTableVariable`, `InvalidData`, `TypeMismatch`, `ValidationError`.

---

## Columnar Storage

For in-memory computation without external sources:

```rust
use engine::*;
use arrow::record_batch::RecordBatch;

let store = ColumnStore::new();
// Insert Arrow RecordBatches into tables
// Use MeasureEngine for local measure evaluation
```

### MeasureEngine

Evaluates measures against in-memory `ColumnStore` data:

```rust
let result = MeasureEngine::evaluate(&measure, &store, &model)?;
let grouped = MeasureEngine::evaluate_grouped(
    &measure, &store, &model, &["region"],
)?;
```

Context-aware evaluation (with outer filters from query context):

```rust
let result = MeasureEngine::evaluate_with_outer_filters(
    &measure, &store, &model, &outer_filters,
)?;
```

---

## Execution Plan

The `query_explained()` method returns an `ExecutionPlan` alongside query results. The plan is a serializable tree describing every phase of execution with timing and decision metadata.

### ExecutionPlan

| Field | Type | Description |
|-------|------|-------------|
| `summary` | `String` | Human-readable query description |
| `total_duration` | `PlanDuration` | Total wall-clock time |
| `root` | `PlanNode` | Root of the plan tree |

### PlanNode

| Field | Type | Description |
|-------|------|-------------|
| `operation` | `PlanOperation` | Type of operation |
| `label` | `String` | Human-readable label |
| `duration` | `PlanDuration` | Wall-clock duration |
| `properties` | `Vec<PlanProperty>` | Key-value metadata |
| `children` | `Vec<PlanNode>` | Sub-phases |

### PlanOperation

| Variant | Description |
|---------|-------------|
| `Planning` | Top-level query execution phase |
| `PushdownDecision` | Pushdown analysis and decision |
| `ContextResolution` | Context resolution for a measure |
| `SourceFetch` | Fetching data from a remote source |
| `LocalJoin` | Local join of tables |
| `LocalAggregation` | Local aggregation via DataFusion |
| `PushedAggregation` | Aggregation pushed to remote source |
| `MeasureEvaluation` | Measure evaluation |
| `CalculatedColumnMaterialization` | Materializing calculated columns |
| `DataFusionExecution` | DataFusion SQL execution |

### PlanProperty

Key-value metadata attached to plan nodes:

```rust
let prop = PlanProperty::text("sql", "SELECT SUM(amount) FROM sales");
let prop = PlanProperty::number("rows_fetched", 31465.0);
let prop = PlanProperty::bool("all_simple", true);
let prop = PlanProperty::list("tables", vec!["Sales".into(), "Products".into()]);
```

### PlanValue

| Variant | Description |
|---------|-------------|
| `Text(String)` | A text value |
| `Number(f64)` | A numeric value |
| `Bool(bool)` | A boolean value |
| `List(Vec<String>)` | A list of text values |

### PlanDuration

Duration in fractional milliseconds. Implements `From<std::time::Duration>`.

```rust
let d = PlanDuration::from_ms(42.5);
let d: PlanDuration = std::time::Duration::from_millis(42).into();
```

### Common Properties by Operation

**PushdownDecision:**
- `decision` — "PushedAggregation" or "LocalAggregation"
- `reason` — Why this decision was made
- `tables_involved` — List of table names
- `all_simple` — Whether all measures are simple aggregates
- `has_context_ops` — Whether any measure has context operations
- `lookups` — Columns to look up post-aggregation (e.g., "Products.category_name (key: Products.category_id)")

**SourceFetch:**
- `table` — Table name
- `rows_fetched` — Number of rows returned

**LocalJoin:**
- `joins` — List of join descriptions (e.g., "Sales.product_id = Products.id")

**DataFusionExecution:**
- `sql` — The SQL query executed by DataFusion
- `group_by` — Group-by columns
- `result_rows` — Number of result rows

**PushedAggregation:**
- `table` — Model table name
- `source_schema`, `source_table` — Physical source location
- `aggregates_count` — Number of aggregates pushed
- `rows_returned` — Number of result rows
