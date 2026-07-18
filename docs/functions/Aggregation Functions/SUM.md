# SUM

Adds all the values in a column.

## Syntax

```
SUM(table[column])
SUM(table[column], context_op1, context_op2, ...)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `table[column]` | The column that contains the values to be summed. Must be a numeric column (Int32, Int64, Float64, or Decimal). |
| `context_op` | Optional. One or more context operations ([KEEP](KEEP.md), [CLEAR](CLEAR.md), [RESET](RESET.md)) that modify the evaluation context. |

## Return value

A decimal number.

## Remarks

- The SUM function takes a single column reference and returns the sum of all values in that column.
- NULL values are ignored during summation.
- If the column contains no non-null values, the result is 0.
- The column reference must be fully qualified using the bracket notation: `table[column]`.
- SUM can also operate on arithmetic expressions involving multiple columns from the same table: `SUM(table[price] * table[quantity])`.
- When used without context operations, SUM on a single column is pushed down to the data source for maximum performance.

## Example 1: Simple sum

Calculate total revenue from the fact_sales table.

```
DEFINE Revenue = SUM(fact_sales[linetotal])
```

Using the AdventureWorks BI model:

| Revenue |
|---------|
| $109,846,381.40 |

## Example 2: Sum with grouping

Calculate revenue grouped by product category.

```
DEFINE Revenue = SUM(fact_sales[linetotal])
QUERY: Revenue BY dim_product[categoryname]
```

| categoryname | Revenue |
|-------------|---------|
| Bikes | $94,620,526.47 |
| Components | $11,799,076.67 |
| Clothing | $2,120,542.60 |
| Accessories | $1,306,235.66 |

## Example 3: Sum over an arithmetic expression

Calculate revenue as price times quantity.

```
DEFINE Revenue = SUM(fact_sales[unitprice] * fact_sales[orderqty])
```

## Example 4: Sum with context operation

Calculate revenue for a specific year only.

```
DEFINE Revenue 2014 = SUM(fact_sales[linetotal], KEEP(dim_date, dim_date[year] = 2014))
```

This uses the [KEEP](KEEP.md) function to filter the evaluation context to year 2014 only, regardless of any other year filter applied by the query.

## See also

- [COUNT](COUNT.md)
- [AVG](AVG.md)
- [MIN](MIN.md)
- [MAX](MAX.md)
- [KEEP](KEEP.md)
