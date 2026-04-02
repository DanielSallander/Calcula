# LOGNORM.DIST function

## Introduction
The LOGNORM.DIST function returns the lognormal distribution of x, where the natural logarithm of x is normally distributed. It is commonly used to analyze data that is positively skewed, such as stock prices, real estate values, and income distributions.

## Syntax
```
=LOGNORM.DIST(x, mean, standard_dev, cumulative)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| x | Required | The value at which to evaluate the function. Must be > 0. |
| mean | Required | The mean of ln(x). |
| standard_dev | Required | The standard deviation of ln(x). Must be > 0. |
| cumulative | Required | TRUE = cumulative distribution function, FALSE = probability density function. |

## Remarks
- If x is <= 0, returns #NUM!.
- If standard_dev is <= 0, returns #NUM!.
- The lognormal CDF is equivalent to NORM.S.DIST((LN(x) - mean) / standard_dev, TRUE).

## Example

| | A | B |
|---|---|---|
| 1 | **Value** | **Probability** |
| 2 | 4 | =LOGNORM.DIST(A2, 3.5, 1.2, TRUE) |

**Result:** Approximately 0.0390 (3.9% of the lognormal distribution with mean=3.5 and standard_dev=1.2 falls at or below 4)
