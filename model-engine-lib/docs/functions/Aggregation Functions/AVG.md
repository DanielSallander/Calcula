# AVG

Returns the arithmetic mean (average) of all values in a column.

## Syntax

```
AVG(table[column])
AVG(table[column], context_op1, context_op2, ...)
```

or

```
AVERAGE(table[column])
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `table[column]` | The column that contains the values to be averaged. Must be a numeric column (Int32, Int64, Float64, or Decimal). |
| `context_op` | Optional. One or more context operations ([KEEP](../Context%20Functions/KEEP.md), [CLEAR](../Context%20Functions/CLEAR.md), [RESET](../Context%20Functions/RESET.md)) that modify the evaluation context. |

## Return value

A decimal number.

## Remarks

- The AVG function calculates the arithmetic mean by summing all non-null values and dividing by the count of non-null values.
- `AVERAGE` is an alias for `AVG` — both are equivalent.
- NULL values are excluded from both the sum and the count.
- If the column contains no non-null values, the result is NULL.
- The column reference must be fully qualified using the bracket notation: `table[column]`.
- When used without context operations, AVG on a single column is pushed down to the data source for maximum performance.

## Example 1: Simple average

Calculate the average unit price across all sales.

```
DEFINE Avg Unit Price = AVG(fact_sales[unitprice])
```

| Avg Unit Price |
|---------------|
| $742.85 |

## Example 2: Average with grouping

Calculate the average unit price by product category.

```
DEFINE Avg Unit Price = AVG(fact_sales[unitprice])
QUERY: Avg Unit Price BY dim_product[categoryname]
```

| categoryname | Avg Unit Price |
|-------------|---------------|
| Bikes | $1,397.26 |
| Components | $308.45 |
| Clothing | $38.92 |
| Accessories | $22.17 |

## Example 3: Custom average using SUM and COUNT

You can also build a custom average using SUM and COUNT for more control:

```
DEFINE Custom Avg = SUM(fact_sales[linetotal]) / COUNT(fact_sales[salesorderdetailid])
```

This is different from `AVG(fact_sales[linetotal])` because it divides the total revenue by the number of order lines, not by the number of non-null linetotal values (though in practice these are usually the same).

## See also

- [SUM](SUM.md)
- [COUNT](COUNT.md)
- [MIN](MIN.md)
- [MAX](MAX.md)
