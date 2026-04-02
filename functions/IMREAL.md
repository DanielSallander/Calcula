# IMREAL function

## Introduction
The IMREAL function returns the real coefficient of a complex number. For a complex number in the form x+yi, this function returns x.

## Syntax
```
=IMREAL(inumber)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| inumber | Required | A complex number for which you want the real coefficient. Enter as a text string in the form "x+yi" or "x+yj". |

## Remarks
- If **inumber** is not a valid complex number, IMREAL returns a #NUM! error.
- Use the COMPLEX function to create a complex number from real and imaginary components.

## Example

| | A | B |
|---|---|---|
| 1 | **Complex** | **Real Part** |
| 2 | 3+4i | =IMREAL(A2) |

**Result:** 3

The formula extracts the real coefficient 3 from the complex number 3+4i.
