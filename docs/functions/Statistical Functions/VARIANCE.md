# VARIANCE

Returns the sample variance of a set of numeric values. Uses the N-1 (Bessel's correction) denominator, appropriate when the data represents a sample from a larger population.

## Syntax

```
VARIANCE(table[column])
VARIANCE(table[column], context_op1, context_op2, ...)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `table[column]` | A column reference containing numeric values. |
| `context_op` | Optional. One or more context operations ([KEEP](../Context%20Functions/KEEP.md), [CLEAR](../Context%20Functions/CLEAR.md), [RESET](../Context%20Functions/RESET.md)) that modify the evaluation context. |

## Return value

A non-negative number — the sample variance. Returns BLANK if there are fewer than two rows.

## Remarks

- VARIANCE uses the formula with N-1 in the denominator (sample variance). For population variance, use [VARIANCEP](VARIANCEP.md).
- VARIANCE is the square of [STDEV](STDEV.md).
- NULL values are excluded from the calculation.
- VARIANCE supports context operations like other aggregation functions.

## Example 1: Sales variance

```
DEFINE Sales Variance = VARIANCE(fact_sales[linetotal])
```

## Example 2: Variance with context filter

```
DEFINE Bikes Variance = VARIANCE(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes"))
```

## See also

- [VARIANCEP](VARIANCEP.md) — population variance (N denominator)
- [STDEV](STDEV.md) — sample standard deviation
- [AVG](../Aggregation%20Functions/AVG.md) — arithmetic mean
