# IMCONJUGATE function

## Introduction
The IMCONJUGATE function returns the complex conjugate of a complex number. The conjugate of x+yi is x-yi. Complex conjugates are important in many mathematical operations, including division of complex numbers and finding magnitudes.

## Syntax
```
=IMCONJUGATE(inumber)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| inumber | Required | A complex number for which you want the conjugate. Enter as a text string in the form "x+yi" or "x+yj". |

## Remarks
- If **inumber** is not a valid complex number, IMCONJUGATE returns a #NUM! error.

## Example

| | A | B |
|---|---|---|
| 1 | **Complex** | **Conjugate** |
| 2 | 3+4i | =IMCONJUGATE(A2) |

**Result:** "3-4i"

The formula returns the conjugate of 3+4i, which is 3-4i (the sign of the imaginary part is flipped).
