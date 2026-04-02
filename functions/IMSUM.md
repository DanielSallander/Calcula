# IMSUM function

## Introduction
The IMSUM function returns the sum of two or more complex numbers. Addition is performed by adding the real parts and the imaginary parts separately.

## Syntax
```
=IMSUM(inumber1, [inumber2], ...)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| inumber1 | Required | The first complex number to add. Enter as a text string in the form "x+yi" or "x+yj". |
| inumber2, ... | Optional | Additional complex numbers to add. Up to 255 arguments. |

## Remarks
- If any argument is not a valid complex number, IMSUM returns a #NUM! error.
- You can add up to 255 complex numbers.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | **Complex 1** | **Complex 2** | **Sum** |
| 2 | 3+4i | 5-3i | =IMSUM(A2, B2) |

**Result:** "8+i"

The formula adds 3+4i and 5-3i, returning 8+i.
