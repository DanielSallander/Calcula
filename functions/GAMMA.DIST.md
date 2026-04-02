# GAMMA.DIST function

## Introduction
The GAMMA.DIST function returns the gamma distribution, which is commonly used in queuing analysis and reliability studies. It can return either the probability density function (PDF) or the cumulative distribution function (CDF).

## Syntax
```
=GAMMA.DIST(x, alpha, beta, cumulative)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| x | Required | The value at which to evaluate the distribution. Must be >= 0. |
| alpha | Required | The shape parameter of the distribution. Must be > 0. |
| beta | Required | The scale parameter (also called rate parameter inverse). Must be > 0. |
| cumulative | Required | TRUE = cumulative distribution function, FALSE = probability density function. |

## Remarks
- If x < 0, returns #NUM!.
- If alpha or beta is <= 0, returns #NUM!.
- When alpha = 1, GAMMA.DIST is equivalent to the exponential distribution.
- When alpha is a positive integer, the gamma distribution is also known as the Erlang distribution.

## Example

| | A | B |
|---|---|---|
| 1 | **Value** | **Probability** |
| 2 | 10 | =GAMMA.DIST(A2, 3, 2, TRUE) |

**Result:** Approximately 0.8753 (87.53% of the gamma distribution with shape=3 and scale=2 falls at or below 10)
