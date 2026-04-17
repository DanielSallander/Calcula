# OFFSET

Returns a measure's value at a relative position from the current row, enabling period-over-period comparisons.

## Syntax

```
OFFSET(
  <inner_measure>,
  <delta>,
  ORDERBY(table[column] [, table[column], ...]),
  [PARTITIONBY(table[column] [, table[column], ...])]
)
```

## Parameters

| Parameter | Description |
|-----------|-------------|
| `inner_measure` | Any measure expression (e.g., `SUM(fact[amount])`) |
| `delta` | Integer offset from current row. Negative = before, positive = after |
| `ORDERBY(...)` | Columns defining row ordering |
| `PARTITIONBY(...)` | Optional. Columns defining independent groups |

## Examples

### Previous Month Sales

```
OFFSET(SUM(fact_sales[linetotal]), -1, ORDERBY(dim_date[month]))
```

Returns last month's total sales.

### Year-Over-Year Comparison

```
OFFSET(SUM(fact_sales[linetotal]), -1, ORDERBY(dim_date[year]))
```

Returns the previous year's total sales.

### Next Month Sales

```
OFFSET(SUM(fact_sales[linetotal]), 1, ORDERBY(dim_date[month]))
```

Returns next month's total sales.

### Previous Month Within Each Year

```
OFFSET(
  SUM(fact_sales[linetotal]),
  -1,
  ORDERBY(dim_date[month]),
  PARTITIONBY(dim_date[year])
)
```

Returns the previous month's sales, resetting at year boundaries (January returns NULL).

### Month-Over-Month Growth

```
SUM(fact_sales[linetotal]) - OFFSET(SUM(fact_sales[linetotal]), -1, ORDERBY(dim_date[month]))
```

Difference between current and previous month.

## Execution

OFFSET uses two-stage evaluation:

1. **Stage 1**: The inner measure is materialized grouped by ORDER BY + PARTITION BY columns.
2. **Stage 2**: SQL `LAG` (negative delta) or `LEAD` (positive delta) is applied over the result.

## Notes

- Returns NULL when the offset position is out of bounds (e.g., no previous row for the first row)
- OFFSET always uses local aggregation (never pushed to data sources)
- A delta of 0 returns the current row's value (equivalent to the inner measure itself)
