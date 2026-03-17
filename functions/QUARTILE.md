# QUARTILE function

## Introduction

The QUARTILE function returns the quartile of a data set. Quartiles divide a sorted data set into four equal groups, each containing 25% of the data. This function is useful for understanding the spread and distribution of data, and is commonly used in statistical summaries and box-and-whisker plots.

Use QUARTILE when you need to quickly segment data into performance tiers, identify outlier thresholds, or produce summary statistics. For example, a manager might classify products into top 25%, upper-middle, lower-middle, and bottom 25% based on sales performance.

## Syntax

```
=QUARTILE(array, quart)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| array | Required | The range or array of numeric values for which you want the quartile value. |
| quart | Required | An integer indicating which quartile value to return. |

### Quart values

| quart | Returns |
|-------|---------|
| 0 | Minimum value (equivalent to MIN) |
| 1 | First quartile (25th percentile) |
| 2 | Second quartile (50th percentile, equivalent to MEDIAN) |
| 3 | Third quartile (75th percentile) |
| 4 | Maximum value (equivalent to MAX) |

### Remarks

- If quart is not 0, 1, 2, 3, or 4, QUARTILE returns the #NUM! error.
- If the array is empty, QUARTILE returns the #NUM! error.
- QUARTILE(array, 0) is equivalent to MIN(array).
- QUARTILE(array, 2) is equivalent to MEDIAN(array).
- QUARTILE(array, 4) is equivalent to MAX(array).

## Example

| | A | B |
|---|---|---|
| 1 | **Order Processing Time (hours)** | |
| 2 | 2.5 | |
| 3 | 4.1 | |
| 4 | 1.8 | |
| 5 | 3.6 | |
| 6 | 5.2 | |
| 7 | 2.9 | |
| 8 | 3.3 | |
| 9 | 6.0 | |
| 10 | | |
| 11 | **Formula** | **Result** |
| 12 | =QUARTILE(A2:A9, 0) | 1.8 |
| 13 | =QUARTILE(A2:A9, 1) | 2.6 |
| 14 | =QUARTILE(A2:A9, 2) | 3.3 |
| 15 | =QUARTILE(A2:A9, 3) | 4.4 |
| 16 | =QUARTILE(A2:A9, 4) | 6.0 |

**Result:** The minimum processing time is 1.8 hours, Q1 is 2.6 hours, the median is 3.3 hours, Q3 is 4.4 hours, and the maximum is 6.0 hours.

The interquartile range (Q3 - Q1 = 1.8 hours) tells you that the middle 50% of orders are processed within a 1.8-hour window. Orders above Q3 might be flagged for process improvement investigation.
