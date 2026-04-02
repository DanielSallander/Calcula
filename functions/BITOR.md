# BITOR function

## Introduction
The BITOR function returns a bitwise OR of two numbers. Each bit in the result is 1 if at least one of the corresponding bits in the input numbers is 1. This is a fundamental operation in digital logic and bitmask manipulation.

## Syntax
```
=BITOR(number1, number2)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number1 | Required | A non-negative integer. Must be greater than or equal to 0 and less than 2^48. |
| number2 | Required | A non-negative integer. Must be greater than or equal to 0 and less than 2^48. |

## Remarks
- If either argument is less than 0 or greater than or equal to 2^48 (281474976710656), BITOR returns a #NUM! error.
- If either argument is not an integer, it is truncated.
- If either argument is non-numeric, BITOR returns a #VALUE! error.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | **Number 1** | **Number 2** | **Result** |
| 2 | 13 | 25 | =BITOR(A2, B2) |

**Result:** 29

In binary, 13 is 01101 and 25 is 11001. The bitwise OR is 11101, which equals 29 in decimal.
