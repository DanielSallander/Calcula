# IMLOG10 function

## Introduction
The IMLOG10 function returns the base-10 logarithm of a complex number. It is calculated as IMLN(z) / ln(10), where z is the complex number.

## Syntax
```
=IMLOG10(inumber)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| inumber | Required | A complex number for which you want the base-10 logarithm. Enter as a text string in the form "x+yi" or "x+yj". |

## Remarks
- If **inumber** is not a valid complex number, IMLOG10 returns a #NUM! error.
- If **inumber** is 0, IMLOG10 returns a #NUM! error.

## Example

| | A | B |
|---|---|---|
| 1 | **Complex** | **Log Base 10** |
| 2 | 3+4i | =IMLOG10(A2) |

**Result:** "0.698970004336019+0.402719196273373i" (approximately)

The formula returns the base-10 logarithm of the complex number 3+4i.
