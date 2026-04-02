# PHI function

## Introduction
The PHI function returns the value of the probability density function for the standard normal distribution at a given point. It gives the height of the bell curve at a specific z-value.

## Syntax
```
=PHI(x)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| x | Required | The number for which to calculate the density of the standard normal distribution. |

## Remarks
- PHI(x) = (1 / SQRT(2 * PI)) * EXP(-x^2 / 2).
- Equivalent to NORM.S.DIST(x, FALSE).
- The maximum value occurs at x = 0, where PHI(0) is approximately 0.3989.

## Example

| | A | B |
|---|---|---|
| 1 | **Z-Score** | **Density** |
| 2 | 0 | =PHI(A2) |
| 3 | 1 | =PHI(A3) |

**Result:** Row 2 returns approximately 0.3989 (the peak of the standard normal curve). Row 3 returns approximately 0.2420.
