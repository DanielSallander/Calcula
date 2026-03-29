# SUBTOTAL function

## Introduction
The SUBTOTAL function returns a subtotal in a list or database. It can perform various aggregate calculations (SUM, AVERAGE, COUNT, etc.) and has the unique ability to ignore hidden rows when using function numbers 101-111. This makes SUBTOTAL essential for working with filtered data and automatic subtotals.

SUBTOTAL also ignores other SUBTOTAL formulas nested within the referenced range, preventing double-counting in hierarchical subtotal structures.

## Syntax
```
=SUBTOTAL(function_num, ref1, [ref2], ...)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| function_num | Required | A number 1-11 or 101-111 that specifies the aggregate function to use. |
| ref1 | Required | The first range or reference for which you want the subtotal. |
| ref2, ... | Optional | Additional ranges or references (up to 254). |

## Function Numbers

| Function (includes hidden) | Function (ignores hidden) | Aggregate |
|---|---|---|
| 1 | 101 | AVERAGE |
| 2 | 102 | COUNT |
| 3 | 103 | COUNTA |
| 4 | 104 | MAX |
| 5 | 105 | MIN |
| 6 | 106 | PRODUCT |
| 7 | 107 | STDEV |
| 8 | 108 | STDEVP |
| 9 | 109 | SUM |
| 10 | 110 | VAR |
| 11 | 111 | VARP |

## Remarks
- Function numbers 1-11 include manually hidden rows but ignore rows hidden by other SUBTOTAL results in nested subtotals.
- Function numbers 101-111 ignore all hidden rows, whether hidden manually, by a filter, or by grouping/outline.
- SUBTOTAL ignores any cells that contain other SUBTOTAL formulas to avoid double-counting.
- If function_num is not a valid number (outside 1-11 and 101-111), SUBTOTAL returns a #VALUE! error.

## Example

| | A | B |
|---|---|---|
| 1 | **Product** | **Sales** |
| 2 | Apples | 100 |
| 3 | Bananas | 150 |
| 4 | Cherries | 200 |
| 5 | **Total** | =SUBTOTAL(9, B2:B4) |

**Result:** Cell B5 = **450** (SUM of B2:B4)

If row 3 (Bananas) is hidden by a filter:
- `=SUBTOTAL(9, B2:B4)` still returns **450** (includes hidden rows)
- `=SUBTOTAL(109, B2:B4)` returns **300** (excludes hidden rows)
