# IMSIN function

## Introduction
The IMSIN function returns the sine of a complex number. The sine of a complex number x+yi is defined as sin(x)cosh(y) + cos(x)sinh(y)i.

## Syntax
```
=IMSIN(inumber)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| inumber | Required | A complex number for which you want the sine. Enter as a text string in the form "x+yi" or "x+yj". |

## Remarks
- If **inumber** is not a valid complex number, IMSIN returns a #NUM! error.

## Example

| | A | B |
|---|---|---|
| 1 | **Complex** | **Sine** |
| 2 | 1+i | =IMSIN(A2) |

**Result:** "1.29845758141598+0.634963914784736i" (approximately)

The formula returns the sine of the complex number 1+i.
