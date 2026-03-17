# DEGREES function

## Introduction
The DEGREES function converts an angle from radians to degrees. Since many trigonometric functions in spreadsheets work with radians, DEGREES is essential for displaying results in the more commonly understood degree format. It is frequently used after ATAN, ASIN, ACOS, and ATAN2 to convert their radian output to degrees.

## Syntax
```
=DEGREES(angle)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| angle | Required | The angle in radians that you want to convert to degrees. |

## Remarks
- The conversion formula is: degrees = angle * (180 / PI()).
- DEGREES(PI()) = 180.
- DEGREES(0) = 0.
- This is the inverse of the RADIANS function.

## Example

| | A | B |
|---|---|---|
| 1 | **Radians** | **Degrees** |
| 2 | =PI() | =DEGREES(A2) |
| 3 | =PI()/2 | =DEGREES(A3) |
| 4 | 1 | =DEGREES(A4) |

**Results:**
- B2: 180
- B3: 90
- B4: 57.2958 (1 radian is approximately 57.3 degrees)
