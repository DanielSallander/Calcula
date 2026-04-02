# IMABS function

## Introduction
The IMABS function returns the absolute value (modulus) of a complex number. The modulus of a complex number x+yi is calculated as the square root of (x^2 + y^2). This represents the distance from the origin to the point in the complex plane.

## Syntax
```
=IMABS(inumber)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| inumber | Required | A complex number for which you want the absolute value. Enter as a text string in the form "x+yi" or "x+yj". |

## Remarks
- If **inumber** is not a valid complex number, IMABS returns a #NUM! error.
- Use the COMPLEX function to create a complex number from real and imaginary components.

## Example

| | A | B |
|---|---|---|
| 1 | **Complex** | **Modulus** |
| 2 | 3+4i | =IMABS(A2) |

**Result:** 5

The modulus of 3+4i is the square root of (3^2 + 4^2) = the square root of 25 = 5.
