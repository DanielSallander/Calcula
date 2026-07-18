# INDEX

Returns a measure's value at an absolute position within a partition, enabling first/last value lookups.

## Syntax

```
INDEX(
  <inner_measure>,
  <position>,
  ORDERBY(table[column] [, table[column], ...]),
  [PARTITIONBY(table[column] [, table[column], ...])]
)
```

## Parameters

| Parameter | Description |
|-----------|-------------|
| `inner_measure` | Any measure expression (e.g., `SUM(fact[amount])`) |
| `position` | Absolute position. Positive = from start (1-based), negative = from end (-1 = last) |
| `ORDERBY(...)` | Columns defining row ordering |
| `PARTITIONBY(...)` | Optional. Columns defining independent groups |

## Examples

### First Month's Sales

```
INDEX(SUM(fact_sales[linetotal]), 1, ORDERBY(dim_date[month]))
```

Returns the total sales for the first month.

### Last Month's Sales

```
INDEX(SUM(fact_sales[linetotal]), -1, ORDERBY(dim_date[month]))
```

Returns the total sales for the last month.

### First Month Within Each Year

```
INDEX(
  SUM(fact_sales[linetotal]),
  1,
  ORDERBY(dim_date[month]),
  PARTITIONBY(dim_date[year])
)
```

Returns January's sales for each year.

### Percentage of First Month

```
DIVIDE(
  SUM(fact_sales[linetotal]),
  INDEX(SUM(fact_sales[linetotal]), 1, ORDERBY(dim_date[month]))
)
```

Each month's sales as a ratio of the first month.

## Execution

INDEX uses two-stage evaluation:

1. **Stage 1**: The inner measure is materialized grouped by ORDER BY + PARTITION BY columns.
2. **Stage 2**: SQL `NTH_VALUE` is applied with a full window frame to retrieve the value at the specified position.

## Notes

- Returns NULL when the position is out of bounds
- Position is 1-based: `1` = first row, `2` = second row, `-1` = last row, `-2` = second-to-last
- INDEX always uses local aggregation (never pushed to data sources)
- For negative positions, the ORDER BY direction is reversed internally
