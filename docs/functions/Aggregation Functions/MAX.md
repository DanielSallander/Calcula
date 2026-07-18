# MAX

Returns the largest value in a column.

## Syntax

```
MAX(table[column])
MAX(table[column], context_op1, context_op2, ...)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `table[column]` | The column that contains the values to evaluate. Must be a numeric column (Int32, Int64, Float64, or Decimal). |
| `context_op` | Optional. One or more context operations ([KEEP](../Context%20Functions/KEEP.md), [CLEAR](../Context%20Functions/CLEAR.md), [RESET](../Context%20Functions/RESET.md)) that modify the evaluation context. |

## Return value

A decimal number.

## Remarks

- The MAX function returns the maximum (largest) value among all non-null values in the specified column.
- NULL values are ignored.
- If the column contains no non-null values, the result is NULL.
- The column reference must be fully qualified using the bracket notation: `table[column]`.
- When used without context operations, MAX on a single column is pushed down to the data source for maximum performance.

## Example 1: Simple maximum

Find the highest unit price in the sales data.

```
DEFINE Highest Price = MAX(fact_sales[unitprice])
```

| Highest Price |
|--------------|
| $3,578.27 |

## Example 2: Maximum with grouping

Find the highest unit price per product category.

```
DEFINE Highest Price = MAX(fact_sales[unitprice])
QUERY: Highest Price BY dim_product[categoryname]
```

| categoryname | Highest Price |
|-------------|--------------|
| Bikes | $3,578.27 |
| Components | $1,431.50 |
| Clothing | $89.99 |
| Accessories | $159.00 |

## Example 3: Combining MIN and MAX

Show the price range for each category.

```
DEFINE Lowest Price = MIN(fact_sales[unitprice])
DEFINE Highest Price = MAX(fact_sales[unitprice])
QUERY: Lowest Price, Highest Price BY dim_product[categoryname]
```

## See also

- [MIN](MIN.md)
- [SUM](SUM.md)
- [AVG](AVG.md)
