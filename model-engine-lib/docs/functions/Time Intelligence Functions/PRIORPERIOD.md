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
| interval | `YEAR`, `QUARTER`, `MONTH`, `WEEK`, or `DAY` (bare or quoted, case-insensitive; `WEEK`/`DAY` are filter-context only) |

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

## Gap-tolerant (value-based) contexts

From the **filter context**, a contiguous date context shifts as a whole window
(the algebraic range). A context with an internal hole — e.g. a slicer keeping
Jan and Mar but not Feb — previously failed closed; it now routes to the
**value-based** shift: every distinct context date is shifted individually
(DAX `DATEADD` semantics, including the end-of-month snap: a month-end date
maps to the target month's end so a full month maps to a full month), and the
lowered filter keeps exactly the shifted set. More than 20 000 distinct
context dates fails closed. The axis (positional) path keeps its own
contiguity guard.
