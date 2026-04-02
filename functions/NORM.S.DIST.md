# NORM.S.DIST function

## Introduction
The NORM.S.DIST function returns the standard normal distribution (mean=0, standard deviation=1). It can return either the probability density function (PDF) or the cumulative distribution function (CDF). This is commonly used for z-score calculations in hypothesis testing.

## Syntax
```
=NORM.S.DIST(z, cumulative)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| z | Required | The value for which you want the distribution (the z-score). |
| cumulative | Required | TRUE = cumulative distribution function, FALSE = probability density function. |

## Remarks
- Equivalent to NORM.DIST(z, 0, 1, cumulative).
- When cumulative is TRUE, returns the probability that a standard normal random variable is less than or equal to z.
- The standard normal distribution is the basis for z-tests and confidence intervals.

## Example

| | A | B |
|---|---|---|
| 1 | **Z-Score** | **Probability** |
| 2 | 1.96 | =NORM.S.DIST(A2, TRUE) |

**Result:** Approximately 0.9750 (97.5% of the standard normal distribution falls at or below z=1.96)
