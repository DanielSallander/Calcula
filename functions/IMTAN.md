# IMTAN function

## Introduction
The IMTAN function returns the tangent of a complex number. The tangent is defined as sin(z)/cos(z), where z is the complex number.

## Syntax
```
=IMTAN(inumber)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| inumber | Required | A complex number for which you want the tangent. Enter as a text string in the form "x+yi" or "x+yj". |

## Remarks
- If **inumber** is not a valid complex number, IMTAN returns a #NUM! error.

## Example

| | A | B |
|---|---|---|
| 1 | **Complex** | **Tangent** |
| 2 | 1+i | =IMTAN(A2) |

**Result:** "0.271752585319512+1.08392332733869i" (approximately)

The formula returns the tangent of the complex number 1+i.
