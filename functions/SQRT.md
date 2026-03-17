# SQRT function

## Introduction
The SQRT function returns the positive square root of a number. It is commonly used in engineering calculations, statistical analysis (e.g., standard deviation computations), geometry (calculating distances), and financial modeling (e.g., annualized volatility from variance).

## Syntax
```
=SQRT(number)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number | Required | The number for which you want the square root. |

## Remarks
- If **number** is negative, SQRT returns a #NUM! error. To find the square root of a negative number, use SQRT(ABS(number)) and handle the sign separately.
- SQRT(0) returns 0.
- SQRT(1) returns 1.

## Example

| | A | B |
|---|---|---|
| 1 | **Variance** | **Std Deviation** |
| 2 | 625 | =SQRT(A2) |

**Result:** 25

The formula computes the standard deviation as the square root of the variance (625), returning 25.
