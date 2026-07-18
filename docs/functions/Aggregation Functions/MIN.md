# MIN

Returns the smallest value in a column.

## Syntax

```
MIN(table[column])
MIN(table[column], context_op1, context_op2, ...)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `table[column]` | The column that contains the values to evaluate. Must be a numeric column (Int32, Int64, Float64, or Decimal). |
| `context_op` | Optional. One or more context operations ([KEEP](KEEP.md), [CLEAR](CLEAR.md), [RESET](RESET.md)) that modify the evaluation context. |

## Return value

A decimal number.

## Remarks

- The MIN function returns the minimum (smallest) value among all non-null values in the specified column.
- NULL values are ignored.
- If the column contains no non-null values, the result is NULL.
- The column reference must be fully qualified using the bracket notation: `table[column]`.
- When used without context operations, MIN on a single column is pushed down to the data source for maximum performance.

## Example 1: Simple minimum

Find the lowest unit price in the sales data.

```
DEFINE Lowest Price = MIN(fact_sales[unitprice])
```

| Lowest Price |
|-------------|
| $2.29 |

## Example 2: Minimum with grouping

Find the lowest unit price per product category.

```
DEFINE Lowest Price = MIN(fact_sales[unitprice])
QUERY: Lowest Price BY dim_product[categoryname]
```

| categoryname | Lowest Price |
|-------------|-------------|
| Accessories | $2.29 |
| Clothing | $8.99 |
| Components | $14.99 |
| Bikes | $539.99 |

## Example 3: Minimum with context operation

Find the lowest unit price across all years, ignoring any year filter.

```
DEFINE Lowest Price Ever = MIN(fact_sales[unitprice], RESET())
```

This uses [RESET](RESET.md) to remove all filters from the evaluation context, returning the absolute minimum price regardless of any filters applied by the query.

## See also

- [MAX](MAX.md)
- [SUM](SUM.md)
- [AVG](AVG.md)
