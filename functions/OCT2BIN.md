# OCT2BIN function

## Introduction
The OCT2BIN function converts an octal (base 8) number to its binary (base 2) equivalent. This is useful in digital electronics and computing where conversions between octal and binary representations are needed.

## Syntax
```
=OCT2BIN(number, [places])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number | Required | The octal number you want to convert. Must not contain more than 10 characters. The result must fit within 10 binary digits (decimal equivalent must be between -512 and 511). |
| places | Optional | The number of characters to use in the result. If omitted, OCT2BIN uses the minimum number of characters necessary. Use **places** to pad the result with leading zeros. |

## Remarks
- If **number** is not a valid octal number (contains digits 8 or 9), OCT2BIN returns a #NUM! error.
- If the decimal equivalent of **number** is outside the range -512 to 511, OCT2BIN returns a #NUM! error.
- If **places** is negative or non-numeric, OCT2BIN returns a #NUM! error.
- If **places** is less than the number of characters required, OCT2BIN returns a #NUM! error.
- If **number** is negative, **places** is ignored and the result is a 10-character binary string.

## Example

| | A | B |
|---|---|---|
| 1 | **Octal** | **Binary** |
| 2 | 17 | =OCT2BIN(A2) |

**Result:** 1111

The formula converts octal 17 to its binary equivalent, 1111 (decimal 15).
