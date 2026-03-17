# ISODD function

## Introduction

The ISODD function checks whether a number is odd and returns TRUE or FALSE. A number is odd if it is not evenly divisible by 2.

Use ISODD for conditional formatting of alternating rows, data validation, or any logic that depends on whether a value is odd. It is commonly used with ROW() to create alternating row formatting patterns.

## Syntax

```
=ISODD(number)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number | Required | The value to test. If number is not an integer, it is truncated (the decimal portion is removed) before testing. |

## Remarks

- If number is not numeric, ISODD returns a #VALUE! error.
- Decimal numbers are truncated to integers before testing (e.g., 3.7 is treated as 3, which is odd).
- Negative odd numbers return TRUE (e.g., -3 returns TRUE).
- Zero is considered even, so ISODD(0) returns FALSE.

## Example

| | A | B |
|---|---|---|
| 1 | **Number** | **Is Odd?** |
| 2 | 7 | =ISODD(A2) |
| 3 | 4 | =ISODD(A3) |
| 4 | -3 | =ISODD(A4) |
| 5 | 2.9 | =ISODD(A5) |

**Result (B2):** TRUE
**Result (B3):** FALSE
**Result (B4):** TRUE
**Result (B5):** FALSE (2.9 is truncated to 2, which is even)
