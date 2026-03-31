# SUMSQ function

## Introduction

The SUMSQ function returns the sum of the squares of its arguments. This is equivalent to calculating number1^2 + number2^2 + ... for all arguments.

## Syntax

```
=SUMSQ(number1, [number2], ...)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number1 | Required | The first number or range to square and sum. |
| number2, ... | Optional | Additional numbers or ranges to square and sum. Up to 255 arguments. |

## Remarks

- Arguments can be numbers, names, ranges, or arrays.
- Text and logical values are ignored when passed as part of a range.

## Example

| | A | B |
|---|---|---|
| 1 | **Value** | |
| 2 | 3 | |
| 3 | 4 | |

**Formula:** `=SUMSQ(A2:A3)`

**Result:** **25** - Calculates 3^2 + 4^2 = 9 + 16 = 25.
