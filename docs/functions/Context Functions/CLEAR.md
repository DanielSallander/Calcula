# CLEAR

Removes filters on a specific table or column from the evaluation context. This allows a measure to ignore certain filters that would otherwise be applied by the query.

## Syntax

Clear all filters on a table:

```
SUM(table[column], CLEAR(dimension_table))
```

Clear filters on a specific column:

```
SUM(table[column], CLEAR(dimension_table[column]))
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `dimension_table` | The name of the table whose filters should be removed. All filters on this table are cleared. |
| `dimension_table[column]` | A specific column whose filters should be removed. Only filters on this column are cleared; other filters on the same table remain. |

## Return value

The result of the aggregation function, computed with the specified filters removed from the evaluation context.

## Remarks

- CLEAR is always used as the **second argument** to an aggregation function (SUM, COUNT, AVG, MIN, MAX, DISTINCTCOUNT). It cannot be used standalone.
- CLEAR removes filters from **both** filter sources (query-level filters and group-by filters). To clear only one source, use [CLEAR_INNER](CLEAR_INNER.md) or [CLEAR_OUTER](CLEAR_OUTER.md).
- CLEAR is commonly used to compute totals or percentages. For example, clearing the category filter while grouped by category gives you the grand total in each row, which you can divide by the row value to get a percentage.
- To remove **all** filters (not just specific ones), use [RESET](RESET.md) instead.
- CLEAR followed by [KEEP](KEEP.md) is a common pattern to **replace** a filter rather than narrowing it.
- A measure using CLEAR is always computed locally (not pushed down to the data source).

## Example 1: Clear all filters on a table

Calculate total revenue across all time periods, ignoring any date filters.

```
DEFINE Revenue All Time = SUM(fact_sales[linetotal], CLEAR(dim_date))
```

When used in a query grouped by year, this measure returns the same grand total in every row:

```
DEFINE Revenue = SUM(fact_sales[linetotal])
DEFINE Revenue All Time = SUM(fact_sales[linetotal], CLEAR(dim_date))
QUERY: Revenue, Revenue All Time BY dim_date[year]
```

| year | Revenue | Revenue All Time |
|------|---------|-----------------|
| 2011 | $12,641,672.21 | $109,846,381.40 |
| 2012 | $30,674,756.65 | $109,846,381.40 |
| 2013 | $43,421,059.13 | $109,846,381.40 |
| 2014 | $23,108,893.41 | $109,846,381.40 |

## Example 2: Clear a specific column

Clear only the year filter, but keep other date filters (like quarter or month) if any:

```
DEFINE Revenue All Years = SUM(fact_sales[linetotal], CLEAR(dim_date[year]))
```

## Example 3: Percentage of total

Calculate each category's share of total revenue using CLEAR.

```
DEFINE Revenue = SUM(fact_sales[linetotal])
DEFINE Total Revenue = SUM(fact_sales[linetotal], CLEAR(dim_product))
QUERY: Revenue, Total Revenue BY dim_product[categoryname]
```

In a host application (Calcula Studio), you would create a third measure:

```
DEFINE Pct of Total = SUM(fact_sales[linetotal]) / SUM(fact_sales[linetotal], CLEAR(dim_product))
```

This divides each category's revenue by the total revenue (with the category filter cleared).

## See also

- [CLEAR_INNER](CLEAR_INNER.md) — remove only group-by filters
- [CLEAR_OUTER](CLEAR_OUTER.md) — remove only query-level filters
- [RESET](RESET.md) — remove all filters
- [KEEP](KEEP.md) — add filters to the evaluation context
