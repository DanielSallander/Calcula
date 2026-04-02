# HEX2OCT function

## Introduction
The HEX2OCT function converts a hexadecimal (base 16) number to its octal (base 8) equivalent. This is useful when converting between number systems in engineering and computer science applications.

## Syntax
```
=HEX2OCT(number, [places])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number | Required | The hexadecimal number you want to convert. Must not contain more than 10 characters. The result must not require more than 10 octal digits (decimal equivalent must be between -536870912 and 536870911). |
| places | Optional | The number of characters to use in the result. If omitted, HEX2OCT uses the minimum number of characters necessary. Use **places** to pad the result with leading zeros. |

## Remarks
- If **number** is not a valid hexadecimal number, HEX2OCT returns a #NUM! error.
- If the decimal equivalent of **number** is outside the range -536870912 to 536870911, HEX2OCT returns a #NUM! error.
- If **places** is negative or non-numeric, HEX2OCT returns a #NUM! error.
- If **places** is less than the number of characters required, HEX2OCT returns a #NUM! error.
- If **number** is negative, **places** is ignored and the result is a 10-character octal string.

## Example

| | A | B |
|---|---|---|
| 1 | **Hex** | **Octal** |
| 2 | 1F | =HEX2OCT(A2) |

**Result:** 37

The formula converts hexadecimal 1F to its octal equivalent, 37.
