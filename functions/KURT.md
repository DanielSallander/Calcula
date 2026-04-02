# KURT function

## Introduction
The KURT function returns the kurtosis of a data set. Kurtosis measures the "tailedness" of a distribution relative to a normal distribution. A positive kurtosis (leptokurtic) indicates heavier tails and a sharper peak, while a negative kurtosis (platykurtic) indicates lighter tails and a flatter peak.

## Syntax
```
=KURT(number1, [number2], ...)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number1 | Required | The first number, cell reference, or range for which to calculate kurtosis. |
| number2, ... | Optional | Additional numbers, cell references, or ranges. Up to 255 arguments are supported. |

## Remarks
- Requires at least 4 data points; otherwise, returns #DIV/0!.
- If the standard deviation is zero, returns #DIV/0!.
- Text, logical values, and empty cells in references are ignored.
- A normal distribution has a kurtosis of 0 (excess kurtosis). Values greater than 0 indicate heavier tails.

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
| 14 | =KURT(A2:A11) | -0.1518 |

**Result:** Approximately -0.1518 (slightly platykurtic, meaning the distribution has lighter tails than a normal distribution)
