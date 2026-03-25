# QUERY

Materializes an intermediate grouped table inside a VAR binding, enabling two-stage aggregation ("aggregate of aggregates").

## Syntax

```
VAR alias = QUERY(
  AGG(table[column]) AS result_name [, AGG(table[column]) AS result_name2, ...]
  BY table[column], table[column], ...
)
RETURN AGG(alias[result_name])
```

## Description

QUERY produces an intermediate table with:
- One row per unique combination of the BY columns
- One column per aliased aggregate expression
- The BY columns themselves as additional columns

The RETURN expression then aggregates over this intermediate table using standard aggregation functions. This enables patterns like average monthly revenue, peak quarter, or count of active months.

## Parameters

| Parameter | Description |
|-----------|-------------|
| Aggregate expressions | One or more `AGG(table[column]) AS alias` — the aggregates to compute per group |
| BY columns | `table[column], ...` — the columns to group by |

## Examples

### Average Monthly Revenue

```
VAR monthly = QUERY(
  SUM(fact_sales[linetotal]) AS revenue
  BY dim_date[year], dim_date[month]
)
RETURN AVG(monthly[revenue])
```

### Peak Month Revenue

```
VAR monthly = QUERY(
  SUM(fact_sales[linetotal]) AS revenue
  BY dim_date[year], dim_date[month]
)
RETURN MAX(monthly[revenue])
```

### Number of Active Months

```
VAR monthly = QUERY(
  SUM(fact_sales[linetotal]) AS revenue
  BY dim_date[year], dim_date[month]
)
RETURN COUNTROWS(monthly)
```

### Peak-to-Trough Ratio

```
VAR monthly = QUERY(
  SUM(fact_sales[linetotal]) AS revenue
  BY dim_date[year], dim_date[month]
)
RETURN DIVIDE(MAX(monthly[revenue]), MIN(monthly[revenue]))
```

### Rounded Average Quarterly Revenue

```
VAR quarterly = QUERY(
  SUM(fact_sales[linetotal]) AS revenue
  BY dim_date[year], dim_date[quarter]
)
RETURN ROUND(AVG(quarterly[revenue]), 0)
```

## With Named Context (Filtered Source)

A named context on the inner aggregate filters the source data BEFORE the QUERY groups it.

```
-- Average monthly bikes revenue
VAR monthly = QUERY(
  SUM(fact_sales[linetotal], ctx_bikes) AS revenue
  BY dim_date[year], dim_date[month]
)
RETURN AVG(monthly[revenue])
```

## With KEEP on Intermediate Table

KEEP can filter the intermediate table produced by QUERY:

```
-- Average Q1 monthly revenue
VAR monthly = QUERY(
  SUM(fact_sales[linetotal]) AS revenue
  BY dim_date[year], dim_date[month], dim_date[quarter]
)
RETURN AVG(monthly[revenue], KEEP(monthly, monthly[quarter] = 1))
```

## Cross-Dimension Context Propagation

When the outer query groups by a dimension NOT in the QUERY's BY clause, the engine injects that dimension into the QUERY's materialization. This produces correct per-group values from a single materialization.

```
-- Define measure (no category in BY):
VAR monthly = QUERY(
  SUM(fact_sales[linetotal]) AS revenue
  BY dim_date[year], dim_date[month]
)
RETURN AVG(monthly[revenue])

-- When queried with GROUP BY dim_product[categoryname]:
-- Engine injects categoryname into the QUERY, producing
-- per-category monthly totals, then AVG per category.
```

## Notes

- QUERY can only appear inside a VAR binding, not standalone
- Multiple aggregates can be computed in a single QUERY using comma-separated `AGG(...) AS alias` expressions
- The intermediate table exists only during measure evaluation; it is not persisted
- Context operations on the inner aggregate (e.g., `SUM(t[col], ctx_bikes)`) filter source data before grouping
- KEEP on the RETURN aggregate (e.g., `AVG(m[rev], KEEP(m, m[quarter] = 1))`) filters the intermediate table after grouping
- Mixing QUERY-derived and fact-table aggregates in the same RETURN expression is not supported; use separate measures instead
