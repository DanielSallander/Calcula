# IMLN function

## Introduction
The IMLN function returns the natural logarithm (base e) of a complex number. For a complex number z, the natural logarithm is ln|z| + arg(z)i, where |z| is the modulus and arg(z) is the argument.

## Syntax
```
=IMLN(inumber)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| inumber | Required | A complex number for which you want the natural logarithm. Enter as a text string in the form "x+yi" or "x+yj". |

## Remarks
- If **inumber** is not a valid complex number, IMLN returns a #NUM! error.
- If **inumber** is 0, IMLN returns a #NUM! error.

## Example

| | A | B |
|---|---|---|
| 1 | **Complex** | **Natural Log** |
| 2 | 3+4i | =IMLN(A2) |

**Result:** "1.6094379124341+0.927295218001612i" (approximately)

The formula returns the natural logarithm of 3+4i. The real part is ln(5) and the imaginary part is arctan(4/3).
