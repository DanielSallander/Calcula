# QUOTIENT function

## Introduction

The QUOTIENT function returns the integer portion of a division. Use this function when you want to discard the remainder of a division.

## Syntax

```
=QUOTIENT(numerator, denominator)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| numerator | Required | The dividend. |
| denominator | Required | The divisor. |

## Remarks

- If denominator is 0, QUOTIENT returns a #DIV/0! error.
- The result is truncated toward zero (the fractional part is discarded).

## Example

| | A | B |
|---|---|---|
| 1 | **Formula** | **Result** |
| 2 | =QUOTIENT(5, 2) | 2 |
| 3 | =QUOTIENT(10, 3) | 3 |
| 4 | =QUOTIENT(-10, 3) | -3 |

**Result:** QUOTIENT returns the integer part of the division, discarding any remainder.
