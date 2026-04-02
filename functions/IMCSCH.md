# IMCSCH function

## Introduction
The IMCSCH function returns the hyperbolic cosecant of a complex number. The hyperbolic cosecant is defined as 1/sinh(z), where z is the complex number.

## Syntax
```
=IMCSCH(inumber)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| inumber | Required | A complex number for which you want the hyperbolic cosecant. Enter as a text string in the form "x+yi" or "x+yj". |

## Remarks
- If **inumber** is not a valid complex number, IMCSCH returns a #NUM! error.
- If **inumber** is 0, IMCSCH returns a #NUM! error (division by zero).

## Example

| | A | B |
|---|---|---|
| 1 | **Complex** | **Hyperbolic Cosecant** |
| 2 | 1+i | =IMCSCH(A2) |

**Result:** "0.303931001628426-0.621518017170428i" (approximately)

The formula returns the hyperbolic cosecant of the complex number 1+i.
