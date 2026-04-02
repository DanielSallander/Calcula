# PERCENTRANK.EXC function

## Introduction
The PERCENTRANK.EXC function returns the rank of a value in a data set as a percentage (0 to 1, exclusive) of the data set. It uses an exclusive method where the rank is calculated as position / (n+1).

## Syntax
```
=PERCENTRANK.EXC(array, x, [significance])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| array | Required | The range of data with numeric values that defines relative standing. |
| x | Required | The value for which to find the percentile rank. |
| significance | Optional | The number of significant digits for the returned percentage. Default is 3. |

## Remarks
- If the array is empty, returns #NUM!.
- If x is less than the minimum or greater than the maximum value in the array, returns #N/A.
- Text, logical values, and empty cells are ignored.
- PERCENTRANK.EXC excludes 0 and 1 from the possible return values, unlike PERCENTRANK.INC.

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
| 9 | =PERCENTRANK.EXC(A2:A6, 30) | 0.500 |

**Result:** 0.500 (the value 30 is at the 50th percentile using the exclusive method)
