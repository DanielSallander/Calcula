# DECIMAL function

## Introduction

The DECIMAL function converts a text representation of a number in a given base to a decimal number. This is the inverse of the BASE function.

## Syntax

```
=DECIMAL(text, radix)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| text | Required | The text string containing the number to convert. |
| radix | Required | The base of the number in text. Must be between 2 and 36. |

## Remarks

- The text argument is case-insensitive ("ff" and "FF" both work).
- If text contains characters not valid for the given radix, a #VALUE! error is returned.
- If radix is less than 2 or greater than 36, a #VALUE! error is returned.

## Example

| | A | B |
|---|---|---|
| 1 | **Formula** | **Result** |
| 2 | =DECIMAL("FF", 16) | 255 |
| 3 | =DECIMAL("1010", 2) | 10 |
| 4 | =DECIMAL("ZZ", 36) | 1295 |

**Result:** The text representation is converted from the given base to a decimal number.
