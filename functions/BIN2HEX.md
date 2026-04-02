# BIN2HEX function

## Introduction
The BIN2HEX function converts a binary (base 2) number to its hexadecimal (base 16) equivalent. This is commonly used in engineering and programming when translating between number systems.

## Syntax
```
=BIN2HEX(number, [places])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number | Required | The binary number you want to convert. Must be no more than 10 characters (10 bits). The most significant bit is the sign bit; the remaining 9 bits are the magnitude. Negative numbers are represented using two's-complement notation. |
| places | Optional | The number of characters to use in the result. If omitted, BIN2HEX uses the minimum number of characters necessary. Use **places** to pad the result with leading zeros. |

## Remarks
- If **number** is not a valid binary number, BIN2HEX returns a #NUM! error.
- If **number** contains more than 10 characters, BIN2HEX returns a #NUM! error.
- If **places** is negative or non-numeric, BIN2HEX returns a #NUM! error.
- If **places** is less than the number of characters required, BIN2HEX returns a #NUM! error.
- If **number** is negative, **places** is ignored and the result is a 10-character hexadecimal string.

## Example

| | A | B |
|---|---|---|
| 1 | **Binary** | **Hex** |
| 2 | 11111011 | =BIN2HEX(A2, 4) |

**Result:** 00FB

The formula converts binary 11111011 to hexadecimal FB and pads the result with leading zeros to 4 characters.
