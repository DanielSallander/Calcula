# BESSELK function

## Introduction
The BESSELK function returns the modified Bessel function Kn(x), which is equivalent to the Bessel functions evaluated for purely imaginary arguments. These functions are used in engineering problems involving exponential decay in cylindrical coordinates, such as electromagnetic field problems.

## Syntax
```
=BESSELK(x, n)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| x | Required | The value at which to evaluate the function. Must be positive. |
| n | Required | The order of the Bessel function. Must be a non-negative integer. |

## Remarks
- If **x** is less than or equal to 0, BESSELK returns a #NUM! error.
- If **n** is not an integer, it is truncated.
- If **n** is negative, BESSELK returns a #NUM! error.
- If **x** or **n** is non-numeric, BESSELK returns a #VALUE! error.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | **x** | **Order** | **Result** |
| 2 | 1.5 | 1 | =BESSELK(A2, B2) |

**Result:** 0.277388 (approximately)

The formula evaluates the modified Bessel function of the second kind, order 1, at x = 1.5.
