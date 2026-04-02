# IMCOT function

## Introduction
The IMCOT function returns the cotangent of a complex number. The cotangent is defined as cos(z)/sin(z), where z is the complex number.

## Syntax
```
=IMCOT(inumber)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| inumber | Required | A complex number for which you want the cotangent. Enter as a text string in the form "x+yi" or "x+yj". |

## Remarks
- If **inumber** is not a valid complex number, IMCOT returns a #NUM! error.
- If **inumber** is 0, IMCOT returns a #NUM! error (division by zero).

## Example

| | A | B |
|---|---|---|
| 1 | **Complex** | **Cotangent** |
| 2 | 1+i | =IMCOT(A2) |

**Result:** "0.217621561854403-0.868014142895925i" (approximately)

The formula returns the cotangent of the complex number 1+i.
