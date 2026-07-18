# YTD

Year-to-date running total of a measure, resetting at each year boundary.

## Syntax

```
YTD(<measure>)
```

## Parameters

| Parameter | Description |
|-----------|-------------|
| `measure` | A single aggregate: `SUM`, `COUNT`, `COUNTROWS`, `MIN`, or `MAX` |

## Requirements

YTD uses **query-axis semantics** (v1):

- The model must mark a date table (`DataModelBuilder::mark_date_table`) whose
  columns carry date roles (`Column::with_date_role`).
- The query's group_by must include the date table's **Year**-role column plus
  at least one finer date-role column (Quarter, Month, Week, Day, or DateKey).
- Missing prerequisites produce a typed, actionable error — never silently
  wrong numbers.

## Examples

```
YTD(SUM(fact_sales[amount]))
```

With group_by `dim_date[year], dim_date[month]`: each row holds the running
total of months 1..m within its year. January restarts the accumulation.

## Execution

Lowered to a running SQL window aggregate: `PARTITION BY` the Year column
(plus all non-date group_by dimensions), `ORDER BY` the finer date columns,
frame `UNBOUNDED PRECEDING .. CURRENT ROW`. Always executes locally (never
pushed to data sources).

## Notes

- `AVERAGE` / `DISTINCTCOUNT` and statistical aggregates are rejected in v1:
  they do not compose from per-period values.
- Cannot be combined with totals (ROLLUP) or hierarchy group-by in v1.
