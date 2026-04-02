# CHISQ.DIST.RT function

## Introduction
The CHISQ.DIST.RT function returns the right-tailed probability of the chi-squared distribution. It calculates the probability that a chi-squared-distributed random variable is greater than or equal to a given value. This is commonly used in goodness-of-fit tests and tests of independence.

## Syntax
```
=CHISQ.DIST.RT(x, deg_freedom)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| x | Required | The value at which to evaluate the distribution. Must be >= 0. |
| deg_freedom | Required | The number of degrees of freedom. Must be a positive integer between 1 and 10^10. |

## Remarks
- If x is negative, returns #NUM!.
- If deg_freedom is less than 1, returns #NUM!.
- deg_freedom is truncated to an integer.
- CHISQ.DIST.RT(x, df) = 1 - CHISQ.DIST(x, df, TRUE).

## Example

| | A | B |
|---|---|---|
| 1 | **Chi-Squared Statistic** | **P-Value** |
| 2 | 18.307 | =CHISQ.DIST.RT(A2, 10) |

**Result:** Approximately 0.0500 (there is a 5% probability of observing a chi-squared value this large or larger with 10 degrees of freedom)
