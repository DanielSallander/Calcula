# STDEVP

Returns the population standard deviation of a set of numeric values. Uses the N denominator, appropriate when the data represents the entire population rather than a sample.

## Syntax

```
STDEVP(table[column])
STDEVP(table[column], context_op1, context_op2, ...)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `table[column]` | A column reference containing numeric values. |
| `context_op` | Optional. One or more context operations ([KEEP](KEEP.md), [CLEAR](CLEAR.md), [RESET](RESET.md)) that modify the evaluation context. |

## Return value

A non-negative number — the population standard deviation. Returns BLANK if there are no rows.

## Remarks

- STDEVP uses the formula with N in the denominator (population standard deviation). For sample standard deviation, use [STDEV](STDEV.md).
- STDEVP will always be less than or equal to STDEV for the same data.
- NULL values are excluded from the calculation.
- The result is the square root of [VARIANCEP](VARIANCEP.md).

## Example 1: Population standard deviation of prices

```
DEFINE Price StdDev = STDEVP(dim_product[listprice])
```

## Example 2: Compare sample vs population

```
DEFINE Sample StdDev = STDEV(fact_sales[linetotal])
DEFINE Pop StdDev = STDEVP(fact_sales[linetotal])
```

## See also

- [STDEV](STDEV.md) — sample standard deviation (N-1 denominator)
- [VARIANCEP](VARIANCEP.md) — population variance
- [AVG](AVG.md) — arithmetic mean
