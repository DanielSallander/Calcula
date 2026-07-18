# LOOKUPVALUE

Returns a value from another table's row where search columns match the given expressions — a relationship-less single-row lookup (DAX-compatible).

## Syntax

```
LOOKUPVALUE(table[result_column], table[search_column], search_value)
LOOKUPVALUE(table[result_column], table[search_column], search_value, table[search_column2], search_value2, ...)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `table[result_column]` | The column whose value is returned from the matched row. |
| `table[search_column]` | A column on the SAME table to match against. One or more pairs, ANDed. |
| `search_value` | A row-level expression over the host table (a column, `RELATED(...)`, arithmetic, ...). |

## Return value

The matched row's result value, per host row. No match yields NULL (blank); when several rows match, the tie resolves deterministically to the MINIMUM result value (host rows are never duplicated).

## Remarks

- Valid only in **plain calculated columns** (v1) — measures reject it with guidance (a measure has no host row). No relationship between the tables is required; for relationship navigation prefer [RELATED](RELATED.md).
- All named columns must live on one table (the DAX shape); search values evaluate against the calculated column's host row.
- Resolved at materialization as a LEFT JOIN against a per-key-deduplicated subquery, so a duplicate-key lookup table can never multiply the host table's rows or inflate aggregates.
- Search values must not contain another LOOKUPVALUE.

## Example

Attach a rate to each sale by product id, with no relationship to the Rates table:

```
LOOKUPVALUE(Rates[rate], Rates[pid], Sales[prod_id])
```

Each `Sales` row gets the rate whose `pid` equals its `prod_id`; sales without a matching rate get blank.

## See also

- [RELATED](RELATED.md) — relationship-based row dereference
- [KEEP](../Context%20Functions/KEEP.md) — filter-context navigation in measures
