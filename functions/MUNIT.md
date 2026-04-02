# MUNIT function

## Introduction
The MUNIT function returns the identity matrix of a specified dimension. The identity matrix has 1s on the main diagonal and 0s everywhere else. It is the matrix equivalent of the number 1 -- multiplying any matrix by the identity matrix returns the original matrix.

## Syntax
```
=MUNIT(dimension)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| dimension | Required | The number of rows and columns for the identity matrix. Must be a positive integer. |

## Remarks
- If **dimension** is less than 1 or non-numeric, MUNIT returns a #VALUE! error.
- If **dimension** is not an integer, it is truncated.
- MUNIT must be entered as an array formula (Ctrl+Shift+Enter in classic mode, or it spills automatically with dynamic arrays).
- The resulting array is a square matrix of the specified dimension.

## Example

Formula: =MUNIT(3)

| | A | B | C |
|---|---|---|---|
| 1 | 1 | 0 | 0 |
| 2 | 0 | 1 | 0 |
| 3 | 0 | 0 | 1 |

**Result:** A 3x3 identity matrix with 1s on the diagonal and 0s elsewhere.
