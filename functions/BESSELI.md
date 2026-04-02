# BESSELI function

## Introduction
The BESSELI function returns the modified Bessel function In(x), which is equivalent to the Bessel function evaluated for purely imaginary arguments. Modified Bessel functions are used in engineering problems involving cylindrical symmetry with exponential-type behavior, such as heat conduction and vibration analysis.

## Syntax
```
=BESSELI(x, n)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| x | Required | The value at which to evaluate the function. |
| n | Required | The order of the Bessel function. Must be a non-negative integer. |

## Remarks
- If **n** is not an integer, it is truncated.
- If **n** is negative, BESSELI returns a #NUM! error.
- If **x** or **n** is non-numeric, BESSELI returns a #VALUE! error.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | **x** | **Order** | **Result** |
| 2 | 1.5 | 1 | =BESSELI(A2, B2) |

**Result:** 0.981666 (approximately)

The formula evaluates the modified Bessel function of the first kind, order 1, at x = 1.5.
