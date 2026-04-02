# FISHER function

## Introduction
The FISHER function returns the Fisher transformation of a value. The Fisher transformation converts a correlation coefficient into a value that is approximately normally distributed, which is useful for constructing confidence intervals and performing hypothesis tests on correlation coefficients.

## Syntax
```
=FISHER(x)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| x | Required | The value for which to calculate the Fisher transformation. Must be between -1 and 1 (exclusive). |

## Remarks
- If x is <= -1 or >= 1, returns #NUM!.
- FISHER(x) = 0.5 * LN((1 + x) / (1 - x)), which is the inverse hyperbolic tangent (arctanh).
- Use FISHERINV to reverse the transformation.

## Example

| | A | B |
|---|---|---|
| 1 | **Correlation** | **Fisher Z** |
| 2 | 0.75 | =FISHER(A2) |

**Result:** Approximately 0.9730 (the Fisher-transformed value of the correlation coefficient 0.75)
