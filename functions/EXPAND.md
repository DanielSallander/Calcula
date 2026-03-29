# EXPAND function

## Introduction
The EXPAND function pads an array to specified dimensions by adding rows and/or columns filled with a pad value. It is useful for ensuring arrays have consistent dimensions before combining them with other functions.

## Syntax
```
=EXPAND(array, rows, [columns], [pad_with])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| array | Required | The source array or range to expand. |
| rows | Required | The number of rows in the result. Must be >= the current row count. |
| columns | Optional | The number of columns in the result. Must be >= the current column count. |
| pad_with | Optional | The value to fill new cells with. Default is #N/A. |

## Remarks
- Returns #VALUE! if rows or columns is less than the existing dimensions of the array.
- The original data occupies the top-left corner of the expanded result.
- Commonly used with VSTACK or HSTACK to align arrays of different sizes.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | 1 | 2 | =EXPAND(A1:B2, 3, 3, 0) |
| 2 | 3 | 4 | |

**Result:** A 3x3 array: {1, 2, 0; 3, 4, 0; 0, 0, 0}
