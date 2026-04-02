# IMPRODUCT function

## Introduction
The IMPRODUCT function returns the product of two or more complex numbers. Complex multiplication follows the rule (a+bi)(c+di) = (ac-bd) + (ad+bc)i.

## Syntax
```
=IMPRODUCT(inumber1, [inumber2], ...)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| inumber1 | Required | The first complex number to multiply. Enter as a text string in the form "x+yi" or "x+yj". |
| inumber2, ... | Optional | Additional complex numbers to multiply. Up to 255 arguments. |

## Remarks
- If any argument is not a valid complex number, IMPRODUCT returns a #NUM! error.
- You can multiply up to 255 complex numbers.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | **Complex 1** | **Complex 2** | **Product** |
| 2 | 3+4i | 5-3i | =IMPRODUCT(A2, B2) |

**Result:** "27+11i"

The formula multiplies (3+4i) by (5-3i): (3*5 - 4*(-3)) + (3*(-3) + 4*5)i = 27+11i.
