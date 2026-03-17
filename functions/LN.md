# LN function

## Introduction
The LN function returns the natural logarithm of a number -- that is, the logarithm to the base e (approximately 2.71828). Natural logarithms are fundamental in calculus, continuous growth models, statistical analysis, and financial mathematics. LN is the inverse of the EXP function: if EXP(x) = y, then LN(y) = x.

## Syntax
```
=LN(number)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number | Required | The positive number for which you want the natural logarithm. |

## Remarks
- If **number** <= 0, LN returns a #NUM! error.
- LN(1) = 0.
- LN(EXP(1)) = 1.
- LN is the inverse of EXP: LN(EXP(x)) = x.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | **Start Value** | **End Value** | **Continuous Growth Rate** |
| 2 | 1000 | 1500 | =LN(B2/A2) |

**Result:** 0.4055

The formula calculates the continuous growth rate from 1,000 to 1,500 using the natural logarithm. This rate (approximately 40.55%) represents the continuously compounded growth factor.
