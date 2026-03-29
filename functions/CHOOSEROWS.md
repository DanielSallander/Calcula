# CHOOSEROWS function

## Introduction
The CHOOSEROWS function returns specified rows from an array or range. It allows you to select, reorder, or duplicate rows from a dataset, making it useful for extracting specific records or reversing row order.

## Syntax
```
=CHOOSEROWS(array, row_num1, [row_num2], ...)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| array | Required | The source array or range. |
| row_num1 | Required | The first row number to return. Negative numbers count from the end. |
| row_num2, ... | Optional | Additional row numbers to return. |

## Remarks
- Returns a spilled array containing only the selected rows.
- Negative row numbers count from the bottom (-1 = last row).
- Rows can be listed in any order and can be repeated.
- Returns #VALUE! if a row number is 0 or exceeds the array dimensions.

## Example

| | A | B |
|---|---|---|
| 1 | Alice | 100 |
| 2 | Bob | 200 |
| 3 | Carol | 300 |
| 4 | **Last and First** | =CHOOSEROWS(A1:B3, -1, 1) |

**Result:** Row 4-5 contains: {Carol, 300; Alice, 100}
