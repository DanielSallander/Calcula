# AREAS function

## Introduction
The AREAS function returns the number of areas in a reference. An area is a contiguous range of cells or a single cell. This function is useful for determining how many separate ranges are combined in a multi-area reference.

## Syntax
```
=AREAS(reference)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| reference | Required | A reference to a cell, range, or multiple areas. Multiple areas must be enclosed in parentheses. |

## Remarks
- A single range like A1:B2 counts as 1 area.
- Multiple ranges like (A1:B2, C3:D4) count as 2 areas.
- Named ranges that refer to multiple areas return the number of areas in the named range.

## Example

| | A | B |
|---|---|---|
| 1 | **Reference** | **Areas** |
| 2 | A1:B2 | =AREAS(A1:B2) |
| 3 | (A1:B2, C3:D4, E5) | =AREAS((A1:B2, C3:D4, E5)) |

**Result:** B2 = 1, B3 = 3
