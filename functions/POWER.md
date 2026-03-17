# POWER function

## Introduction
The POWER function raises a number to a given power (exponent). It is equivalent to the `^` operator but provides a function-based syntax that can be easier to read in complex formulas. POWER is used in compound interest calculations, exponential growth models, physics formulas, and any scenario requiring exponentiation.

## Syntax
```
=POWER(number, power)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number | Required | The base number. |
| power | Required | The exponent to which the base number is raised. |

## Remarks
- POWER(number, 0.5) is equivalent to SQRT(number).
- POWER(number, -1) returns the reciprocal (1/number).
- If **number** is 0 and **power** is negative, POWER returns a #DIV/0! error.
- If **number** is negative and **power** is non-integer, POWER returns a #NUM! error.

## Example

| | A | B | C | D |
|---|---|---|---|---|
| 1 | **Principal** | **Rate** | **Years** | **Future Value** |
| 2 | 10000 | 0.05 | 10 | =A2*POWER(1+B2, C2) |

**Result:** 16288.95

The formula calculates compound interest: 10,000 * (1.05)^10, showing the future value of a $10,000 investment at 5% annual interest over 10 years.
