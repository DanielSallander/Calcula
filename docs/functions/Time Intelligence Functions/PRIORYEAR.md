# PRIORYEAR

Value of a measure one year earlier on the query's date axis (sugar for `PRIORPERIOD(measure, -1, YEAR)`).

## Syntax

```
PRIORYEAR(<measure>)
```

## Parameters

| Parameter | Description |
|-----------|-------------|
| `measure` | Any measure expression (arithmetic over aggregates is allowed — the computed value is shifted) |

## Requirements

Query-axis semantics (v1): the model must mark a date table with date roles,
and the query's group_by must include the date table's **Year**-role column.
Finer date columns (e.g. Month) may be on the axis — the shift preserves
them, giving the classic same-month-prior-year comparison.

## Examples

```
PRIORYEAR(SUM(fact_sales[amount]))
```

With group_by `dim_date[year], dim_date[month]`: the row (2024, May) shows
the value of (2023, May); rows of the first year on the axis are blank.

## Execution

Lowered to SQL `LAG` over the materialized measure, ordered by the Year
column and partitioned by all other group_by dimensions. Always executes
locally.

## Notes

- **Positional shift contract (v1):** the offset moves along the sorted
  distinct axis values *present in the result*. If a year is entirely
  missing from the data, the shift reads the nearest earlier year present
  instead of returning blank.
- Cannot be combined with totals (ROLLUP) or hierarchy group-by in v1.
