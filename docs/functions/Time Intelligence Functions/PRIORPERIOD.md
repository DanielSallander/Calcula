# PRIORPERIOD

Value of a measure shifted by n periods (year, quarter, or month) along the query's date axis.

## Syntax

```
PRIORPERIOD(<measure>, <n>, YEAR | QUARTER | MONTH)
```

## Parameters

| Parameter | Description |
|-----------|-------------|
| `measure` | Any measure expression (the computed value is shifted) |
| `n` | Integer shift: negative = earlier periods, positive = later |
| interval | `YEAR`, `QUARTER`, or `MONTH` (bare or quoted, case-insensitive) |

## Requirements

Query-axis semantics (v1): the model must mark a date table with date roles.
The query's group_by must include the date table's anchor columns for the
granularity — Year for `YEAR`; Year + Quarter for `QUARTER`; Year + Month for
`MONTH`. For `QUARTER`/`MONTH` shifts, **no finer date columns** may be on
the axis (a shifted quarter does not contain the same months); `YEAR` shifts
allow finer columns, which partition the comparison.

## Examples

```
PRIORPERIOD(SUM(fact_sales[amount]), -1, QUARTER)
```

With group_by `dim_date[year], dim_date[quarter]`: each row shows the prior
quarter's total; (2024, Q1) reads (2023, Q4) across the year boundary.

## Execution

Lowered to SQL `LAG`/`LEAD` over the materialized measure, ordered by the
anchor date columns. Always executes locally.

## Notes

- **Positional shift contract (v1):** the offset moves along the sorted
  distinct axis values *present in the result*; periods missing from the
  data shift to the nearest present period rather than producing blank.
- Cannot be combined with totals (ROLLUP) or hierarchy group-by in v1.
