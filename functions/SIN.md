# SIN function

## Introduction
The SIN function returns the sine of an angle specified in radians. Sine is a fundamental trigonometric function used in physics (wave motion, oscillations), engineering (signal processing, structural analysis), navigation, and geometry. If your angle is in degrees, convert it to radians first using the RADIANS function.

## Syntax
```
=SIN(number)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number | Required | The angle in radians for which you want the sine. |

## Remarks
- The input must be in radians, not degrees. Use RADIANS(angle) to convert degrees to radians.
- The result is always between -1 and 1.
- SIN(0) = 0, SIN(PI()/2) = 1, SIN(PI()) = 0 (approximately).

## Example

| | A | B |
|---|---|---|
| 1 | **Angle (degrees)** | **Sine** |
| 2 | 30 | =SIN(RADIANS(A2)) |
| 3 | 90 | =SIN(RADIANS(A3)) |
| 4 | 180 | =SIN(RADIANS(A4)) |

**Results:**
- B2: 0.5 (sine of 30 degrees)
- B3: 1 (sine of 90 degrees)
- B4: 0 (sine of 180 degrees, approximately)
