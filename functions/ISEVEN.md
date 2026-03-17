# ISEVEN function

## Introduction

The ISEVEN function checks whether a number is even and returns TRUE or FALSE. A number is even if it is evenly divisible by 2.

Use ISEVEN for conditional formatting, alternating-row logic, or any calculation that depends on whether a value is even. It pairs naturally with ISODD for complete parity checking.

## Syntax

```
=ISEVEN(number)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number | Required | The value to test. If number is not an integer, it is truncated (the decimal portion is removed) before testing. |

## Remarks

- If number is not numeric, ISEVEN returns a #VALUE! error.
- Decimal numbers are truncated to integers before testing (e.g., 3.7 is treated as 3, which is odd).
- Negative even numbers return TRUE (e.g., -4 returns TRUE).
- Zero is considered even, so ISEVEN(0) returns TRUE.

## Example

| | A | B |
|---|---|---|
| 1 | **Number** | **Is Even?** |
| 2 | 6 | =ISEVEN(A2) |
| 3 | 5 | =ISEVEN(A3) |
| 4 | 0 | =ISEVEN(A4) |
| 5 | -2 | =ISEVEN(A5) |

**Result (B2):** TRUE
**Result (B3):** FALSE
**Result (B4):** TRUE
**Result (B5):** TRUE
