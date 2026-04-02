# GAMMA function

## Introduction
The GAMMA function returns the value of the Gamma function for a given number. The Gamma function extends the factorial function to non-integer values, where GAMMA(n) = (n-1)! for positive integers.

## Syntax
```
=GAMMA(number)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number | Required | The value for which to calculate the Gamma function. |

## Remarks
- If number is a negative integer or zero, returns #NUM!.
- If number is a positive integer, GAMMA(number) = (number - 1)!.
- For non-integer negative values, the Gamma function is defined and returns a value.
- GAMMA(0.5) = SQRT(PI) (approximately 1.7725).

## Example

| | A | B |
|---|---|---|
| 1 | **Value** | **Gamma** |
| 2 | 5 | =GAMMA(A2) |
| 3 | 0.5 | =GAMMA(A3) |

**Result:** Row 2 returns 24 (which is 4!). Row 3 returns approximately 1.7725 (which is the square root of pi).
