# STDEVP function

## Introduction

The STDEVP function calculates the standard deviation of a data set based on the entire population. Standard deviation measures how widely values are dispersed from the mean. Unlike STDEV, which estimates the standard deviation from a sample, STDEVP is used when the arguments represent the complete population of data, not just a sample.

Use STDEVP when you have data for every member of the group you are analyzing. For example, if a teacher wants to know the standard deviation of all 30 students' final exam scores in a class, STDEVP is the correct function because the data covers every student in the class, not a sample.

## Syntax

```
=STDEVP(number1, [number2], ...)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number1 | Required | The first number, cell reference, or range corresponding to an entire population. |
| number2, ... | Optional | Additional numbers, cell references, or ranges. Up to 255 arguments are supported. |

### Remarks

- STDEVP uses the "n" method, dividing by n (the number of data points), because it assumes the data is the complete population.
- Arguments can be numbers, names, or references that contain numbers.
- Logical values and text representations of numbers typed directly into the argument list are counted.
- If a cell reference argument contains text, logical values, or empty cells, those values are ignored.
- If your data is a sample from a larger population, use STDEV instead.
- STDEVP is equivalent to the square root of VARP.

## Example

| | A | B |
|---|---|---|
| 1 | **Employee Ratings (All Staff)** | |
| 2 | 4.2 | |
| 3 | 3.8 | |
| 4 | 4.5 | |
| 5 | 3.9 | |
| 6 | 4.1 | |
| 7 | 3.7 | |
| 8 | | |
| 9 | **Formula** | **Result** |
| 10 | =STDEVP(A2:A7) | 0.27 |

**Result:** Approximately 0.27

This tells you that the performance ratings across all employees deviate from the average by about 0.27 points, indicating fairly consistent performance across the team.
