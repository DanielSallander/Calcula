# WINDOW

Aggregates a measure over a sliding window of rows, enabling running totals, moving averages, and cumulative calculations.

## Syntax

```
WINDOW(
  <inner_measure>,
  <window_aggregate>,
  ORDERBY(table[column] [, table[column], ...]),
  [PARTITIONBY(table[column] [, table[column], ...]),]
  [ROWS(from, from_type, to, to_type)]
)
```

## Parameters

| Parameter | Description |
|-----------|-------------|
| `inner_measure` | Any measure expression (e.g., `SUM(fact[amount])`) — evaluated per row before windowing |
| `window_aggregate` | How to aggregate within the frame: `SUM`, `AVG`, `MIN`, `MAX`, `COUNT` |
| `ORDERBY(...)` | Columns defining row ordering within each partition |
| `PARTITIONBY(...)` | Optional. Columns defining independent groups (window resets per partition) |
| `ROWS(...)` | Optional. Window frame boundaries using DAX-inspired conventions (default: running total) |

### ROWS Frame Boundaries

Each boundary has a value and a type:

- **`REL`** (relative): offset from current row. `0` = current row, negative = before, positive = after.
- **`ABS`** (absolute): position from start (positive, 1-based) or end (negative, -1 = last).

| ROWS Specification | SQL Equivalent | Meaning |
|-------------------|---------------|---------|
| `ROWS(1, ABS, 0, REL)` | `UNBOUNDED PRECEDING TO CURRENT ROW` | Running total (default) |
| `ROWS(-2, REL, 0, REL)` | `2 PRECEDING TO CURRENT ROW` | 3-row moving window |
| `ROWS(0, REL, 2, REL)` | `CURRENT ROW TO 2 FOLLOWING` | Forward-looking window |
| `ROWS(1, ABS, -1, ABS)` | `UNBOUNDED PRECEDING TO UNBOUNDED FOLLOWING` | Entire partition |

When `ROWS` is omitted, the default is `ROWS(1, ABS, 0, REL)` — unbounded preceding to current row (running total).

## Examples

### Running Total

```
WINDOW(SUM(fact_sales[linetotal]), SUM, ORDERBY(dim_date[datekey]))
```

Cumulative sum of sales ordered by date. Each row's value is the sum of all preceding rows plus itself.

### 3-Month Moving Average

```
WINDOW(
  SUM(fact_sales[linetotal]),
  AVG,
  ORDERBY(dim_date[month]),
  ROWS(-2, REL, 0, REL)
)
```

Average of the current month and the two preceding months.

### Year-to-Date Within Each Year

```
WINDOW(
  SUM(fact_sales[linetotal]),
  SUM,
  ORDERBY(dim_date[month]),
  PARTITIONBY(dim_date[year])
)
```

Running total that resets at the start of each year.

### With Context Filter on Inner Measure

```
WINDOW(
  SUM(fact_sales[linetotal], ctx_bikes),
  SUM,
  ORDERBY(dim_date[datekey])
)
```

Running total of bikes-only sales.

## Execution

WINDOW uses two-stage evaluation:

1. **Stage 1**: The inner measure is materialized grouped by ORDER BY + PARTITION BY columns (plus any outer GROUP BY columns for context propagation).
2. **Stage 2**: The window aggregate is applied over the materialized result using SQL window functions.

## Notes

- WINDOW measures always use local aggregation (never pushed to data sources)
- The inner measure can be any valid measure expression, including those with context operations
- When the outer query groups by dimensions not in ORDER BY or PARTITION BY, those dimensions are automatically injected into PARTITION BY to produce correct per-group values
- WINDOW cannot be pushed down to data sources — it always executes locally via DataFusion
