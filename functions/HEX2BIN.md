# HEX2BIN function

## Introduction
The HEX2BIN function converts a hexadecimal (base 16) number to its binary (base 2) equivalent. This is commonly used in digital logic design and low-level programming where binary representation is needed.

## Syntax
```
=HEX2BIN(number, [places])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number | Required | The hexadecimal number you want to convert. Must not contain more than 10 characters. The most significant bit is the sign bit; the remaining 39 bits are the magnitude. Negative numbers are represented using two's-complement notation. |
| places | Optional | The number of characters to use in the result. If omitted, HEX2BIN uses the minimum number of characters necessary. Use **places** to pad the result with leading zeros. |

## Remarks
- If **number** is not a valid hexadecimal number, HEX2BIN returns a #NUM! error.
- If the result would require more than 10 binary digits (i.e., the decimal equivalent is outside -512 to 511), HEX2BIN returns a #NUM! error.
- If **places** is negative or non-numeric, HEX2BIN returns a #NUM! error.
- If **places** is less than the number of characters required, HEX2BIN returns a #NUM! error.
- If **number** is negative, **places** is ignored and the result is a 10-character binary string.

## Example

| | A | B |
|---|---|---|
| 1 | **Hex** | **Binary** |
| 2 | FF | =HEX2BIN(A2) |

**Result:** 11111111

The formula converts hexadecimal FF to its binary equivalent, 11111111.
