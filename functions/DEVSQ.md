# DEVSQ function

## Introduction
The DEVSQ function returns the sum of squares of deviations of data points from their sample mean. It is used in many statistical calculations, including variance and regression analysis.

## Syntax
```
=DEVSQ(number1, [number2], ...)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number1 | Required | The first number, cell reference, or range. |
| number2, ... | Optional | Additional numbers, cell references, or ranges. Up to 255 arguments are supported. |

## Remarks
- Text, logical values, and empty cells in references are ignored.
- DEVSQ = SUM((xi - mean)^2) for each data point xi.
- The sample variance is DEVSQ / (n - 1), where n is the number of data points.

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
| 9 | =DEVSQ(A2:A6) | 10 |

**Result:** 10 (the sum of squared deviations from the mean of 6)
