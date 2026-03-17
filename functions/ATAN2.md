# ATAN2 function

## Introduction
The ATAN2 function returns the arctangent of the specified x and y coordinates, giving the angle (in radians) from the positive x-axis to the point (x, y). Unlike ATAN, which only returns angles in two quadrants, ATAN2 correctly handles all four quadrants, making it essential for navigation, coordinate transformations, and vector angle calculations.

## Syntax
```
=ATAN2(x_num, y_num)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| x_num | Required | The x-coordinate of the point. |
| y_num | Required | The y-coordinate of the point. |

## Remarks
- The result is in radians, in the range -PI() to PI() (-180 to 180 degrees).
- If both **x_num** and **y_num** are 0, ATAN2 returns a #DIV/0! error.
- To convert the result to degrees, use DEGREES: `=DEGREES(ATAN2(x, y))`.
- Note the argument order: x comes first, then y. This differs from some programming languages where y comes first.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | **X** | **Y** | **Angle (degrees)** |
| 2 | 1 | 1 | =DEGREES(ATAN2(A2, B2)) |
| 3 | -1 | 1 | =DEGREES(ATAN2(A3, B3)) |

**Results:**
- C2: 45 (the point (1,1) is at 45 degrees from the positive x-axis)
- C3: 135 (the point (-1,1) is at 135 degrees, correctly in the second quadrant)

ATAN2 correctly identifies the quadrant, unlike ATAN(y/x) which would return the same result for points in different quadrants.
