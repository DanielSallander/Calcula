# RESET

Removes all filters from the evaluation context. The measure is computed against the full, unfiltered dataset.

## Syntax

```
SUM(table[column], RESET())
```

### Parameters

RESET takes no parameters.

## Return value

The result of the aggregation function, computed over the entire dataset with no filters applied.

## Remarks

- RESET is always used as the **second argument** to an aggregation function (SUM, COUNT, AVG, MIN, MAX, DISTINCTCOUNT). It cannot be used standalone.
- RESET removes **all** filters — both query-level filters and group-by filters. The measure sees every row in the table.
- RESET is equivalent to calling [CLEAR](CLEAR.md) on every table in the model.
- To remove filters from only one source (query-level or group-by), use [RESET_INNER](RESET_INNER.md) or [RESET_OUTER](RESET_OUTER.md) instead.
- To remove filters on only specific tables or columns, use [CLEAR](CLEAR.md) instead.
- RESET is commonly used to compute grand totals or denominators for percentage calculations.
- A measure using RESET is always computed locally (not pushed down to the data source).

## Example 1: Grand total

Calculate the grand total revenue, ignoring all filters.

```
DEFINE Grand Total = SUM(fact_sales[linetotal], RESET())
```

No matter what filters or groupings the query applies, this measure always returns the same value — the total across the entire dataset.

## Example 2: Percentage of grand total

Compare each row's revenue to the grand total.

```
DEFINE Revenue = SUM(fact_sales[linetotal])
DEFINE Grand Total = SUM(fact_sales[linetotal], RESET())
QUERY: Revenue, Grand Total BY dim_product[categoryname]
```

| categoryname | Revenue | Grand Total |
|-------------|---------|-------------|
| Bikes | $94,620,526.47 | $109,846,381.40 |
| Components | $11,799,076.67 | $109,846,381.40 |
| Clothing | $2,120,542.60 | $109,846,381.40 |
| Accessories | $1,306,235.66 | $109,846,381.40 |

In a host application, you would create a percentage measure:

```
DEFINE Pct of Grand Total = SUM(fact_sales[linetotal]) / SUM(fact_sales[linetotal], RESET())
```

## Example 3: Grand total with grouping by date

Even when grouped by year, RESET returns the same total across all years.

```
DEFINE Revenue = SUM(fact_sales[linetotal])
DEFINE Grand Total = SUM(fact_sales[linetotal], RESET())
QUERY: Revenue, Grand Total BY dim_date[year]
```

| year | Revenue | Grand Total |
|------|---------|-------------|
| 2011 | $12,641,672.21 | $109,846,381.40 |
| 2012 | $30,674,756.65 | $109,846,381.40 |
| 2013 | $43,421,059.13 | $109,846,381.40 |
| 2014 | $23,108,893.41 | $109,846,381.40 |

## See also

- [CLEAR](CLEAR.md) — remove specific filters
- [RESET_INNER](RESET_INNER.md) — remove only group-by filters
- [RESET_OUTER](RESET_OUTER.md) — remove only query-level filters
- [KEEP](KEEP.md) — add filters to the evaluation context
