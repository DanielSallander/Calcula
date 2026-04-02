# IMAGINARY function

## Introduction
The IMAGINARY function returns the imaginary coefficient of a complex number. For a complex number in the form x+yi, this function returns y.

## Syntax
```
=IMAGINARY(inumber)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| inumber | Required | A complex number for which you want the imaginary coefficient. Enter as a text string in the form "x+yi" or "x+yj". |

## Remarks
- If **inumber** is not a valid complex number, IMAGINARY returns a #NUM! error.
- Use the COMPLEX function to create a complex number from real and imaginary components.

## Example

| | A | B |
|---|---|---|
| 1 | **Complex** | **Imaginary Part** |
| 2 | 3+4i | =IMAGINARY(A2) |

**Result:** 4

The formula extracts the imaginary coefficient 4 from the complex number 3+4i.
