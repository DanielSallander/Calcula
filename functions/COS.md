# COS function

## Introduction
The COS function returns the cosine of an angle specified in radians. Cosine is a fundamental trigonometric function used in physics, engineering, computer graphics, and navigation. It is essential for calculating projections, rotations, wave amplitudes, and force components. If your angle is in degrees, convert it to radians first using the RADIANS function.

## Syntax
```
=COS(number)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number | Required | The angle in radians for which you want the cosine. |

## Remarks
- The input must be in radians. Use RADIANS(angle) to convert from degrees.
- The result is always between -1 and 1.
- COS(0) = 1, COS(PI()/2) = 0 (approximately), COS(PI()) = -1.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | **Force (N)** | **Angle (degrees)** | **Horizontal Component** |
| 2 | 100 | 60 | =A2*COS(RADIANS(B2)) |

**Result:** 50

A 100 Newton force applied at 60 degrees has a horizontal component of 100 * cos(60) = 50 Newtons.
