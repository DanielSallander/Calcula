# IMSEC function

## Introduction
The IMSEC function returns the secant of a complex number. The secant is defined as 1/cos(z), where z is the complex number.

## Syntax
```
=IMSEC(inumber)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| inumber | Required | A complex number for which you want the secant. Enter as a text string in the form "x+yi" or "x+yj". |

## Remarks
- If **inumber** is not a valid complex number, IMSEC returns a #NUM! error.

## Example

| | A | B |
|---|---|---|
| 1 | **Complex** | **Secant** |
| 2 | 1+i | =IMSEC(A2) |

**Result:** "0.498337030555187+0.591083841721045i" (approximately)

The formula returns the secant of the complex number 1+i.
