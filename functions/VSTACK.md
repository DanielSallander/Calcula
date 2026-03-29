# VSTACK function

## Introduction
The VSTACK function appends arrays vertically (stacks them on top of each other by rows). It is useful for combining data from multiple ranges or tables into a single continuous list.

## Syntax
```
=VSTACK(array1, [array2], ...)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| array1 | Required | The first array or range. |
| array2, ... | Optional | Additional arrays or ranges to stack below the first. |

## Remarks
- If arrays have different numbers of columns, narrower arrays are padded with #N/A on the right.
- Returns a spilled array.
- Useful for consolidating data from multiple sheets or ranges into one list.
- Can combine single values, 1D arrays, and 2D arrays.

## Example

| | A | B |
|---|---|---|
| 1 | 1 | 2 |
| 2 | 3 | 4 |
| 3 | | |
| 4 | 5 | 6 |
| 5 | **Stacked** | =VSTACK(A1:B2, A4:B4) |

**Result:** A 3x2 array: {1, 2; 3, 4; 5, 6}
