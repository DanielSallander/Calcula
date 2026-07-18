# CLEAR_INNER

Removes group-by (inner) filters on a specific table or column from the evaluation context, while keeping query-level (outer) filters intact.

## Syntax

Clear inner filters on a table:

```
SUM(table[column], CLEAR_INNER(dimension_table))
```

Clear inner filters on a specific column:

```
SUM(table[column], CLEAR_INNER(dimension_table[column]))
```

The function name is case-insensitive. Both `CLEAR_INNER` and `CLEARINNER` are accepted.

### Parameters

| Parameter | Definition |
|-----------|------------|
| `dimension_table` | The name of the table whose group-by filters should be removed. |
| `dimension_table[column]` | A specific column whose group-by filters should be removed. |

## Return value

The result of the aggregation function, computed with the specified group-by filters removed but query-level filters preserved.

## Remarks

- CLEAR_INNER is always used as the **second argument** to an aggregation function. It cannot be used standalone.
- Filters have two sources:
  - **Inner (group-by):** Filters from the matrix row/column context — the current grouping level.
  - **Outer (query-level):** Slicer/page filters from the query's `filters` parameter.
- CLEAR_INNER only removes inner (group-by) filters. Outer (query-level) filters remain active.
- Use [CLEAR](CLEAR.md) to remove filters from both sources, or [CLEAR_OUTER](CLEAR_OUTER.md) to remove only query-level filters.
- This is useful when you want a measure to show a total across all group-by values, but still respect any slicers the user has applied.

## Example

Show the total across all categories (ignoring the group-by) while still respecting any query-level filters.

```
DEFINE Category Total = SUM(fact_sales[linetotal], CLEAR_INNER(dim_product))
```

When grouped by category with a query-level year filter, this measure ignores the per-category grouping but still filters by the selected year.

## See also

- [CLEAR](CLEAR.md) — remove filters from both sources
- [CLEAR_OUTER](CLEAR_OUTER.md) — remove only query-level filters
- [RESET_INNER](RESET_INNER.md) — remove all group-by filters
