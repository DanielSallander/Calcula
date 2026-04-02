# DEC2BIN function

## Introduction
The DEC2BIN function converts a decimal (base 10) number to its binary (base 2) equivalent. This is useful in engineering and computer science applications where binary representation is required.

## Syntax
```
=DEC2BIN(number, [places])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number | Required | The decimal integer you want to convert. Must be between -512 and 511. |
| places | Optional | The number of characters to use in the result. If omitted, DEC2BIN uses the minimum number of characters necessary. Use **places** to pad the result with leading zeros. |

## Remarks
- If **number** is less than -512 or greater than 511, DEC2BIN returns a #NUM! error.
- If **number** is not an integer, it is truncated.
- If **places** is negative or non-numeric, DEC2BIN returns a #NUM! error.
- If **places** is less than the number of characters required, DEC2BIN returns a #NUM! error.
- If **number** is negative, **places** is ignored and the result is a 10-character binary string using two's-complement notation.

## Example

| | A | B |
|---|---|---|
| 1 | **Decimal** | **Binary** |
| 2 | 100 | =DEC2BIN(A2) |

**Result:** 1100100

The formula converts decimal 100 to its binary equivalent, 1100100.
