# WEIBULL.DIST function

## Introduction
The WEIBULL.DIST function returns the Weibull distribution, which is commonly used in reliability analysis to model failure times and life data. It can return either the probability density function (PDF) or the cumulative distribution function (CDF).

## Syntax
```
=WEIBULL.DIST(x, alpha, beta, cumulative)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| x | Required | The value at which to evaluate the function. Must be >= 0. |
| alpha | Required | The shape parameter of the distribution. Must be > 0. |
| beta | Required | The scale parameter of the distribution. Must be > 0. |
| cumulative | Required | TRUE = cumulative distribution function, FALSE = probability density function. |

## Remarks
- If x < 0, returns #NUM!.
- If alpha or beta is <= 0, returns #NUM!.
- When alpha = 1, the Weibull distribution reduces to the exponential distribution.
- When alpha = 2, it approximates the Rayleigh distribution.

## Example

| | A | B |
|---|---|---|
| 1 | **Time (hours)** | **Failure Probability** |
| 2 | 1000 | =WEIBULL.DIST(A2, 2, 1500, TRUE) |

**Result:** Approximately 0.3590 (there is a 35.9% probability of failure within the first 1000 hours given shape=2 and scale=1500)
