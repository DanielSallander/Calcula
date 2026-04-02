# TRIMMEAN function

## Introduction
The TRIMMEAN function returns the mean of the interior of a data set, after excluding a percentage of data points from the top and bottom. It is useful for calculating an average that is not influenced by extreme outliers.

## Syntax
```
=TRIMMEAN(array, percent)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| array | Required | The range of values to trim and average. |
| percent | Required | The total fraction of data points to exclude. Must be between 0 and 1 (inclusive). For example, 0.2 removes the top 10% and bottom 10%. |

## Remarks
- If percent < 0 or > 1, returns #NUM!.
- The number of excluded data points is calculated as FLOOR(n * percent / 2) from each end, where n is the number of data points.
- If percent = 0, TRIMMEAN equals AVERAGE.
- Text, logical values, and empty cells are ignored.

## Example

| | A |
|---|---|
| 1 | **Values** |
| 2 | 1 |
| 3 | 3 |
| 4 | 5 |
| 5 | 7 |
| 6 | 9 |
| 7 | 11 |
| 8 | 13 |
| 9 | 15 |
| 10 | 17 |
| 11 | 100 |
| 12 | | |
| 13 | **Formula** | **Result** |
| 14 | =TRIMMEAN(A2:A11, 0.2) | 10 |

**Result:** 10 (the mean after trimming the top and bottom 10% of values, removing the outliers 1 and 100)
