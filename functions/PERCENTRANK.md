# PERCENTRANK function

## Introduction
The PERCENTRANK function returns the percentile rank of a value within a dataset as a decimal between 0 and 1. It indicates what percentage of the data falls at or below a given value, useful for comparing a score relative to a group.

## Syntax
```
=PERCENTRANK(array, x, [significance])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| array | Required | The range of numeric values that defines the dataset. |
| x | Required | The value for which to find the percentile rank. |
| significance | Optional | The number of significant digits for the result. Default is 3. |

## Remarks
- If x does not match a value in array, PERCENTRANK interpolates between adjacent values.
- If x is outside the range of values in array, returns #N/A.
- The result ranges from 0 (smallest value) to 1 (largest value).

## Example

| | A | B |
|---|---|---|
| 1 | **Values** | |
| 2 | 10 | |
| 3 | 20 | |
| 4 | 30 | |
| 5 | 40 | |
| 6 | **Pct Rank of 25** | =PERCENTRANK(A2:A5, 25) |

**Result:** 0.416
