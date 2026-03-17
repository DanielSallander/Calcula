# PERCENTILE function

## Introduction

The PERCENTILE function returns the k-th percentile of values in a range. Percentiles are used to understand the distribution of data by indicating the value below which a given percentage of observations fall. For example, the 90th percentile is the value below which 90% of the data lies.

PERCENTILE is commonly used in performance analysis, salary benchmarking, and quality control. For example, an HR department might use PERCENTILE to determine the 75th percentile salary in order to set competitive compensation levels.

## Syntax

```
=PERCENTILE(array, k)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| array | Required | The range or array of data that defines relative standing. |
| k | Required | The percentile value, between 0 and 1 inclusive. For example, 0.25 represents the 25th percentile, 0.5 represents the 50th percentile (median), and 0.9 represents the 90th percentile. |

### Remarks

- If k is not between 0 and 1 (inclusive), PERCENTILE returns the #NUM! error.
- If the array is empty, PERCENTILE returns the #NUM! error.
- If k is 0, PERCENTILE returns the smallest value. If k is 1, it returns the largest value.
- If k is not a multiple of 1/(n-1), PERCENTILE interpolates between data points to determine the value at the k-th percentile.
- PERCENTILE(array, 0.5) is equivalent to MEDIAN(array).

## Example

| | A | B |
|---|---|---|
| 1 | **Annual Salary ($)** | |
| 2 | 42,000 | |
| 3 | 55,000 | |
| 4 | 48,000 | |
| 5 | 62,000 | |
| 6 | 71,000 | |
| 7 | 53,000 | |
| 8 | 58,000 | |
| 9 | | |
| 10 | **Formula** | **Result** |
| 11 | =PERCENTILE(A2:A8, 0.25) | 48,000 |
| 12 | =PERCENTILE(A2:A8, 0.50) | 55,000 |
| 13 | =PERCENTILE(A2:A8, 0.75) | 62,000 |
| 14 | =PERCENTILE(A2:A8, 0.90) | 68,300 |

**Result:** The 25th percentile salary is $48,000, the median is $55,000, the 75th percentile is $62,000, and the 90th percentile is $68,300.

An HR team can use these values to understand salary distribution and set benchmarks such as "we target compensation at the 75th percentile of the market."
