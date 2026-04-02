# IMEXP function

## Introduction
The IMEXP function returns the exponential of a complex number. For a complex number x+yi, the result is e^x * (cos(y) + sin(y)i), where e is the base of the natural logarithm.

## Syntax
```
=IMEXP(inumber)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| inumber | Required | A complex number for which you want the exponential. Enter as a text string in the form "x+yi" or "x+yj". |

## Remarks
- If **inumber** is not a valid complex number, IMEXP returns a #NUM! error.

## Example

| | A | B |
|---|---|---|
| 1 | **Complex** | **Exponential** |
| 2 | 1+i | =IMEXP(A2) |

**Result:** "1.46869393991589+2.28735528717884i" (approximately)

The formula returns e raised to the power of the complex number 1+i.
