# TRANSPOSE function

## Introduction

The TRANSPOSE function converts a vertical range of cells to a horizontal range, or vice versa. It flips the rows and columns of an array, so the first row becomes the first column, the second row becomes the second column, and so on.

Use TRANSPOSE when you need to restructure data layout, such as converting a row of headers into a vertical list, pivoting data for charting purposes, or reorganizing imported data that arrived in the wrong orientation. TRANSPOSE must be entered as an array formula when used with cell ranges.

## Syntax

```
=TRANSPOSE(array)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| array | Required | The range or array to transpose. Rows become columns and columns become rows. |

## Remarks

- The resulting range must have the same number of rows as the source has columns, and the same number of columns as the source has rows.
- TRANSPOSE must be entered as an array formula (Ctrl+Shift+Enter) when entered in a multi-cell range, or it can spill automatically if dynamic arrays are supported.
- If the destination area is a different size than the transposed result, extra cells will show #N/A errors or be ignored.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | **Q1** | **Q2** | **Q3** |
| 2 | 100 | 200 | 300 |
| 3 | | | |
| 4 | **Transposed** | | |
| 5 | =TRANSPOSE(A1:C2) | | |

**Result:**

| | A | B |
|---|---|---|
| 5 | Q1 | 100 |
| 6 | Q2 | 200 |
| 7 | Q3 | 300 |

The 2-row by 3-column range is transposed into a 3-row by 2-column range, with the original rows now appearing as columns.
