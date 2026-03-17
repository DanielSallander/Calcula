# GCD function

## Introduction
The GCD function returns the greatest common divisor of two or more integers. The greatest common divisor is the largest positive integer that divides all the given numbers without a remainder. GCD is useful in simplifying fractions, scheduling problems (finding common intervals), and engineering calculations involving gear ratios or tile layouts.

## Syntax
```
=GCD(number1, number2, ...)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number1 | Required | The first integer. |
| number2, ... | Required | Additional integers. At least two numbers are needed. Up to 255 arguments. |

## Remarks
- If any argument is non-numeric, GCD returns a #VALUE! error.
- If any argument is negative, GCD returns a #NUM! error.
- Decimal portions of arguments are truncated before calculation.
- GCD(0, n) returns n.
- GCD(0, 0) returns 0.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | **Numerator** | **Denominator** | **GCD** |
| 2 | 36 | 48 | =GCD(A2, B2) |

**Result:** 12

The GCD of 36 and 48 is 12. You could use this to simplify the fraction 36/48 to 3/4 by dividing both the numerator and denominator by the GCD.
