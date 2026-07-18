# RESET_INNER

Removes all group-by (inner) filters from the evaluation context, while keeping query-level (outer) filters intact.

## Syntax

```
SUM(table[column], RESET_INNER())
```

### Parameters

RESET_INNER takes no parameters.

## Return value

The result of the aggregation function, computed with all group-by filters removed but query-level filters preserved.

## Remarks

- RESET_INNER is always used as the **second argument** to an aggregation function. It cannot be used standalone.
- The function name is case-insensitive. Both `RESET_INNER` and `RESETINNER` are accepted.
- Filters have two sources:
  - **Inner (group-by):** Filters from the matrix row/column context — the current grouping level.
  - **Outer (query-level):** Slicer/page filters from the query's `filters` parameter.
- RESET_INNER removes **all** inner filters. Use [CLEAR_INNER](CLEAR_INNER.md) to remove only specific table/column filters.
- Use [RESET](RESET.md) to remove all filters from both sources.
- This is useful when you want a total across all group-by dimensions that still respects the user's slicer selections.

## Example

Show the total across all group-by values while still respecting query-level filters.

```
DEFINE Revenue = SUM(fact_sales[linetotal])
DEFINE Total (Slicers Only) = SUM(fact_sales[linetotal], RESET_INNER())
QUERY: Revenue, Total (Slicers Only) BY dim_product[categoryname]
```

If a year slicer is active (e.g., 2014), `Total (Slicers Only)` shows the total for 2014 across all categories — not the grand total of all time.

## See also

- [ALLSELECTED](ALLSELECTED.md) — the DAX-compatible alias of this function
- [RESET](RESET.md) — remove all filters from both sources
- [RESET_OUTER](RESET_OUTER.md) — remove only query-level filters
- [CLEAR_INNER](CLEAR_INNER.md) — remove specific group-by filters
