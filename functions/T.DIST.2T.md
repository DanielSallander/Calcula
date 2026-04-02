# T.DIST.2T function

## Introduction
The T.DIST.2T function returns the two-tailed Student's t-distribution. It calculates the probability that a t-distributed random variable falls in either tail beyond the given value. This is commonly used in two-tailed hypothesis tests.

## Syntax
```
=T.DIST.2T(x, deg_freedom)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| x | Required | The numeric value at which to evaluate the distribution. Must be >= 0. |
| deg_freedom | Required | The number of degrees of freedom. Must be a positive integer >= 1. |

## Remarks
- If x is negative, returns #NUM!.
- If deg_freedom is less than 1, returns #NUM!.
- deg_freedom is truncated to an integer.
- T.DIST.2T(x, df) is equivalent to 2 * T.DIST.RT(x, df) for x >= 0.
- Used to determine the p-value in a two-tailed t-test.

## Example

| | A | B |
|---|---|---|
| 1 | **t-Statistic** | **Two-Tailed P-Value** |
| 2 | 2.5 | =T.DIST.2T(A2, 15) |

**Result:** Approximately 0.0247 (there is a 2.47% probability of observing a t-value this extreme in either tail with 15 degrees of freedom)
