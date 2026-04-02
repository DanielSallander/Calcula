# AVEDEV function

## Introduction
The AVEDEV function returns the average of the absolute deviations of data points from their mean. It is a measure of the variability in a data set that is less sensitive to outliers than the standard deviation.

## Syntax
```
=AVEDEV(number1, [number2], ...)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number1 | Required | The first number, cell reference, or range for which to calculate the average deviation. |
| number2, ... | Optional | Additional numbers, cell references, or ranges. Up to 255 arguments are supported. |

## Remarks
- Text, logical values, and empty cells in references are ignored.
- AVEDEV = (1/n) * SUM(ABS(xi - mean)) for each data point xi.
- Arguments that are error values cause AVEDEV to return an error.

## Example

| | A |
|---|---|
| 1 | **Values** |
| 2 | 4 |
| 3 | 5 |
| 4 | 6 |
| 5 | 7 |
| 6 | 8 |
| 7 | | |
| 8 | **Formula** | **Result** |
| 9 | =AVEDEV(A2:A6) | 1.2 |

**Result:** 1.2 (on average, the data points deviate 1.2 units from the mean of 6)
