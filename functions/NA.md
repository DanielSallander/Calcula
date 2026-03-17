# NA function

## Introduction

The NA function returns the #N/A error value. #N/A stands for "not available" and is used to indicate that a value is missing or not applicable.

Use NA to intentionally mark cells as containing no data, which prevents those cells from being accidentally included in calculations. When a cell contains #N/A, most functions that reference it will also return #N/A, making it easy to trace where missing data is affecting your results. This is preferable to leaving cells blank or entering zero, which could be mistakenly treated as valid data.

## Syntax

```
=NA()
```

The NA function takes no arguments. The parentheses are required.

## Remarks

- NA() always returns the #N/A error value.
- You can also type #N/A directly into a cell to achieve the same result.
- Use ISNA to test whether a cell contains #N/A.
- Functions like SUM and AVERAGE will return #N/A if any cell in their range contains #N/A, which helps ensure missing data is not silently ignored.

## Example

| | A | B |
|---|---|---|
| 1 | **Month** | **Sales** |
| 2 | January | 15000 |
| 3 | February | =NA() |
| 4 | March | 18000 |
| 5 | | |
| 6 | **Total** | =SUM(B2:B4) |

**Result (B3):** #N/A
**Result (B6):** #N/A

By marking February's sales as NA(), the SUM in B6 also returns #N/A, alerting you that the total is incomplete due to missing data. This is more informative than a zero or blank, which would silently produce an incorrect total.
