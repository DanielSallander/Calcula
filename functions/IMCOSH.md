# IMCOSH function

## Introduction
The IMCOSH function returns the hyperbolic cosine of a complex number. The hyperbolic cosine of a complex number is defined as (e^z + e^(-z)) / 2, where z is the complex number.

## Syntax
```
=IMCOSH(inumber)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| inumber | Required | A complex number for which you want the hyperbolic cosine. Enter as a text string in the form "x+yi" or "x+yj". |

## Remarks
- If **inumber** is not a valid complex number, IMCOSH returns a #NUM! error.

## Example

| | A | B |
|---|---|---|
| 1 | **Complex** | **Hyperbolic Cosine** |
| 2 | 1+i | =IMCOSH(A2) |

**Result:** "0.833730025131149+0.988897705762865i" (approximately)

The formula returns the hyperbolic cosine of the complex number 1+i.
