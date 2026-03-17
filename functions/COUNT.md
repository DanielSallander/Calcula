# COUNT function

## Introduction
The COUNT function counts the number of cells in a range that contain numeric values. It is useful for determining how many entries exist in a dataset, verifying data completeness, or counting numeric records while ignoring text and blanks.

COUNT only tallies cells with numbers (including dates, which are stored as numbers internally). To count all non-empty cells regardless of type, use COUNTA instead.

## Syntax
```
=COUNT(value1, [value2], ...)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| value1 | Required | The first cell reference, range, or value to count. |
| value2, ... | Optional | Additional references or values. Up to 255 arguments. |

## Remarks
- Cells containing text, logical values (TRUE/FALSE), or errors are not counted.
- Empty cells are not counted.
- If a number is typed directly as an argument (e.g., `COUNT(1, 2, 3)`), each value is counted.
- Dates and times are counted because they are stored as numeric values.

## Example

| | A | B |
|---|---|---|
| 1 | **Employee** | **Score** |
| 2 | Alice | 87 |
| 3 | Bob | N/A |
| 4 | Carol | 92 |
| 5 | Dave | 78 |
| 6 | Eve | |
| 7 | **Scores Received** | =COUNT(B2:B6) |

**Result:** 3

The formula counts only cells B2, B4, and B5 because they contain numeric values. B3 contains text ("N/A") and B6 is empty, so they are excluded.
