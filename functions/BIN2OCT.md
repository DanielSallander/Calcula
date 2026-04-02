# BIN2OCT function

## Introduction
The BIN2OCT function converts a binary (base 2) number to its octal (base 8) equivalent. This is useful in engineering contexts where octal representation is needed for permissions, memory addresses, or other technical data.

## Syntax
```
=BIN2OCT(number, [places])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number | Required | The binary number you want to convert. Must be no more than 10 characters (10 bits). The most significant bit is the sign bit; the remaining 9 bits are the magnitude. Negative numbers are represented using two's-complement notation. |
| places | Optional | The number of characters to use in the result. If omitted, BIN2OCT uses the minimum number of characters necessary. Use **places** to pad the result with leading zeros. |

## Remarks
- If **number** is not a valid binary number, BIN2OCT returns a #NUM! error.
- If **number** contains more than 10 characters, BIN2OCT returns a #NUM! error.
- If **places** is negative or non-numeric, BIN2OCT returns a #NUM! error.
- If **places** is less than the number of characters required, BIN2OCT returns a #NUM! error.
- If **number** is negative, **places** is ignored and the result is a 10-character octal string.

## Example

| | A | B |
|---|---|---|
| 1 | **Binary** | **Octal** |
| 2 | 1001 | =BIN2OCT(A2, 3) |

**Result:** 011

The formula converts binary 1001 to octal 11 and pads the result with a leading zero to 3 characters.
