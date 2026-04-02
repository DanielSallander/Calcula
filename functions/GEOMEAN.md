# GEOMEAN function

## Introduction
The GEOMEAN function returns the geometric mean of a set of positive values. The geometric mean is useful for calculating average growth rates, returns on investment, and other multiplicative processes where values are compounded.

## Syntax
```
=GEOMEAN(number1, [number2], ...)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number1 | Required | The first number, cell reference, or range of positive values. |
| number2, ... | Optional | Additional numbers, cell references, or ranges. Up to 255 arguments are supported. |

## Remarks
- All values must be positive (> 0). If any value is <= 0, returns #NUM!.
- Text, logical values, and empty cells in references are ignored.
- GEOMEAN = (x1 * x2 * ... * xn)^(1/n).
- The geometric mean is always less than or equal to the arithmetic mean.

## Example

| | A |
|---|---|
| 1 | **Annual Returns** |
| 2 | 1.10 |
| 3 | 1.15 |
| 4 | 0.95 |
| 5 | 1.20 |
| 6 | 1.05 |
| 7 | | |
| 8 | **Formula** | **Result** |
| 9 | =GEOMEAN(A2:A6) | 1.0876 |

**Result:** Approximately 1.0876 (the average compound growth factor is about 8.76% per year)
