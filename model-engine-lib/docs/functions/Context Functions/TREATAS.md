# TREATAS

Applies the distinct values of a source column as a virtual filter on a target column — connecting tables that have no model relationship (DAX-compatible).

## Syntax

```
TREATAS(source_table[source_column], target_table[target_column])
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `source_table[source_column]` | The column supplying the filter values. May be a raw model table or a table variable. |
| `target_table[target_column]` | The column to filter: only rows whose value appears in the source survive. |

## Return value

A filter modifier: rows of the target's table are kept only where `target_column` is one of the source column's (current-context) distinct values. Wrap it around or combine it with a measure expression like other context tools.

## Remarks

- Use it when two tables are related *logically* but no relationship exists in the model (e.g. a disconnected parameter/selection table driving a fact).
- The source set is materialized per query: the engine runs a `SELECT DISTINCT` over the source column (with any filters on the source table applied), then filters the target with an IN-list of those values.
- Large sets are capped (50 000 values) — beyond that the query fails with a clear error rather than degrading silently.
- An empty source set filters everything out (the measure sees no rows), matching DAX.
- The source may also be a table variable (`VAR`-style named subset); the variable's own filters apply before the distinct set is taken.

## Example

Filter fact sales by the cities listed in a disconnected selection table.

```
DEFINE Selected City Sales = TREATAS(selection[city], dim_customer[city]) SUM(fact_sales[linetotal])
```

Only sales whose customer city appears in `selection[city]` are summed — no relationship between `selection` and the model required.

## See also

- [KEEP](KEEP.md)
- [LOOKUPVALUE](../Relationship%20and%20Hierarchy%20Functions/LOOKUPVALUE.md)
