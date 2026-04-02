# IMCOS function

## Introduction
The IMCOS function returns the cosine of a complex number. The cosine of a complex number x+yi is defined using the formula cos(x)cosh(y) - sin(x)sinh(y)i.

## Syntax
```
=IMCOS(inumber)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| inumber | Required | A complex number for which you want the cosine. Enter as a text string in the form "x+yi" or "x+yj". |

## Remarks
- If **inumber** is not a valid complex number, IMCOS returns a #NUM! error.

## Example

| | A | B |
|---|---|---|
| 1 | **Complex** | **Cosine** |
| 2 | 1+i | =IMCOS(A2) |

**Result:** "0.833730025131149-0.988897705762865i" (approximately)

The formula returns the cosine of the complex number 1+i.
