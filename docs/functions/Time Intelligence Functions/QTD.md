# QTD

Quarter-to-date running total of a measure, resetting at each quarter boundary.

## Syntax

```
QTD(<measure>)
```

## Parameters

| Parameter | Description |
|-----------|-------------|
| `measure` | A single aggregate: `SUM`, `COUNT`, `COUNTROWS`, `MIN`, or `MAX` |

## Requirements

Query-axis semantics (v1): the model must mark a date table with date roles,
and the query's group_by must include the date table's **Year** and
**Quarter** role columns plus at least one finer date-role column (Month,
Week, Day, or DateKey).

## Examples

```
QTD(SUM(fact_sales[amount]))
```

With group_by `dim_date[year], dim_date[quarter], dim_date[month]`: each row
holds the running total of the months within its quarter. April restarts the
accumulation (Q2 begins).

## Execution

Lowered to a running SQL window aggregate partitioned by Year + Quarter,
ordered by the finer date columns. Always executes locally.

## Notes

- See `YTD` for the shared v1 restrictions (supported aggregates, no
  totals/hierarchies).
