# BITXOR function

## Introduction
The BITXOR function returns a bitwise exclusive OR (XOR) of two numbers. Each bit in the result is 1 if exactly one of the corresponding bits in the input numbers is 1. XOR is widely used in cryptography, checksums, and toggling bits.

## Syntax
```
=BITXOR(number1, number2)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number1 | Required | A non-negative integer. Must be greater than or equal to 0 and less than 2^48. |
| number2 | Required | A non-negative integer. Must be greater than or equal to 0 and less than 2^48. |

## Remarks
- If either argument is less than 0 or greater than or equal to 2^48 (281474976710656), BITXOR returns a #NUM! error.
- If either argument is not an integer, it is truncated.
- If either argument is non-numeric, BITXOR returns a #VALUE! error.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | **Number 1** | **Number 2** | **Result** |
| 2 | 13 | 25 | =BITXOR(A2, B2) |

**Result:** 20

In binary, 13 is 01101 and 25 is 11001. The bitwise XOR is 10100, which equals 20 in decimal.
