# ATAN function

## Introduction
The ATAN function returns the arctangent (inverse tangent) of a number, giving the angle whose tangent equals the specified value. The result is in radians. ATAN is used in navigation, surveying, slope calculations, and any scenario where you need to determine an angle from a tangent ratio (such as rise over run).

## Syntax
```
=ATAN(number)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number | Required | The tangent value for which you want the angle. Any real number is valid. |

## Remarks
- The result is in radians, in the range -PI()/2 to PI()/2 (-90 to 90 degrees).
- To convert the result to degrees, use the DEGREES function: `=DEGREES(ATAN(number))`.
- ATAN(0) = 0, ATAN(1) = PI()/4 (45 degrees).
- For determining the angle from x and y coordinates (handling all four quadrants), use ATAN2 instead.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | **Rise** | **Run** | **Slope Angle (degrees)** |
| 2 | 3 | 4 | =DEGREES(ATAN(A2/B2)) |

**Result:** 36.87

A ramp with a rise of 3 and a run of 4 has a slope angle of approximately 36.87 degrees.
