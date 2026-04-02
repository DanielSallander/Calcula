# T.DIST.RT function

## Introduction
The T.DIST.RT function returns the right-tailed Student's t-distribution. It calculates the probability that a t-distributed random variable is greater than or equal to the given value. This is used in one-tailed hypothesis tests.

## Syntax
```
=T.DIST.RT(x, deg_freedom)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| x | Required | The numeric value at which to evaluate the distribution. |
| deg_freedom | Required | The number of degrees of freedom. Must be a positive integer >= 1. |

## Remarks
- If deg_freedom is less than 1, returns #NUM!.
- deg_freedom is truncated to an integer.
- T.DIST.RT(x, df) = 1 - T.DIST(x, df, TRUE).
- Used to determine the p-value in a one-tailed (right) t-test.

## Example

| | A | B |
|---|---|---|
| 1 | **t-Statistic** | **Right-Tailed P-Value** |
| 2 | 1.83 | =T.DIST.RT(A2, 20) |

**Result:** Approximately 0.0410 (there is a 4.1% probability of observing a t-value this large or larger with 20 degrees of freedom)
