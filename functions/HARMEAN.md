# HARMEAN function

## Introduction
The HARMEAN function returns the harmonic mean of a set of positive values. The harmonic mean is the reciprocal of the arithmetic mean of the reciprocals. It is appropriate for averaging rates, such as speeds, prices per unit, or financial ratios.

## Syntax
```
=HARMEAN(number1, [number2], ...)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number1 | Required | The first number, cell reference, or range of positive values. |
| number2, ... | Optional | Additional numbers, cell references, or ranges. Up to 255 arguments are supported. |

## Remarks
- All values must be positive (> 0). If any value is <= 0, returns #NUM!.
- Text, logical values, and empty cells in references are ignored.
- HARMEAN = n / (1/x1 + 1/x2 + ... + 1/xn).
- The harmonic mean is always less than or equal to the geometric mean.

## Example

| | A |
|---|---|
| 1 | **Speed (km/h)** |
| 2 | 60 |
| 3 | 80 |
| 4 | 100 |
| 5 | | |
| 6 | **Formula** | **Result** |
| 7 | =HARMEAN(A2:A4) | 76.60 |

**Result:** Approximately 76.60 (the harmonic mean speed for equal-distance segments traveled at 60, 80, and 100 km/h)
