# ALLSELECTED

Removes the group-by (visual) filters from the evaluation context while keeping query-level slicer filters — the DAX-compatible spelling of the inner-clear family.

## Syntax

```
SUM(table[column], ALLSELECTED())
SUM(table[column], ALLSELECTED(table))
SUM(table[column], ALLSELECTED(table[column]))
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| *(none)* | The bare form removes **all** group-by filters (equivalent to [RESET_INNER](RESET_INNER.md)). |
| `table` / `table[column]` | Optional. One or more targets whose group-by filters are removed (equivalent to [CLEAR_INNER](CLEAR_INNER.md) on those targets). |

## Return value

The result of the aggregation function, computed with the targeted group-by filters removed but query-level slicer filters preserved.

## Remarks

- ALLSELECTED is always used as the **second argument** to an aggregation function. It cannot be used standalone.
- It is an **alias**: `ALLSELECTED()` parses to `RESET_INNER()` and `ALLSELECTED(target)` parses to `CLEAR_INNER(target)` — evaluation and persistence are shared, and a saved formula renders back in the RESET_INNER/CLEAR_INNER spelling.
- This matches DAX's `ALLSELECTED`: the classic "% of visible total" — each row divided by the total of everything the user's slicers allow, regardless of the row axis.
- Filters have two sources:
  - **Inner (group-by):** filters from the matrix row/column context — the current grouping level.
  - **Outer (query-level):** slicer/page filters from the query's `filters` parameter.
- Use [RESET](RESET.md) to remove all filters from both sources (DAX `ALL()` over everything).

## Example

Percent of the slicer-visible total per category.

```
DEFINE Revenue = SUM(fact_sales[linetotal])
DEFINE Pct of Visible = DIVIDE(SUM(fact_sales[linetotal]), SUM(fact_sales[linetotal], ALLSELECTED()))
QUERY: Revenue, Pct of Visible BY dim_product[categoryname]
```

With a year slicer on 2014, each category shows its share of the 2014 total — the shares sum to 100% over the visible rows.

## See also

- [RESET_INNER](RESET_INNER.md) — the canonical spelling of the bare form
- [CLEAR_INNER](CLEAR_INNER.md) — the canonical spelling of the targeted form
- [RESET](RESET.md) — remove all filters from both sources
- [RESET_OUTER](RESET_OUTER.md) — remove only query-level filters
