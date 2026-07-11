# COUNT

Counts the number of non-null values in a column.

## Syntax

```
COUNT(table[column])
COUNT(table[column], context_op1, context_op2, ...)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `table[column]` | The column that contains the values to be counted. Can be any data type. |
| `context_op` | Optional. One or more context operations ([KEEP](KEEP.md), [CLEAR](CLEAR.md), [RESET](RESET.md)) that modify the evaluation context. |

## Return value

A whole number.

## Remarks

- The COUNT function counts the number of rows that have a non-null value in the specified column.
- NULL values are excluded from the count.
- To count distinct values, use [DISTINCTCOUNT](DISTINCTCOUNT.md) instead.
- The column reference must be fully qualified using the bracket notation: `table[column]`.
- When used without context operations, COUNT on a single column is pushed down to the data source for maximum performance.

## Example 1: Simple count

Count the total number of sales order lines.

```
DEFINE Order Count = COUNT(fact_sales[salesorderdetailid])
```

| Order Count |
|------------|
| 121,317 |

## Example 2: Count with grouping

Count orders per product category.

```
DEFINE Order Count = COUNT(fact_sales[salesorderdetailid])
QUERY: Order Count BY dim_product[categoryname]
```

| categoryname | Order Count |
|-------------|------------|
| Bikes | 52,762 |
| Components | 35,218 |
| Clothing | 22,868 |
| Accessories | 10,469 |

## Example 3: Using COUNT in a ratio

Calculate the average order value by dividing total revenue by order count.

```
DEFINE Avg Order Value = SUM(fact_sales[linetotal]) / COUNT(fact_sales[salesorderdetailid])
```

This creates a measure that divides total revenue by the number of order lines to get the average line value.

## See also

- [SUM](SUM.md)
- [DISTINCTCOUNT](DISTINCTCOUNT.md)
- [AVG](AVG.md)
