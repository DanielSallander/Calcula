# F.DIST.RT function

## Introduction
The F.DIST.RT function returns the right-tailed F probability distribution. It calculates the probability that an F-distributed random variable is greater than or equal to a given value. This is commonly used in ANOVA and regression analysis to compare variances.

## Syntax
```
=F.DIST.RT(x, deg_freedom1, deg_freedom2)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| x | Required | The value at which to evaluate the distribution. Must be >= 0. |
| deg_freedom1 | Required | The numerator degrees of freedom. Must be a positive integer >= 1. |
| deg_freedom2 | Required | The denominator degrees of freedom. Must be a positive integer >= 1. |

## Remarks
- If x is negative, returns #NUM!.
- If deg_freedom1 or deg_freedom2 is less than 1, returns #NUM!.
- Degrees of freedom are truncated to integers.
- F.DIST.RT(x, df1, df2) = 1 - F.DIST(x, df1, df2, TRUE).

## Example

| | A | B |
|---|---|---|
| 1 | **F-Statistic** | **P-Value** |
| 2 | 3.89 | =F.DIST.RT(A2, 5, 20) |

**Result:** Approximately 0.0126 (there is a 1.26% probability of observing an F-value this large or larger)
