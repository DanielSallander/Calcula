# GAUSS function

## Introduction
The GAUSS function returns the probability that a member of the standard normal population falls between the mean (0) and a given number of standard deviations from the mean. It is equivalent to NORM.S.DIST(z, TRUE) - 0.5.

## Syntax
```
=GAUSS(z)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| z | Required | The number of standard deviations from the mean. |

## Remarks
- GAUSS(z) = NORM.S.DIST(z, TRUE) - 0.5.
- GAUSS(0) = 0 (at the mean, there is no area between the mean and itself).
- For z > 0, GAUSS returns a positive value; for z < 0, a negative value.
- GAUSS(1) is approximately 0.3413 (about 34.13% of data falls between the mean and one standard deviation above).

## Example

| | A | B |
|---|---|---|
| 1 | **Z-Score** | **Probability** |
| 2 | 2 | =GAUSS(A2) |

**Result:** Approximately 0.4772 (47.72% of the standard normal distribution falls between the mean and 2 standard deviations above)
