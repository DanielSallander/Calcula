# ACOS function

## Introduction
The ACOS function returns the arccosine (inverse cosine) of a number, giving the angle whose cosine equals the specified value. The result is in radians. ACOS is used in geometry, physics, and computer graphics to determine angles from known cosine ratios, such as finding the angle between two vectors or the angle of deflection in a mechanical system.

## Syntax
```
=ACOS(number)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number | Required | The cosine value for which you want the angle. Must be between -1 and 1. |

## Remarks
- If **number** < -1 or **number** > 1, ACOS returns a #NUM! error.
- The result is in radians, in the range 0 to PI() (0 to 180 degrees).
- To convert the result to degrees, use the DEGREES function: `=DEGREES(ACOS(number))`.
- ACOS(1) = 0, ACOS(0) = PI()/2, ACOS(-1) = PI().

## Example

| | A | B |
|---|---|---|
| 1 | **Cosine Value** | **Angle (degrees)** |
| 2 | 0.5 | =DEGREES(ACOS(A2)) |
| 3 | 0 | =DEGREES(ACOS(A3)) |

**Results:**
- B2: 60 (the angle whose cosine is 0.5 is 60 degrees)
- B3: 90 (the angle whose cosine is 0 is 90 degrees)
