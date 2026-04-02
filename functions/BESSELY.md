# BESSELY function

## Introduction
The BESSELY function returns the Bessel function Yn(x) of the second kind (also called the Neumann function or Weber function). These functions appear in problems involving cylindrical boundaries where the solution must include both types of Bessel functions.

## Syntax
```
=BESSELY(x, n)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| x | Required | The value at which to evaluate the function. Must be positive. |
| n | Required | The order of the Bessel function. Must be a non-negative integer. |

## Remarks
- If **x** is less than or equal to 0, BESSELY returns a #NUM! error.
- If **n** is not an integer, it is truncated.
- If **n** is negative, BESSELY returns a #NUM! error.
- If **x** or **n** is non-numeric, BESSELY returns a #VALUE! error.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | **x** | **Order** | **Result** |
| 2 | 2.5 | 1 | =BESSELY(A2, B2) |

**Result:** 0.145918 (approximately)

The formula evaluates the Bessel function of the second kind, order 1, at x = 2.5.
