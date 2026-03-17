# TAN function

## Introduction
The TAN function returns the tangent of an angle specified in radians. Tangent is the ratio of sine to cosine and is used in slope calculations, angle-of-elevation problems, surveying, and structural engineering. If your angle is in degrees, convert it to radians first using the RADIANS function.

## Syntax
```
=TAN(number)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number | Required | The angle in radians for which you want the tangent. |

## Remarks
- The input must be in radians. Use RADIANS(angle) to convert from degrees.
- TAN is undefined at odd multiples of PI()/2 (90, 270 degrees, etc.), where cosine equals zero.
- TAN(0) = 0, TAN(PI()/4) = 1.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | **Distance (m)** | **Angle (degrees)** | **Height (m)** |
| 2 | 50 | 35 | =A2*TAN(RADIANS(B2)) |

**Result:** 35.01

Standing 50 meters from a building and measuring an angle of elevation of 35 degrees, the building's height is 50 * tan(35) = approximately 35.01 meters.
