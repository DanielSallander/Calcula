# MINVERSE function

## Introduction
The MINVERSE function returns the inverse matrix of a square array. The inverse of a matrix A is the matrix A^(-1) such that A * A^(-1) = I (the identity matrix). Matrix inversion is used to solve systems of linear equations and in many engineering computations.

## Syntax
```
=MINVERSE(array)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| array | Required | A square numeric array (same number of rows and columns). |

## Remarks
- The array must be square (equal number of rows and columns); otherwise MINVERSE returns a #VALUE! error.
- If any cell in the array is empty or contains text, MINVERSE returns a #VALUE! error.
- If the matrix is singular (determinant equals 0), MINVERSE returns a #NUM! error.
- MINVERSE must be entered as an array formula (Ctrl+Shift+Enter in classic mode, or it spills automatically with dynamic arrays).
- The resulting array has the same dimensions as the input array.
- Results may contain small rounding errors due to floating-point arithmetic.

## Example

| | A | B |
|---|---|---|
| 1 | 4 | 7 |
| 2 | 2 | 6 |

Formula: =MINVERSE(A1:B2)

| | C | D |
|---|---|---|
| 1 | 0.6 | -0.7 |
| 2 | -0.2 | 0.4 |

**Result:** The inverse of the 2x2 matrix. Multiplying the original matrix by this result yields the identity matrix.
