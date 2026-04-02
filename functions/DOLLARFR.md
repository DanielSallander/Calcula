# DOLLARFR function

## Introduction

The DOLLARFR function converts a dollar price expressed as a decimal number into a dollar price expressed as a fraction. This is the inverse of DOLLARDE. Many U.S. bond markets quote prices in fractions (such as 32nds), and this function converts decimal prices back to that notation.

Use DOLLARFR to convert a calculated decimal bond price into the fractional quote format used in bond markets.

## Syntax

```
=DOLLARFR(decimal_dollar, fraction)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| decimal_dollar | Required | A decimal number. |
| fraction | Required | The integer to use as the denominator of the fraction. |

### Remarks

- Fraction must be > 0. If fraction is not an integer, it is truncated.
- If fraction < 0, DOLLARFR returns a #NUM! error.
- If fraction = 0, DOLLARFR returns a #DIV/0! error.
- The decimal portion of the result represents the numerator of the fraction. For example, DOLLARFR(1.125, 16) returns 1.02, meaning 1 and 2/16.

## Example

### Example 1: Convert decimal bond price to fractional

| | A | B |
|---|---|---|
| 1 | **Decimal to Fractional** | |
| 2 | Decimal price | 99.50 |
| 3 | Denominator | 32 |
| 4 | | |
| 5 | **Formula** | **Result** |
| 6 | =DOLLARFR(B2, B3) | 99.16 |

**Result:** 99.16

The decimal price 99.50 converts to 99.16 in 32nds notation, meaning 99 and 16/32nds. The ".16" after the decimal represents the numerator of the fraction with 32 as the denominator.

### Example 2: Eighths notation

| | A | B |
|---|---|---|
| 1 | **Formula** | **Result** |
| 2 | =DOLLARFR(1.375, 8) | 1.03 |

**Result:** 1.03

The decimal value 1.375 converts to 1.03 in eighths notation, meaning 1 and 3/8.
