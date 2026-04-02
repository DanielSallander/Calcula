# QUARTILE.EXC function

## Introduction
The QUARTILE.EXC function returns the quartile of a data set based on an exclusive percentile method. It divides data into four equal groups and returns the boundary values between groups.

## Syntax
```
=QUARTILE.EXC(array, quart)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| array | Required | The range of numeric values. |
| quart | Required | The quartile to return: 1 = 25th percentile, 2 = 50th percentile (median), 3 = 75th percentile. |

## Remarks
- If quart is not 1, 2, or 3, returns #NUM!. (0 and 4 are not valid, unlike QUARTILE.INC.)
- If the array is empty, returns #NUM!.
- Text, logical values, and empty cells are ignored.
- QUARTILE.EXC(array, 1) = PERCENTILE.EXC(array, 0.25).
- QUARTILE.EXC(array, 2) = MEDIAN(array).
- Requires at least 3 data points for quart=1 or quart=3.

## Example

| | A |
|---|---|
| 1 | **Values** |
| 2 | 10 |
| 3 | 20 |
| 4 | 30 |
| 5 | 40 |
| 6 | 50 |
| 7 | | |
| 8 | **Formula** | **Result** |
| 9 | =QUARTILE.EXC(A2:A6, 1) | 15 |
| 10 | =QUARTILE.EXC(A2:A6, 3) | 45 |

**Result:** Q1 = 15, Q3 = 45 (the exclusive first and third quartiles)
