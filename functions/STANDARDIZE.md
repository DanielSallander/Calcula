# STANDARDIZE function

## Introduction
The STANDARDIZE function returns the normalized value (z-score) of a value from a distribution characterized by a given mean and standard deviation. It converts a value to a standard normal scale, making it possible to compare values from different distributions.

## Syntax
```
=STANDARDIZE(x, mean, standard_dev)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| x | Required | The value to normalize. |
| mean | Required | The arithmetic mean of the distribution. |
| standard_dev | Required | The standard deviation of the distribution. Must be > 0. |

## Remarks
- If standard_dev is <= 0, returns #NUM!.
- STANDARDIZE(x, mean, sd) = (x - mean) / sd.
- A z-score of 0 means the value equals the mean. Positive values are above the mean; negative values are below.

## Example

| | A | B |
|---|---|---|
| 1 | **Value** | **Z-Score** |
| 2 | 85 | =STANDARDIZE(A2, 70, 10) |

**Result:** 1.5 (the value 85 is 1.5 standard deviations above the mean of 70)
