# INDEX function

## Introduction

The INDEX function returns a value or reference from within a range or array, given a specific row and column position. It is one of the most versatile lookup functions, frequently combined with MATCH to create powerful dynamic lookups.

Use INDEX when you know the position (row number and/or column number) of the data you want to retrieve. It is commonly used in combination with MATCH for flexible lookups, in array formulas for returning entire rows or columns, and as a more efficient alternative to OFFSET for creating dynamic ranges.

## Syntax

```
=INDEX(array, row_num, [column_num])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| array | Required | A range of cells or an array constant. |
| row_num | Required | The row number in the array from which to return a value. If set to 0 or omitted and column_num is provided, the entire column is returned. |
| column_num | Optional | The column number in the array from which to return a value. If omitted, defaults to 1. If set to 0, the entire row is returned. |

## Remarks

- If both row_num and column_num are specified, INDEX returns the value in the cell at the intersection of the given row and column.
- If array contains only one row or one column, the corresponding row_num or column_num argument is optional.
- If row_num or column_num is out of range, INDEX returns a #REF! error.
- INDEX can return a reference, which can then be used by other functions.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | **Name** | **Q1 Sales** | **Q2 Sales** |
| 2 | Alice | 15000 | 18000 |
| 3 | Bob | 22000 | 19000 |
| 4 | Carol | 17000 | 21000 |
| 5 | | | |
| 6 | **Result** | =INDEX(A2:C4, 2, 3) | |

**Result:** 19000

The formula returns the value at row 2, column 3 of the range A2:C4, which is Bob's Q2 Sales (19000).
