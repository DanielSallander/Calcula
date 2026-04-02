# IMLOG2 function

## Introduction
The IMLOG2 function returns the base-2 logarithm of a complex number. It is calculated as IMLN(z) / ln(2), where z is the complex number. This is useful in information theory and digital signal processing.

## Syntax
```
=IMLOG2(inumber)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| inumber | Required | A complex number for which you want the base-2 logarithm. Enter as a text string in the form "x+yi" or "x+yj". |

## Remarks
- If **inumber** is not a valid complex number, IMLOG2 returns a #NUM! error.
- If **inumber** is 0, IMLOG2 returns a #NUM! error.

## Example

| | A | B |
|---|---|---|
| 1 | **Complex** | **Log Base 2** |
| 2 | 3+4i | =IMLOG2(A2) |

**Result:** "2.32192809488736+1.33780421245098i" (approximately)

The formula returns the base-2 logarithm of the complex number 3+4i.
