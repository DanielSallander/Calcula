# RELATED

Fetches a value from the ONE side of an active many-to-one relationship for the current row — the DAX-compatible spelling of a cross-table column reference.

## Syntax

```
RELATED(table[column])
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `table[column]` | A column on the ONE side of an active, single-hop, equi many-to-one relationship from the expression's host table. |

## Return value

The related row's value, for each row of the host table. Rows with no matching related row yield NULL (blank).

## Remarks

- RELATED is **sugar**: `RELATED(Customer[tier])` parses to exactly the qualified reference `Customer[tier]`, so it renders and persists in the plain spelling. Use whichever form reads better.
- It is valid wherever cross-table row references are valid: **plain calculated columns** and **context columns** on the MANY-side table (e.g. a `Sales` calculated column reading `RELATED(Product[name])`), where the engine LEFT JOINs along the active relationship at materialization.
- The relationship must be active, single-hop, single-column, and equi (`=`); validation rejects unsafe (fan-out) shapes so the join can never multiply host rows.
- Inside measures, cross-table values are usually expressed with grouping/relationship navigation directly (e.g. `SUM(Invoice[amount])` grouped by `Customer[tier]`); RELATED is a row-context tool.

## Example

Segment invoices by their customer's tier as of a selected date (a context column on `Invoice`):

```
IF(Invoice[paid_date] <= [AsOfDate], RELATED(Customer[tier]), "Unpaid")
```

Grouping by this column joins `Invoice -> Customer` along the active relationship and buckets each invoice by the related tier.

## See also

- [LOOKUPVALUE](LOOKUPVALUE.md) — relationship-less keyed lookup
- [KEEP](../Context%20Functions/KEEP.md) — filter-context navigation in measures
- [ISFILTERED](../Information%20Functions/ISFILTERED.md)
