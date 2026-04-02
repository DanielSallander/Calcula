# MMULT function

## Introduction
The MMULT function returns the matrix product of two arrays. The result is an array with the same number of rows as array1 and the same number of columns as array2. Matrix multiplication is fundamental in linear algebra, used for transformations, solving systems of equations, and many engineering applications.

## Syntax
```
=MMULT(array1, array2)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| array1 | Required | The first array to multiply. The number of columns in array1 must equal the number of rows in array2. |
| array2 | Required | The second array to multiply. The number of rows in array2 must equal the number of columns in array1. |

## Remarks
- The number of columns in **array1** must equal the number of rows in **array2**.
- If the dimensions are incompatible, MMULT returns a #VALUE! error.
- If any cell in the arrays is empty or contains text, MMULT returns a #VALUE! error.
- MMULT must be entered as an array formula (Ctrl+Shift+Enter in classic mode, or it spills automatically with dynamic arrays).
- The resulting array has dimensions: rows of array1 x columns of array2.

## Example

| | A | B | C | D |
|---|---|---|---|---|
| 1 | 1 | 2 | 2 | 0 |
| 2 | 3 | 4 | 1 | 1 |

Formula: =MMULT(A1:B2, C1:D2)

| | E | F |
|---|---|---|
| 1 | 4 | 2 |
| 2 | 10 | 4 |

**Result:** A 2x2 matrix. For example, E1 = (1*2 + 2*1) = 4.
