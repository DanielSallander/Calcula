# IMDIV function

## Introduction
The IMDIV function returns the quotient of two complex numbers. Division of complex numbers is performed by multiplying numerator and denominator by the conjugate of the denominator.

## Syntax
```
=IMDIV(inumber1, inumber2)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| inumber1 | Required | The complex numerator (dividend). Enter as a text string in the form "x+yi" or "x+yj". |
| inumber2 | Required | The complex denominator (divisor). Enter as a text string in the form "x+yi" or "x+yj". |

## Remarks
- If either argument is not a valid complex number, IMDIV returns a #NUM! error.
- If **inumber2** is 0, IMDIV returns a #NUM! error.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | **Numerator** | **Denominator** | **Quotient** |
| 2 | -238+240i | 10+24i | =IMDIV(A2, B2) |

**Result:** "5+12i"

The formula divides the complex number -238+240i by 10+24i, returning the quotient 5+12i.
