# SKEW.P function

## Introduction
The SKEW.P function returns the skewness of a distribution based on a population. Unlike SKEW, which adjusts for sample bias, SKEW.P calculates skewness assuming the data represents the entire population.

## Syntax
```
=SKEW.P(number1, [number2], ...)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number1 | Required | The first number, cell reference, or range for which to calculate population skewness. |
| number2, ... | Optional | Additional numbers, cell references, or ranges. Up to 255 arguments are supported. |

## Remarks
- Requires at least 3 data points; otherwise, returns #DIV/0!.
- If the standard deviation is zero, returns #DIV/0!.
- Text, logical values, and empty cells in references are ignored.
- SKEW.P uses n in the denominator (population), while SKEW uses the adjusted sample formula.

## Example

| | A |
|---|---|
| 1 | **Values** |
| 2 | 3 |
| 3 | 4 |
| 4 | 5 |
| 5 | 2 |
| 6 | 3 |
| 7 | 4 |
| 8 | 5 |
| 9 | 6 |
| 10 | 4 |
| 11 | 7 |
| 12 | | |
| 13 | **Formula** | **Result** |
| 14 | =SKEW.P(A2:A11) | 0.3032 |

**Result:** Approximately 0.3032 (the population skewness, slightly smaller than the sample skewness from SKEW)
