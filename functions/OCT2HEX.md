# OCT2HEX function

## Introduction
The OCT2HEX function converts an octal (base 8) number to its hexadecimal (base 16) equivalent. This is useful in engineering and programming when translating between these two common number systems.

## Syntax
```
=OCT2HEX(number, [places])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number | Required | The octal number you want to convert. Must not contain more than 10 characters. |
| places | Optional | The number of characters to use in the result. If omitted, OCT2HEX uses the minimum number of characters necessary. Use **places** to pad the result with leading zeros. |

## Remarks
- If **number** is not a valid octal number (contains digits 8 or 9), OCT2HEX returns a #NUM! error.
- If **number** contains more than 10 characters, OCT2HEX returns a #NUM! error.
- If **places** is negative or non-numeric, OCT2HEX returns a #NUM! error.
- If **places** is less than the number of characters required, OCT2HEX returns a #NUM! error.
- If **number** is negative, **places** is ignored and the result is a 10-character hexadecimal string.

## Example

| | A | B |
|---|---|---|
| 1 | **Octal** | **Hex** |
| 2 | 72 | =OCT2HEX(A2) |

**Result:** 3A

The formula converts octal 72 to its hexadecimal equivalent, 3A (decimal 58).
