# IMARGUMENT function

## Introduction
The IMARGUMENT function returns the argument (theta) of a complex number, which is the angle in radians from the positive real axis to the line representing the complex number in the complex plane. For a complex number x+yi, the argument is arctan(y/x).

## Syntax
```
=IMARGUMENT(inumber)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| inumber | Required | A complex number for which you want the argument. Enter as a text string in the form "x+yi" or "x+yj". |

## Remarks
- If **inumber** is not a valid complex number, IMARGUMENT returns a #NUM! error.
- If **inumber** is 0 (both real and imaginary parts are zero), IMARGUMENT returns a #DIV/0! error.
- The result is in radians, in the range (-pi, pi].

## Example

| | A | B |
|---|---|---|
| 1 | **Complex** | **Argument** |
| 2 | 3+4i | =IMARGUMENT(A2) |

**Result:** 0.927295 (approximately)

The formula returns the angle in radians of the complex number 3+4i, which is arctan(4/3).
