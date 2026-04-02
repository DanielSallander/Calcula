# BESSELJ function

## Introduction
The BESSELJ function returns the Bessel function Jn(x) of the first kind. Bessel functions arise in many problems in physics and engineering involving wave propagation, static potentials, and signal processing with cylindrical symmetry.

## Syntax
```
=BESSELJ(x, n)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| x | Required | The value at which to evaluate the function. |
| n | Required | The order of the Bessel function. Must be a non-negative integer. |

## Remarks
- If **n** is not an integer, it is truncated.
- If **n** is negative, BESSELJ returns a #NUM! error.
- If **x** or **n** is non-numeric, BESSELJ returns a #VALUE! error.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | **x** | **Order** | **Result** |
| 2 | 1.9 | 2 | =BESSELJ(A2, B2) |

**Result:** 0.329926 (approximately)

The formula evaluates the Bessel function of the first kind, order 2, at x = 1.9.
