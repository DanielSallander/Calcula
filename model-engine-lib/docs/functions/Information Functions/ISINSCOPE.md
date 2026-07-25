# ISINSCOPE

Returns TRUE if the specified column is in the current GROUP BY context. Used for conditional logic in measures that should behave differently depending on the grouping level in a matrix or pivot report.

## Syntax

```
ISINSCOPE(table[column])
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `table[column]` | A column reference to test. Typically a dimension column used in GROUP BY. |

## Return value

A boolean — TRUE if the column is part of the current GROUP BY context, FALSE otherwise.

## Remarks

- ISINSCOPE is resolved at query planning time, not at runtime. The engine knows the GROUP BY columns before execution begins.
- Typically used inside [IF](../Conditional%20Functions/IF.md) to show different values at different levels of a matrix hierarchy (e.g., show revenue at the category level but blank at the grand total).
- ISINSCOPE returns FALSE for the grand total row where no grouping columns are active.
- Multiple ISINSCOPE calls can be combined with [AND](../Logical%20Functions/AND.md) / [OR](../Logical%20Functions/OR.md) to test complex grouping conditions.

## Example 1: Conditional display by scope

Show revenue only when grouped by category, blank otherwise.

```
DEFINE Scoped Revenue = IF(ISINSCOPE(dim_product[categoryname]), SUM(fact_sales[linetotal]), BLANK())
```

## Example 2: Different formatting per level

Show count at detail level, percentage at summary level.

```
DEFINE Metric = IF(ISINSCOPE(dim_product[productname]), COUNT(fact_sales[salesorderdetailid]), DIVIDE(SUM(fact_sales[linetotal]), SUM(fact_sales[linetotal], RESET(dim_product))))
```

## See also

- [IF](../Conditional%20Functions/IF.md) — conditional logic
- [BLANK](../Conditional%20Functions/BLANK.md) — return a blank/null value
- [HASONEVALUE](HASONEVALUE.md) — test if a column has exactly one value in context
