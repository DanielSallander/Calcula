# HEX2DEC function

## Introduction
The HEX2DEC function converts a hexadecimal (base 16) number to its decimal (base 10) equivalent. This is useful when translating hex values from programming, networking, or hardware contexts into standard decimal numbers.

## Syntax
```
=HEX2DEC(number)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number | Required | The hexadecimal number you want to convert. Must not contain more than 10 characters (40 bits). The most significant bit is the sign bit; the remaining 39 bits are the magnitude. Negative numbers are represented using two's-complement notation. |

## Remarks
- If **number** is not a valid hexadecimal number, HEX2DEC returns a #NUM! error.
- If **number** contains more than 10 characters, HEX2DEC returns a #NUM! error.

## Example

| | A | B |
|---|---|---|
| 1 | **Hex** | **Decimal** |
| 2 | A5 | =HEX2DEC(A2) |

**Result:** 165

The formula converts hexadecimal A5 to its decimal equivalent, 165.
