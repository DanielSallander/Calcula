# EXPON.DIST function

## Introduction
The EXPON.DIST function returns the exponential distribution, which is used to model the time between events in a Poisson process. It is commonly applied in reliability analysis and queuing theory.

## Syntax
```
=EXPON.DIST(x, lambda, cumulative)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| x | Required | The value at which to evaluate the function. Must be >= 0. |
| lambda | Required | The rate parameter (the inverse of the expected interval between events). Must be > 0. |
| cumulative | Required | TRUE = cumulative distribution function, FALSE = probability density function. |

## Remarks
- If x < 0, returns #NUM!.
- If lambda is <= 0, returns #NUM!.
- The cumulative form is: 1 - exp(-lambda * x).
- The mean of the distribution is 1/lambda.

## Example

| | A | B |
|---|---|---|
| 1 | **Time (minutes)** | **Probability** |
| 2 | 5 | =EXPON.DIST(A2, 0.2, TRUE) |

**Result:** Approximately 0.6321 (there is a 63.21% probability that the event occurs within 5 minutes when the average rate is 0.2 events per minute)
