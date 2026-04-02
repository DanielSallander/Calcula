# IMCSC function

## Introduction
The IMCSC function returns the cosecant of a complex number. The cosecant is defined as 1/sin(z), where z is the complex number.

## Syntax
```
=IMCSC(inumber)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| inumber | Required | A complex number for which you want the cosecant. Enter as a text string in the form "x+yi" or "x+yj". |

## Remarks
- If **inumber** is not a valid complex number, IMCSC returns a #NUM! error.
- If **inumber** is 0, IMCSC returns a #NUM! error (division by zero).

## Example

| | A | B |
|---|---|---|
| 1 | **Complex** | **Cosecant** |
| 2 | 1+i | =IMCSC(A2) |

**Result:** "0.621518017170428-0.303931001628426i" (approximately)

The formula returns the cosecant of the complex number 1+i.
