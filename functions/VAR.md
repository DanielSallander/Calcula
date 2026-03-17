# VAR function

## Introduction

The VAR function estimates the variance of a data set based on a sample. Variance is a measure of how far a set of numbers is spread out from their average value. It is the square of the standard deviation. A larger variance indicates that data points are more spread out.

Use VAR when your data represents a sample taken from a larger population. For example, if you survey 100 customers out of 10,000 about their satisfaction scores, VAR provides the correct estimate of the population's variance. If your data represents the entire population, use VARP instead.

## Syntax

```
=VAR(number1, [number2], ...)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number1 | Required | The first number, cell reference, or range corresponding to a sample of a population. |
| number2, ... | Optional | Additional numbers, cell references, or ranges. Up to 255 arguments are supported. |

### Remarks

- VAR uses the "n-1" method (Bessel's correction), which corrects for bias in sample variance estimation.
- Arguments can be numbers, names, or references that contain numbers.
- Logical values and text representations of numbers typed directly into the argument list are counted.
- If a cell reference argument contains text, logical values, or empty cells, those values are ignored.
- If your data represents the entire population, use VARP instead.
- VAR is equivalent to STDEV squared.

## Example

| | A | B |
|---|---|---|
| 1 | **Daily Website Visitors (Sample Week)** | |
| 2 | 1,200 | |
| 3 | 1,450 | |
| 4 | 980 | |
| 5 | 1,380 | |
| 6 | 1,100 | |
| 7 | | |
| 8 | **Formula** | **Result** |
| 9 | =VAR(A2:A6) | 35,170 |

**Result:** Approximately 35,170

This variance value indicates how much the daily visitor counts in this sample week vary from the average. To interpret it in the same units as the original data, take the square root (which gives the standard deviation).
