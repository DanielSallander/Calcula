# WRAPCOLS function

## Introduction
The WRAPCOLS function wraps a single row or column of values into a 2D array by filling columns first. After filling a column to the specified count, it wraps to the next column. This is useful for reshaping flat data into a multi-column layout.

## Syntax
```
=WRAPCOLS(vector, wrap_count, [pad_with])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| vector | Required | A single row or column of values to wrap. |
| wrap_count | Required | The number of values per column (i.e., the number of rows in the result). |
| pad_with | Optional | The value to pad incomplete columns with. Default is #N/A. |

## Remarks
- The input must be a single row or single column (vector).
- If the total number of values is not evenly divisible by wrap_count, the last column is padded.
- Returns a spilled 2D array.

## Example

| | A | B |
|---|---|---|
| 1 | 1 | =WRAPCOLS(A1:A6, 3) |
| 2 | 2 | |
| 3 | 3 | |
| 4 | 4 | |
| 5 | 5 | |
| 6 | 6 | |

**Result:** A 3x2 array: {1, 4; 2, 5; 3, 6}
