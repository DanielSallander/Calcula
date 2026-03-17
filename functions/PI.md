# PI function

## Introduction
The PI function returns the mathematical constant pi (approximately 3.14159265358979). Pi represents the ratio of a circle's circumference to its diameter and appears throughout geometry, trigonometry, physics, and engineering. Use PI in formulas that calculate areas and circumferences of circles, volumes of cylinders and spheres, and in trigonometric conversions.

## Syntax
```
=PI()
```

This function takes no arguments.

## Remarks
- PI returns the value of pi accurate to 15 significant digits: 3.14159265358979.
- PI is a constant and does not change between calculations.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | **Shape** | **Radius** | **Area** |
| 2 | Circle | 5 | =PI()*POWER(B2, 2) |
| 3 | Circle | 10 | =PI()*POWER(B3, 2) |

**Results:**
- C2: 78.5398 (area of a circle with radius 5)
- C3: 314.1593 (area of a circle with radius 10)

The formula uses the standard area equation A = pi * r^2 to calculate each circle's area.
