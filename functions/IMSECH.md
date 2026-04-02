# IMSECH function

## Introduction
The IMSECH function returns the hyperbolic secant of a complex number. The hyperbolic secant is defined as 1/cosh(z), where z is the complex number.

## Syntax
```
=IMSECH(inumber)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| inumber | Required | A complex number for which you want the hyperbolic secant. Enter as a text string in the form "x+yi" or "x+yj". |

## Remarks
- If **inumber** is not a valid complex number, IMSECH returns a #NUM! error.

## Example

| | A | B |
|---|---|---|
| 1 | **Complex** | **Hyperbolic Secant** |
| 2 | 1+i | =IMSECH(A2) |

**Result:** "0.498337030555187-0.591083841721045i" (approximately)

The formula returns the hyperbolic secant of the complex number 1+i.
