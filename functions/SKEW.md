# SKEW function

## Introduction
The SKEW function returns the skewness of a distribution based on a sample. Skewness measures the asymmetry of a distribution around its mean. A positive skew indicates a longer right tail, while a negative skew indicates a longer left tail.

## Syntax
```
=SKEW(number1, [number2], ...)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number1 | Required | The first number, cell reference, or range for which to calculate skewness. |
| number2, ... | Optional | Additional numbers, cell references, or ranges. Up to 255 arguments are supported. |

## Remarks
- Requires at least 3 data points; otherwise, returns #DIV/0!.
- If the standard deviation is zero, returns #DIV/0!.
- Text, logical values, and empty cells in references are ignored.
- A perfectly symmetric distribution has a skewness of 0.
- For population skewness, use SKEW.P.

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
| 14 | =SKEW(A2:A11) | 0.3595 |

**Result:** Approximately 0.3595 (a slight positive skew, indicating the distribution tail extends slightly more to the right)
