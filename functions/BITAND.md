# BITAND function

## Introduction
The BITAND function returns a bitwise AND of two numbers. Each bit in the result is 1 only if the corresponding bits in both input numbers are 1. This is fundamental in digital logic and low-level data manipulation.

## Syntax
```
=BITAND(number1, number2)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number1 | Required | A non-negative integer. Must be greater than or equal to 0 and less than 2^48. |
| number2 | Required | A non-negative integer. Must be greater than or equal to 0 and less than 2^48. |

## Remarks
- If either argument is less than 0 or greater than or equal to 2^48 (281474976710656), BITAND returns a #NUM! error.
- If either argument is not an integer, it is truncated.
- If either argument is non-numeric, BITAND returns a #VALUE! error.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | **Number 1** | **Number 2** | **Result** |
| 2 | 13 | 25 | =BITAND(A2, B2) |

**Result:** 9

In binary, 13 is 01101 and 25 is 11001. The bitwise AND is 01001, which equals 9 in decimal.
