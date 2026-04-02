# COMPLEX function

## Introduction
The COMPLEX function creates a complex number from a real coefficient and an imaginary coefficient. Complex numbers are used extensively in engineering, physics, and signal processing. The result is returned as a text string in the form "x+yi" or "x+yj".

## Syntax
```
=COMPLEX(real_num, i_num, [suffix])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| real_num | Required | The real coefficient of the complex number. |
| i_num | Required | The imaginary coefficient of the complex number. |
| suffix | Optional | The suffix for the imaginary component. Must be either "i" or "j". If omitted, defaults to "i". |

## Remarks
- If **suffix** is not "i" or "j", COMPLEX returns a #VALUE! error.
- If **real_num** or **i_num** is non-numeric, COMPLEX returns a #VALUE! error.
- If both **real_num** and **i_num** are 0, the result is 0.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | **Real** | **Imaginary** | **Complex** |
| 2 | 3 | 4 | =COMPLEX(A2, B2) |

**Result:** "3+4i"

The formula creates the complex number 3+4i from the real part 3 and imaginary part 4.
