# NORM.DIST function

## Introduction
The NORM.DIST function returns the normal distribution for a specified mean and standard deviation. It can return either the probability density function (PDF) or the cumulative distribution function (CDF), widely used in statistical hypothesis testing and quality control.

## Syntax
```
=NORM.DIST(x, mean, standard_dev, cumulative)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| x | Required | The value for which you want the distribution. |
| mean | Required | The arithmetic mean of the distribution. |
| standard_dev | Required | The standard deviation of the distribution. Must be > 0. |
| cumulative | Required | TRUE = cumulative distribution function, FALSE = probability density function. |

## Remarks
- If standard_dev is 0 or negative, returns #NUM!.
- When cumulative is TRUE, returns the probability that a random variable is less than or equal to x.
- For the standard normal distribution (mean=0, standard_dev=1), use NORM.S.DIST.

## Example

| | A | B |
|---|---|---|
| 1 | **Value** | **Probability** |
| 2 | 42 | =NORM.DIST(A2, 40, 1.5, TRUE) |

**Result:** Approximately 0.9088 (90.88% of values fall at or below 42)
