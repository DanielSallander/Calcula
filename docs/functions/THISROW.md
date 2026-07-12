# THISROW

Returns a column's value from the row a calculated column is being COMPUTED FOR (the anchor row), as seen from inside a nested `ITERATE` over the same table. Calcula's clearer-named answer to DAX's EARLIER.

## Syntax

```
THISROW(table[column])
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `table[column]` | The anchor row's column. `table` must be the calculated column's own (host) table. |

## Return value

The value of `column` in the anchor row. Inside the same `ITERATE`, plain references like `table[column]` see the row currently being SCANNED — `THISROW` is how the scanned row talks to the row being computed.

## Remarks

- Valid ONLY inside an aggregate directly over `ITERATE(host, ...)` in a **calculated column** on `host`. Measures have no anchor row and reject it at model build; so does `THISROW` outside `ITERATE`, or over any other table.
- Filtering happens with `IF(condition, value, BLANK())` inside the `ITERATE` — aggregates skip blanks, so `COUNT`/`SUM` over the conditional expression is the FILTER(...) idiom.
- Only plain aggregates (`SUM`, `COUNT`, `MIN`, `MAX`, `AVERAGE`, ...) over `ITERATE` are supported in these columns — no windows, time intelligence, or `QUERY`, and no nested aggregates inside the `ITERATE`.
- Cost: evaluating every row against every other row is inherently O(N²); materialization uses a self-join. Intended for dimension-sized tables, not multi-million-row facts.
- Computed at refresh (like all calculated columns) — the result does not respond to slicers. For slicer-responsive per-row logic, use a context column.

## Example

A rank-by-amount column and a share-of-product column on `Sales(prod_id, amount)`:

```
Rank = COUNT(ITERATE(Sales, IF(Sales[amount] > THISROW(Sales[amount]), 1, BLANK()))) + 1
GroupShare = Sales[amount] / SUM(ITERATE(Sales, IF(Sales[prod_id] = THISROW(Sales[prod_id]), Sales[amount], BLANK())))
```

Each row's `Rank` counts the strictly larger amounts anywhere in the table; each row's `GroupShare` divides its amount by its own product's total.

## See also

- [ITERATE](ITERATE.md)
- [LOOKUPVALUE](LOOKUPVALUE.md)
