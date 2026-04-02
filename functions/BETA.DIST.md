# BETA.DIST function

## Introduction
The BETA.DIST function returns the beta distribution, which is commonly used to study variation in the percentage of something across samples. It can return either the probability density function (PDF) or the cumulative distribution function (CDF).

## Syntax
```
=BETA.DIST(x, alpha, beta, cumulative, [A], [B])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| x | Required | The value at which to evaluate the function, between A and B. |
| alpha | Required | The first shape parameter of the distribution. Must be > 0. |
| beta | Required | The second shape parameter of the distribution. Must be > 0. |
| cumulative | Required | TRUE = cumulative distribution function, FALSE = probability density function. |
| A | Optional | The lower bound of the interval. Default is 0. |
| B | Optional | The upper bound of the interval. Default is 1. |

## Remarks
- If alpha or beta is <= 0, returns #NUM!.
- If x < A or x > B, returns #NUM!.
- If A = B, returns #NUM!.
- If A and B are omitted, the standard beta distribution is used (interval [0, 1]).

## Example

| | A | B |
|---|---|---|
| 1 | **Value** | **Probability** |
| 2 | 0.4 | =BETA.DIST(A2, 2, 5, TRUE) |

**Result:** Approximately 0.6630 (66.3% of the standard beta distribution with alpha=2, beta=5 falls at or below 0.4)
