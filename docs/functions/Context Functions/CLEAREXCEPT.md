# CLEAREXCEPT

Clears all filters on a table except the specified columns. Used as a context operation argument to aggregation functions. This is the Calcula equivalent of DAX's ALLEXCEPT.

## Syntax

```
CLEAREXCEPT(table, table[column1], table[column2], ...)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `table` | The table whose filters should be cleared. |
| `table[column1]` | A column to preserve. Filters on this column remain active while all other filters on the table are removed. |
| `table[column2], ...` | Optional. Additional columns to preserve. |

## Return value

Used as a context modifier — does not return a value on its own. The enclosing aggregation function returns its result computed in the modified context.

## Remarks

- CLEAREXCEPT removes all filters from the specified table except those on the listed columns. This is the inverse of [CLEAR](CLEAR.md), which removes filters on specific columns.
- Particularly useful for percentage-of-parent calculations where you want to clear detail-level filters but keep a higher-level grouping filter.
- CLEAREXCEPT is equivalent to using [CLEAR](CLEAR.md) on every column of the table except the ones listed, but more concise and maintainable.
- Multiple columns can be preserved. Filters on unlisted columns are removed.
- CLEAREXCEPT forces local computation (measures using it cannot be pushed down).

## Example 1: Percentage of category

Calculate each product's share of its category total.

```
DEFINE Pct of Category = DIVIDE(SUM(fact_sales[linetotal]), SUM(fact_sales[linetotal], CLEAREXCEPT(dim_product, dim_product[categoryname])))
```

When grouped by product, the numerator shows product-level revenue. The denominator clears all product filters except category, giving the category total.

## Example 2: Preserve multiple columns

Keep both category and year filters, clear everything else.

```
DEFINE Scoped Total = SUM(fact_sales[linetotal], CLEAREXCEPT(dim_product, dim_product[categoryname]), CLEAREXCEPT(dim_date, dim_date[year]))
```

## See also

- [CLEAR](CLEAR.md) — clear filters on specific columns
- [RESET](RESET.md) — remove all filters from the evaluation context
- [KEEP](KEEP.md) — add filters to the evaluation context
