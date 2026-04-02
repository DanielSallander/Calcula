# DEC2OCT function

## Introduction
The DEC2OCT function converts a decimal (base 10) number to its octal (base 8) equivalent. This is useful in computing and engineering scenarios where octal notation is preferred, such as Unix file permissions.

## Syntax
```
=DEC2OCT(number, [places])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number | Required | The decimal integer you want to convert. Must be between -536870912 and 536870911. |
| places | Optional | The number of characters to use in the result. If omitted, DEC2OCT uses the minimum number of characters necessary. Use **places** to pad the result with leading zeros. |

## Remarks
- If **number** is outside the allowed range, DEC2OCT returns a #NUM! error.
- If **number** is not an integer, it is truncated.
- If **places** is negative or non-numeric, DEC2OCT returns a #NUM! error.
- If **places** is less than the number of characters required, DEC2OCT returns a #NUM! error.
- If **number** is negative, **places** is ignored and the result is a 10-character octal string using two's-complement notation.

## Example

| | A | B |
|---|---|---|
| 1 | **Decimal** | **Octal** |
| 2 | 58 | =DEC2OCT(A2) |

**Result:** 72

The formula converts decimal 58 to its octal equivalent, 72.
