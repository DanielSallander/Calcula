# IMSUB function

## Introduction
The IMSUB function returns the difference of two complex numbers. Subtraction is performed by subtracting the real parts and the imaginary parts separately: (a+bi) - (c+di) = (a-c) + (b-d)i.

## Syntax
```
=IMSUB(inumber1, inumber2)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| inumber1 | Required | The complex number from which to subtract. Enter as a text string in the form "x+yi" or "x+yj". |
| inumber2 | Required | The complex number to subtract. Enter as a text string in the form "x+yi" or "x+yj". |

## Remarks
- If either argument is not a valid complex number, IMSUB returns a #NUM! error.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | **Complex 1** | **Complex 2** | **Difference** |
| 2 | 13+4i | 5+3i | =IMSUB(A2, B2) |

**Result:** "8+i"

The formula subtracts 5+3i from 13+4i, returning 8+i.
