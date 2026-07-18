# MTD

Month-to-date running total of a measure, resetting at each month boundary.

## Syntax

```
MTD(<measure>)
```

## Parameters

| Parameter | Description |
|-----------|-------------|
| `measure` | A single aggregate: `SUM`, `COUNT`, `COUNTROWS`, `MIN`, or `MAX` |

## Requirements

Query-axis semantics (v1): the model must mark a date table with date roles,
and the query's group_by must include the date table's **Year** and
**Month** role columns plus at least one finer date-role column (Week, Day,
or DateKey).

## Examples

```
MTD(SUM(fact_sales[amount]))
```

With group_by `dim_date[year], dim_date[month], dim_date[day]`: each row
holds the running total of days 1..d within its month.

## Execution

Lowered to a running SQL window aggregate partitioned by Year + Month,
ordered by the finer date columns. Always executes locally.

## Notes

- See `YTD` for the shared v1 restrictions (supported aggregates, no
  totals/hierarchies).
