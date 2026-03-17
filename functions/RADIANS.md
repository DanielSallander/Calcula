# RADIANS function

## Introduction
The RADIANS function converts an angle from degrees to radians. Since spreadsheet trigonometric functions (SIN, COS, TAN) require input in radians, RADIANS is the standard way to prepare degree-based angle values for these calculations. It is essential when working with angles expressed in the everyday degree format.

## Syntax
```
=RADIANS(angle)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| angle | Required | The angle in degrees that you want to convert to radians. |

## Remarks
- The conversion formula is: radians = angle * (PI() / 180).
- RADIANS(180) = PI().
- RADIANS(360) = 2 * PI().
- RADIANS(0) = 0.
- This is the inverse of the DEGREES function.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | **Angle (degrees)** | **Radians** | **Sine** |
| 2 | 45 | =RADIANS(A2) | =SIN(B2) |
| 3 | 90 | =RADIANS(A3) | =SIN(B3) |

**Results:**
- B2: 0.7854 (PI/4), C2: 0.7071
- B3: 1.5708 (PI/2), C3: 1

The RADIANS function converts the degree values so they can be used directly in the SIN function.
