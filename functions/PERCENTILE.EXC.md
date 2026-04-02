# PERCENTILE.EXC function

## Introduction
The PERCENTILE.EXC function returns the k-th percentile of values in a range using an exclusive interpolation method. Unlike PERCENTILE.INC, this function excludes the 0th and 100th percentiles, making it suitable for statistical sampling where the extremes should not be represented.

## Syntax
```
=PERCENTILE.EXC(array, k)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| array | Required | The range of data that defines relative standing. |
| k | Required | The percentile value. Must be between 0 and 1 (exclusive): 1/(n+1) <= k <= n/(n+1), where n is the number of data points. |

## Remarks
- If k is <= 0 or >= 1, returns #NUM!.
- If k < 1/(n+1) or k > n/(n+1), returns #NUM! because there are not enough data points.
- If the array is empty, returns #NUM!.
- Text, logical values, and empty cells are ignored.
- Uses linear interpolation between data points.

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
| 9 | =PERCENTILE.EXC(A2:A6, 0.25) | 15 |

**Result:** 15 (the 25th percentile using the exclusive method)
