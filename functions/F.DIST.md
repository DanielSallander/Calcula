# F.DIST function

## Introduction
The F.DIST function returns the F probability distribution, used in ANOVA tests and to compare variances of two populations. It can return either the probability density or the cumulative left-tail probability.

## Syntax
```
=F.DIST(x, deg_freedom1, deg_freedom2, cumulative)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| x | Required | The value at which to evaluate the distribution. Must be >= 0. |
| deg_freedom1 | Required | The numerator degrees of freedom (positive integer). |
| deg_freedom2 | Required | The denominator degrees of freedom (positive integer). |
| cumulative | Required | TRUE = cumulative distribution function, FALSE = probability density function. |

## Remarks
- x must be non-negative; returns #NUM! if x < 0.
- Both deg_freedom values must be positive integers.
- For the right-tail probability, use F.DIST.RT instead.

## Example

| | A | B |
|---|---|---|
| 1 | **F-value** | **Probability** |
| 2 | 3.5 | =F.DIST(A2, 5, 10, TRUE) |

**Result:** Approximately 0.9543 (cumulative probability with df1=5, df2=10)
