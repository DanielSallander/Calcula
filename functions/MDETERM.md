# MDETERM function

## Introduction
The MDETERM function returns the matrix determinant of a square array. The determinant is a scalar value that provides important information about a matrix, including whether it is invertible. Determinants are used in solving systems of linear equations, computing eigenvalues, and many engineering applications.

## Syntax
```
=MDETERM(array)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| array | Required | A square numeric array (same number of rows and columns). |

## Remarks
- The array must be square (equal number of rows and columns); otherwise MDETERM returns a #VALUE! error.
- If any cell in the array is empty or contains text, MDETERM returns a #VALUE! error.
- A determinant of 0 indicates a singular matrix that cannot be inverted.
- The determinant is calculated using LU decomposition for larger matrices.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | 1 | 3 | 5 |
| 2 | 2 | 4 | 6 |
| 3 | 1 | 2 | 2 |

Formula: =MDETERM(A1:C3)

**Result:** 2

The formula calculates the determinant of the 3x3 matrix.
