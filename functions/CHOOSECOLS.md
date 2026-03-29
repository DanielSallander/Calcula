# CHOOSECOLS function

## Introduction
The CHOOSECOLS function returns specified columns from an array or range. It allows you to select, reorder, or duplicate columns from a dataset, making it useful for rearranging table data without helper formulas.

## Syntax
```
=CHOOSECOLS(array, col_num1, [col_num2], ...)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| array | Required | The source array or range. |
| col_num1 | Required | The first column number to return. Negative numbers count from the end. |
| col_num2, ... | Optional | Additional column numbers to return. |

## Remarks
- Returns a spilled array containing only the selected columns.
- Negative column numbers count from the right (-1 = last column).
- Columns can be listed in any order and can be repeated.
- Returns #VALUE! if a column number is 0 or exceeds the array dimensions.

## Example

| | A | B | C | D |
|---|---|---|---|---|
| 1 | Name | Age | City | =CHOOSECOLS(A1:C3, 1, 3) |
| 2 | Alice | 30 | NYC | |
| 3 | Bob | 25 | LA | |

**Result:** D1:E3 contains columns 1 and 3: {Name, City; Alice, NYC; Bob, LA}
