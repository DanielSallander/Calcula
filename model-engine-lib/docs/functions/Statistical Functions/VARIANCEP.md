# VARIANCEP

Returns the population variance of a set of numeric values. Uses the N denominator, appropriate when the data represents the entire population rather than a sample.

## Syntax

```
VARIANCEP(table[column])
VARIANCEP(table[column], context_op1, context_op2, ...)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `table[column]` | A column reference containing numeric values. |
| `context_op` | Optional. One or more context operations ([KEEP](../Context%20Functions/KEEP.md), [CLEAR](../Context%20Functions/CLEAR.md), [RESET](../Context%20Functions/RESET.md)) that modify the evaluation context. |

## Return value

A non-negative number — the population variance. Returns BLANK if there are no rows.

## Remarks

- VARIANCEP uses the formula with N in the denominator (population variance). For sample variance, use [VARIANCE](VARIANCE.md).
- VARIANCEP will always be less than or equal to VARIANCE for the same data.
- VARIANCEP is the square of [STDEVP](STDEVP.md).
- NULL values are excluded from the calculation.

## Example 1: Population variance of prices

```
DEFINE Price Variance = VARIANCEP(dim_product[listprice])
```

## Example 2: Grouped variance

```
DEFINE Category Variance = VARIANCEP(fact_sales[linetotal])
QUERY: Category Variance BY dim_product[categoryname]
```

## See also

- [VARIANCE](VARIANCE.md) — sample variance (N-1 denominator)
- [STDEVP](STDEVP.md) — population standard deviation
- [AVG](../Aggregation%20Functions/AVG.md) — arithmetic mean
