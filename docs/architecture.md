# Calcula Engine Lib — Foundation Document

## Overview

The Engine Lib is a shared Rust crate that provides the core analytical processing capabilities for the Calcula BI ecosystem. It is consumed as a library by both **Calcula Studio** (data model design) and **Calcula** (report consumption and rendering). This is the foundational project — both other projects depend on it.

**Design philosophy:** The engine is a **library**, not a server. Like SQLite, it can be embedded into any application that needs analytical processing. This enables local-first computation where data is pulled to the client and processed on the user's machine.

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

### 7. Data Source Connectors

The engine provides a connector abstraction for different data sources:

- **SQL Server** — via TDS protocol
- **PostgreSQL** — via native Rust PostgreSQL drivers
- **Additional sources** — extensible connector interface for future sources (MySQL, REST APIs, CSV/Parquet files, etc.)

Each connector is responsible for:
- Connection management (pooling, authentication)
- Query dialect translation (the planner generates abstract queries; the connector translates to source-specific SQL)
- Result set deserialization into columnar format

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

**Current status:** Milestones 1–12 are complete. The engine supports columnar storage, star-schema relationships, PostgreSQL and SQL Server connectors, query pushdown, measure computation with context manipulation, table variables, execution plan visualization, text-based measure definition via a DAX-like parser, DAX-inspired functions (IF, SWITCH, DIVIDE, ROUND, math functions, etc.), named context definitions (CONTEXT), scalar variables (VAR/RETURN), two-stage aggregation via QUERY-in-VAR, and per-query lookup columns for optimized dimension property retrieval.
