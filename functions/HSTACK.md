# HSTACK function

## Introduction
The HSTACK function appends arrays horizontally (stacks them side by side by columns). It is useful for combining data from multiple ranges into a wider table or joining columns from different sources.

## Syntax
```
=HSTACK(array1, [array2], ...)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| array1 | Required | The first array or range. |
| array2, ... | Optional | Additional arrays or ranges to stack to the right of the first. |

## Remarks
- If arrays have different numbers of rows, shorter arrays are padded with #N/A at the bottom.
- Returns a spilled array.
- Useful for combining columns from different tables or creating side-by-side comparisons.
- Can combine single values, 1D arrays, and 2D arrays.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | 1 | | 10 |
| 2 | 2 | | 20 |
| 3 | **Joined** | =HSTACK(A1:A2, C1:C2) | |

**Result:** A 2x2 array: {1, 10; 2, 20}
