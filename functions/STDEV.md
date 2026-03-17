# STDEV function

## Introduction

The STDEV function estimates the standard deviation of a data set based on a sample. Standard deviation measures how widely values are dispersed from the mean (average). A high standard deviation indicates that the data points are spread over a wide range of values, while a low standard deviation indicates they are clustered close to the mean.

Use STDEV when your data represents a sample drawn from a larger population. For example, if you measure the delivery times of 50 orders out of thousands, STDEV gives the correct estimate of the population's variability. If your data represents the entire population, use STDEVP instead.

## Syntax

```
=STDEV(number1, [number2], ...)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number1 | Required | The first number, cell reference, or range corresponding to a sample of a population. |
| number2, ... | Optional | Additional numbers, cell references, or ranges. Up to 255 arguments are supported. |

### Remarks

- STDEV uses the "n-1" method (Bessel's correction), dividing by n-1 instead of n, to correct for the bias in estimating a population standard deviation from a sample.
- Arguments can be numbers, names, or references that contain numbers.
- Logical values and text representations of numbers typed directly into the argument list are counted.
- If a cell reference argument contains text, logical values, or empty cells, those values are ignored.
- If your data represents the entire population, use STDEVP instead.
- STDEV is equivalent to the square root of VAR.

## Example

| | A | B |
|---|---|---|
| 1 | **Monthly Sales ($)** | |
| 2 | 12,500 | |
| 3 | 14,200 | |
| 4 | 11,800 | |
| 5 | 15,100 | |
| 6 | 13,400 | |
| 7 | | |
| 8 | **Formula** | **Result** |
| 9 | =STDEV(A2:A6) | 1,268.86 |

**Result:** Approximately 1,268.86

This tells you that the monthly sales figures in this sample typically deviate from the average by about $1,268.86. A manager could use this to understand the variability in monthly revenue.
