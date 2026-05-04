# STDEV

Returns the sample standard deviation of a set of numeric values. Uses the N-1 (Bessel's correction) denominator, appropriate when the data represents a sample from a larger population.

## Syntax

```
STDEV(table[column])
STDEV(table[column], context_op1, context_op2, ...)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `table[column]` | A column reference containing numeric values. |
| `context_op` | Optional. One or more context operations ([KEEP](KEEP.md), [CLEAR](CLEAR.md), [RESET](RESET.md)) that modify the evaluation context. |

## Return value

A non-negative number — the sample standard deviation. Returns BLANK if there are fewer than two rows.

## Remarks

- STDEV uses the formula with N-1 in the denominator (sample standard deviation). For population standard deviation, use [STDEVP](STDEVP.md).
- NULL values are excluded from the calculation.
- STDEV supports context operations like other aggregation functions.
- The result is the square root of [VARIANCE](VARIANCE.md).

## Example 1: Revenue variability

```
DEFINE Revenue StdDev = STDEV(fact_sales[linetotal])
```

## Example 2: Grouped standard deviation

Calculate standard deviation per product category.

```
DEFINE Category StdDev = STDEV(fact_sales[linetotal])
QUERY: Category StdDev BY dim_product[categoryname]
```

## See also

- [STDEVP](STDEVP.md) — population standard deviation (N denominator)
- [VARIANCE](VARIANCE.md) — sample variance
- [AVG](AVG.md) — arithmetic mean
