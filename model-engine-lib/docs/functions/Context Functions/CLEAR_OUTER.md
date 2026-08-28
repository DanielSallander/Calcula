# CLEAR_OUTER

Removes query-level (outer) filters on a specific table or column from the evaluation context, while keeping group-by (inner) filters intact.

## Syntax

Clear outer filters on a table:

```
SUM(table[column], CLEAR_OUTER(dimension_table))
```

Clear outer filters on a specific column:

```
SUM(table[column], CLEAR_OUTER(dimension_table[column]))
```

Clear outer filters up to and including a pinned level:

```
SUM(table[column], CLEAR_OUTER(dimension_table[column], LEVEL n))
```

The function name is case-insensitive. Both `CLEAR_OUTER` and `CLEAROUTER` are accepted.

### Parameters

| Parameter | Definition |
|-----------|------------|
| `dimension_table` | The name of the table whose query-level filters should be removed. |
| `dimension_table[column]` | A specific column whose query-level filters should be removed. |
| `LEVEL n` | Optional. Extends the clear to pinned filters: removes filter levels 1 through `n` (n = 1..9). `LEVEL` must be at least 1 — `LEVEL 0` is a parse error, because CLEAR_OUTER never touches the level-0 axis. Must be the **last** argument. |

## Return value

The result of the aggregation function, computed with the specified query-level filters removed but group-by filters preserved.

## Remarks

- CLEAR_OUTER is always used as the **second argument** to an aggregation function. It cannot be used standalone.
- Filters have two sources:
  - **Inner (group-by):** Filters from the matrix row/column context — the current grouping level.
  - **Outer (query-level):** Slicer/page filters from the query's `filters` parameter.
- CLEAR_OUTER only removes outer (query-level) filters. Inner (group-by) filters remain active.
- In filter-level terms (see [CLEAR](CLEAR.md) for the level table): the axis is level 0, ordinary slicers and query-level filters are level 1, and **pinned** filters occupy levels 2–9. Bare `CLEAR_OUTER(…)` removes level 1 only, so pinned filters survive it; `CLEAR_OUTER(…, LEVEL n)` removes levels 1 through `n`. The axis (level 0) is always kept.
- Use [CLEAR](CLEAR.md) to remove filters from both sources, or [CLEAR_INNER](CLEAR_INNER.md) to remove only group-by filters.
- This is useful when you want a measure to ignore slicer selections but still break down by the current grouping.

## Example

Show revenue per category regardless of any slicer filters, but still grouped correctly.

```
DEFINE Revenue No Slicers = SUM(fact_sales[linetotal], CLEAR_OUTER(dim_date))
```

When grouped by category and a year slicer is active, this measure ignores the year slicer but still correctly groups by category.

## See also

- [CLEAR](CLEAR.md) — remove filters from both sources
- [CLEAR_INNER](CLEAR_INNER.md) — remove only group-by filters
- [RESET_OUTER](RESET_OUTER.md) — remove all query-level filters
