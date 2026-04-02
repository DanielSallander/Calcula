# DOLLARDE function

## Introduction

The DOLLARDE function converts a dollar price expressed as a fraction into a dollar price expressed as a decimal number. Many securities, especially U.S. bonds and Treasury notes, are quoted in fractional notation (e.g., 99.16 means 99 and 16/32nds).

Use DOLLARDE to convert fractional bond price quotes into standard decimal format for calculations.

## Syntax

```
=DOLLARDE(fractional_dollar, fraction)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| fractional_dollar | Required | A number expressed as an integer part and a fractional part, separated by a decimal point. |
| fraction | Required | The integer to use as the denominator of the fraction. |

### Remarks

- Fraction must be > 0. If fraction is not an integer, it is truncated.
- If fraction < 0, DOLLARDE returns a #NUM! error.
- If fraction = 0, DOLLARDE returns a #DIV/0! error.
- The decimal portion of fractional_dollar is divided by fraction. For example, DOLLARDE(1.02, 16) means 1 and 2/16 = 1.125.

## Example

### Example 1: Convert fractional bond price to decimal

| | A | B |
|---|---|---|
| 1 | **Fractional to Decimal** | |
| 2 | Fractional price | 99.16 |
| 3 | Denominator | 32 |
| 4 | | |
| 5 | **Formula** | **Result** |
| 6 | =DOLLARDE(B2, B3) | 99.50 |

**Result:** 99.50

The fractional price 99.16 (meaning 99 and 16/32nds) converts to 99.50 in decimal form. The ".16" represents 16/32 = 0.50, so the full decimal price is $99.50 per $100 face value.

### Example 2: Eighths notation

| | A | B |
|---|---|---|
| 1 | **Formula** | **Result** |
| 2 | =DOLLARDE(1.03, 8) | 1.375 |

**Result:** 1.375

The value 1.03 in eighths notation means 1 and 3/8 = 1.375 in decimal.
