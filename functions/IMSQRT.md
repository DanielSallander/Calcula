# IMSQRT function

## Introduction
The IMSQRT function returns the square root of a complex number. The result is computed using the polar form of the complex number.

## Syntax
```
=IMSQRT(inumber)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| inumber | Required | A complex number for which you want the square root. Enter as a text string in the form "x+yi" or "x+yj". |

## Remarks
- If **inumber** is not a valid complex number, IMSQRT returns a #NUM! error.
- The function returns the principal square root.

## Example

| | A | B |
|---|---|---|
| 1 | **Complex** | **Square Root** |
| 2 | 1+i | =IMSQRT(A2) |

**Result:** "1.09868411346781+0.455089860562227i" (approximately)

The formula returns the principal square root of the complex number 1+i.
