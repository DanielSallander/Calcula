# FISHERINV function

## Introduction
The FISHERINV function returns the inverse of the Fisher transformation. It converts a Fisher-transformed value back to the original correlation coefficient scale.

## Syntax
```
=FISHERINV(y)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| y | Required | The value for which to perform the inverse Fisher transformation. |

## Remarks
- FISHERINV(y) = (EXP(2*y) - 1) / (EXP(2*y) + 1), which is the hyperbolic tangent (tanh).
- The result always falls between -1 and 1.
- Use FISHER to perform the forward transformation.

## Example

| | A | B |
|---|---|---|
| 1 | **Fisher Z** | **Correlation** |
| 2 | 0.9730 | =FISHERINV(A2) |

**Result:** Approximately 0.75 (the inverse Fisher transformation returns the original correlation coefficient)
