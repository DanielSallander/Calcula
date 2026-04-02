# DEC2HEX function

## Introduction
The DEC2HEX function converts a decimal (base 10) number to its hexadecimal (base 16) equivalent. This is widely used in programming and engineering to express values in hexadecimal notation for memory addresses, color codes, and data encoding.

## Syntax
```
=DEC2HEX(number, [places])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number | Required | The decimal integer you want to convert. Must be between -549755813888 and 549755813887. |
| places | Optional | The number of characters to use in the result. If omitted, DEC2HEX uses the minimum number of characters necessary. Use **places** to pad the result with leading zeros. |

## Remarks
- If **number** is outside the allowed range, DEC2HEX returns a #NUM! error.
- If **number** is not an integer, it is truncated.
- If **places** is negative or non-numeric, DEC2HEX returns a #NUM! error.
- If **places** is less than the number of characters required, DEC2HEX returns a #NUM! error.
- If **number** is negative, **places** is ignored and the result is a 10-character hexadecimal string using two's-complement notation.

## Example

| | A | B |
|---|---|---|
| 1 | **Decimal** | **Hex** |
| 2 | 255 | =DEC2HEX(A2, 4) |

**Result:** 00FF

The formula converts decimal 255 to hexadecimal FF and pads the result with leading zeros to 4 characters.
