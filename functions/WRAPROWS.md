# WRAPROWS function

## Introduction
The WRAPROWS function wraps a single row or column of values into a 2D array by filling rows first. After filling a row to the specified count, it wraps to the next row. This is useful for reshaping flat data into a multi-row layout.

## Syntax
```
=WRAPROWS(vector, wrap_count, [pad_with])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| vector | Required | A single row or column of values to wrap. |
| wrap_count | Required | The number of values per row (i.e., the number of columns in the result). |
| pad_with | Optional | The value to pad incomplete rows with. Default is #N/A. |

## Remarks
- The input must be a single row or single column (vector).
- If the total number of values is not evenly divisible by wrap_count, the last row is padded.
- Returns a spilled 2D array.

## Example

| | A | B |
|---|---|---|
| 1 | 1 | =WRAPROWS(A1:A6, 3) |
| 2 | 2 | |
| 3 | 3 | |
| 4 | 4 | |
| 5 | 5 | |
| 6 | 6 | |

**Result:** A 2x3 array: {1, 2, 3; 4, 5, 6}
