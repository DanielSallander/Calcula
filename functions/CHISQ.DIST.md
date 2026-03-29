# CHISQ.DIST function

## Introduction
The CHISQ.DIST function returns the chi-squared distribution, commonly used in chi-squared tests of independence and goodness-of-fit tests. It can return either the probability density or the cumulative left-tail probability.

## Syntax
```
=CHISQ.DIST(x, deg_freedom, cumulative)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| x | Required | The value at which to evaluate the distribution. Must be >= 0. |
| deg_freedom | Required | The degrees of freedom (positive integer). |
| cumulative | Required | TRUE = cumulative distribution function, FALSE = probability density function. |

## Remarks
- x must be non-negative; returns #NUM! if x < 0.
- deg_freedom must be a positive integer between 1 and 10^10.
- For the right-tail probability, use CHISQ.DIST.RT instead.

## Example

| | A | B |
|---|---|---|
| 1 | **Chi-sq value** | **Probability** |
| 2 | 5.99 | =CHISQ.DIST(A2, 2, TRUE) |

**Result:** Approximately 0.9500 (cumulative probability with 2 degrees of freedom)
