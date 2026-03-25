# HASONEVALUE

Tests whether a column has exactly one distinct value in the current filter context. Returns true if there is exactly one value, false otherwise.

## Syntax

```
HASONEVALUE(table[column])
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `table[column]` | The column to check for a single distinct value. |

## Return value

A boolean — true if the column has exactly one distinct value in the current context, false otherwise.

## Remarks

- HASONEVALUE generates SQL `COUNT(DISTINCT column) = 1` internally.
- HASONEVALUE is typically used as the condition in an [IF](IF.md) expression to branch logic based on whether the user has filtered down to a single value.
- In a grouped query, each group's filter context determines whether a column has one value. For example, if you group by `Calendar[year]`, then `HASONEVALUE(Calendar[year])` is true for each row (each row has exactly one year).
- HASONEVALUE always forces local computation when used in a measure expression.
- For retrieving the actual single value, use [SELECTEDVALUE](SELECTEDVALUE.md) instead of combining HASONEVALUE with [MIN](MIN.md).

## Example 1: Conditional label

Show the year when filtered to a single year, otherwise show "All Years".

```
DEFINE YearLabel = IF(HASONEVALUE(dim_date[year]), SELECTEDVALUE(dim_date[year]), "All Years")
```

## Example 2: Conditional calculation

Apply a different formula depending on whether a single category is selected.

```
DEFINE Revenue = SUM(fact_sales[linetotal])
DEFINE Metric = IF(HASONEVALUE(dim_product[categoryname]), DIVIDE(Revenue, COUNTROWS(fact_sales)), Revenue)
```

When a single category is selected, shows revenue per row. Otherwise, shows total revenue.

## See also

- [SELECTEDVALUE](SELECTEDVALUE.md) — returns the single value or an alternate
- [IF](IF.md) — conditional branching
- [DISTINCTCOUNT](DISTINCTCOUNT.md) — counts distinct values
