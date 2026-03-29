# T.DIST function

## Introduction
The T.DIST function returns the Student's t-distribution, which is used for hypothesis testing with small sample sizes when the population standard deviation is unknown. It can return either the probability density or the cumulative left-tail probability.

## Syntax
```
=T.DIST(x, deg_freedom, cumulative)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| x | Required | The numeric value at which to evaluate the distribution. |
| deg_freedom | Required | The degrees of freedom (positive integer). |
| cumulative | Required | TRUE = cumulative distribution function, FALSE = probability density function. |

## Remarks
- deg_freedom must be a positive integer; returns #NUM! otherwise.
- The t-distribution approaches the normal distribution as degrees of freedom increase.
- For two-tailed probability, use T.DIST.2T instead.

## Example

| | A | B |
|---|---|---|
| 1 | **t-value** | **Probability** |
| 2 | 1.96 | =T.DIST(A2, 10, TRUE) |

**Result:** Approximately 0.9609 (left-tail probability with 10 degrees of freedom)
