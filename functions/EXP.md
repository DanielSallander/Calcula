# EXP function

## Introduction
The EXP function returns e raised to the power of a given number, where e is the mathematical constant approximately equal to 2.71828. EXP is the inverse of the LN (natural logarithm) function and is essential for continuous growth and decay models, probability distributions (e.g., normal distribution), and financial calculations involving continuous compounding.

## Syntax
```
=EXP(number)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number | Required | The exponent to which e is raised. |

## Remarks
- EXP(0) = 1.
- EXP(1) returns e (approximately 2.71828).
- EXP(LN(x)) = x for any positive x.
- To raise other bases to a power, use the POWER function.

## Example

| | A | B | C | D |
|---|---|---|---|---|
| 1 | **Principal** | **Rate** | **Time (years)** | **Continuous Value** |
| 2 | 5000 | 0.06 | 3 | =A2*EXP(B2*C2) |

**Result:** 5986.09

The formula calculates the future value using continuous compounding: P * e^(r*t) = 5000 * e^(0.06*3). At a 6% rate over 3 years, a $5,000 investment grows to approximately $5,986.09.
