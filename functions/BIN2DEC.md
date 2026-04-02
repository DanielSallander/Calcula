# BIN2DEC function

## Introduction
The BIN2DEC function converts a binary (base 2) number to its decimal (base 10) equivalent. This is useful in engineering and computer science scenarios where you need to translate binary representations into standard decimal values.

## Syntax
```
=BIN2DEC(number)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number | Required | The binary number you want to convert. Must be no more than 10 characters (10 bits). The most significant bit is the sign bit; the remaining 9 bits are the magnitude. Negative numbers are represented using two's-complement notation. |

## Remarks
- If **number** is not a valid binary number (contains digits other than 0 and 1), BIN2DEC returns a #NUM! error.
- If **number** contains more than 10 characters (10 bits), BIN2DEC returns a #NUM! error.
- The input can range from 1000000000 (−512 in decimal) to 0111111111 (511 in decimal).

## Example

| | A | B |
|---|---|---|
| 1 | **Binary** | **Decimal** |
| 2 | 1100100 | =BIN2DEC(A2) |

**Result:** 100

The formula converts the binary value 1100100 to its decimal equivalent, 100.
