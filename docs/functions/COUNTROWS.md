# COUNTROWS

Counts the number of rows in a table. Unlike [COUNT](COUNT.md), COUNTROWS counts all rows including those with NULL values — it is equivalent to SQL `COUNT(*)`.

## Syntax

```
COUNTROWS(table)
COUNTROWS(table, context_op)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `table` | The name of the table whose rows are to be counted. |
| `context_op` | Optional. A context operation ([KEEP](KEEP.md), [CLEAR](CLEAR.md), [RESET](RESET.md)) that modifies the evaluation context. |

## Return value

A whole number — the total number of rows in the table.

## Remarks

- COUNTROWS counts **all rows**, including rows where specific columns may be NULL. This differs from COUNT, which only counts non-null values in a specific column.
- The argument is a **table name**, not a column reference. Use `COUNTROWS(fact_sales)` not `COUNTROWS(fact_sales[id])`.
- COUNTROWS is treated as a simple aggregate and can be pushed down to the data source when used alone.
- COUNTROWS can be used as a denominator in [DIVIDE](DIVIDE.md) for safe average calculations.
- When used with context operations, COUNTROWS is computed locally using DataFusion.

## Example 1: Total row count

Count total rows in the fact_sales table.

```
DEFINE TotalRows = COUNTROWS(fact_sales)
```

| TotalRows |
|-----------|
| 121,317 |

## Example 2: Average using COUNTROWS

Calculate average line total using COUNTROWS as the denominator.

```
DEFINE AvgLineTotal = DIVIDE(SUM(fact_sales[linetotal]), COUNTROWS(fact_sales))
```

This divides total revenue by the number of rows (including rows with NULL linetotal values), which may differ from `AVG(fact_sales[linetotal])`.

## Example 3: COUNTROWS in arithmetic

Use COUNTROWS in arithmetic expressions.

```
DEFINE DoubleRows = COUNTROWS(fact_sales) * 2
DEFINE RowsPlusQty = COUNTROWS(fact_sales) + SUM(fact_sales[orderqty])
```

## Example 4: COUNTROWS grouped by dimension

Count rows per product category.

```
DEFINE RowCount = COUNTROWS(fact_sales)
QUERY: RowCount BY dim_product[categoryname]
```

| categoryname | RowCount |
|-------------|----------|
| Accessories | 36,092 |
| Bikes | 52,762 |
| Clothing | 17,546 |
| Components | 14,917 |

## See also

- [COUNT](COUNT.md) — count non-null values in a specific column
- [DISTINCTCOUNT](DISTINCTCOUNT.md) — count distinct values
- [DIVIDE](DIVIDE.md) — safe division (commonly used with COUNTROWS)
