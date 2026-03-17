# ASIN function

## Introduction
The ASIN function returns the arcsine (inverse sine) of a number, giving the angle whose sine equals the specified value. The result is in radians. ASIN is used in physics, engineering, and navigation to determine angles from known ratios, such as calculating the launch angle needed for a projectile or the angle of incidence in optics.

## Syntax
```
=ASIN(number)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number | Required | The sine value for which you want the angle. Must be between -1 and 1. |

## Remarks
- If **number** < -1 or **number** > 1, ASIN returns a #NUM! error.
- The result is in radians, in the range -PI()/2 to PI()/2 (-90 to 90 degrees).
- To convert the result to degrees, use the DEGREES function: `=DEGREES(ASIN(number))`.
- ASIN(0) = 0, ASIN(1) = PI()/2.

## Example

| | A | B |
|---|---|---|
| 1 | **Sine Value** | **Angle (degrees)** |
| 2 | 0.5 | =DEGREES(ASIN(A2)) |
| 3 | 1 | =DEGREES(ASIN(A3)) |

**Results:**
- B2: 30 (the angle whose sine is 0.5 is 30 degrees)
- B3: 90 (the angle whose sine is 1 is 90 degrees)
