# RESET_OUTER

Removes all query-level (outer) filters from the evaluation context, while keeping group-by (inner) filters intact.

## Syntax

```
SUM(table[column], RESET_OUTER())
```

### Parameters

RESET_OUTER takes no parameters.

## Return value

The result of the aggregation function, computed with all query-level filters removed but group-by filters preserved.

## Remarks

- RESET_OUTER is always used as the **second argument** to an aggregation function. It cannot be used standalone.
- The function name is case-insensitive. Both `RESET_OUTER` and `RESETOUTER` are accepted.
- Filters have two sources:
  - **Inner (group-by):** Filters from the matrix row/column context — the current grouping level.
  - **Outer (query-level):** Slicer/page filters from the query's `filters` parameter.
- RESET_OUTER removes **all** outer filters. Use [CLEAR_OUTER](CLEAR_OUTER.md) to remove only specific table/column filters.
- Use [RESET](RESET.md) to remove all filters from both sources.
- This is useful when you want a measure that ignores all slicers but still breaks down correctly by the current grouping.

## Example

Show revenue per category, ignoring all slicer filters.

```
DEFINE Revenue = SUM(fact_sales[linetotal])
DEFINE Revenue No Slicers = SUM(fact_sales[linetotal], RESET_OUTER())
QUERY: Revenue, Revenue No Slicers BY dim_product[categoryname]
```

When a year slicer is active, `Revenue` reflects only that year, while `Revenue No Slicers` shows the category's total across all years — but still correctly split by category.

## See also

- [RESET](RESET.md) — remove all filters from both sources
- [RESET_INNER](RESET_INNER.md) — remove only group-by filters
- [CLEAR_OUTER](CLEAR_OUTER.md) — remove specific query-level filters
