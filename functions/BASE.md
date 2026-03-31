# BASE function

## Introduction

The BASE function converts a number into a text representation in a given base (radix). For example, BASE(255, 16) returns "FF" (hexadecimal).

## Syntax

```
=BASE(number, radix, [min_length])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number | Required | The number to convert. Must be a non-negative integer. |
| radix | Required | The base to convert the number to. Must be between 2 and 36. |
| min_length | Optional | The minimum length of the returned string. Padded with leading zeros if needed. |

## Remarks

- If number is negative, a #VALUE! error is returned.
- If radix is less than 2 or greater than 36, a #VALUE! error is returned.
- Digits beyond 9 are represented by the letters A-Z.

## Example

| | A | B |
|---|---|---|
| 1 | **Formula** | **Result** |
| 2 | =BASE(255, 16) | FF |
| 3 | =BASE(10, 2) | 1010 |
| 4 | =BASE(10, 2, 8) | 00001010 |

**Result:** The number is converted to the specified base as text.
