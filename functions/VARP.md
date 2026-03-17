# VARP function

## Introduction

The VARP function calculates the variance of a data set based on the entire population. Unlike VAR, which estimates variance from a sample, VARP is used when the arguments represent the complete set of data -- the entire population, not just a subset.

Use VARP when you have every data point in the group you are studying. For example, if you want to measure the variance of production output across all 5 machines in a factory, VARP is the correct choice because you have data for every machine, not a sample.

## Syntax

```
=VARP(number1, [number2], ...)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number1 | Required | The first number, cell reference, or range corresponding to an entire population. |
| number2, ... | Optional | Additional numbers, cell references, or ranges. Up to 255 arguments are supported. |

### Remarks

- VARP uses the "n" method, dividing by n (the total number of data points), because it assumes the data is the complete population.
- Arguments can be numbers, names, or references that contain numbers.
- Logical values and text representations of numbers typed directly into the argument list are counted.
- If a cell reference argument contains text, logical values, or empty cells, those values are ignored.
- If your data is a sample from a larger population, use VAR instead.
- VARP is equivalent to STDEVP squared.

## Example

| | A | B |
|---|---|---|
| 1 | **Warehouse Inventory (All Locations)** | |
| 2 | 5,400 | |
| 3 | 4,800 | |
| 4 | 6,100 | |
| 5 | 5,200 | |
| 6 | | |
| 7 | **Formula** | **Result** |
| 8 | =VARP(A2:A5) | 222,500 |

**Result:** Approximately 222,500

This is the population variance of inventory levels across all four warehouse locations. Taking the square root gives the population standard deviation (STDEVP), which would be approximately 471.7 units.
