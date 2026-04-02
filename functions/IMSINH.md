# IMSINH function

## Introduction
The IMSINH function returns the hyperbolic sine of a complex number. The hyperbolic sine is defined as (e^z - e^(-z)) / 2, where z is the complex number.

## Syntax
```
=IMSINH(inumber)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| inumber | Required | A complex number for which you want the hyperbolic sine. Enter as a text string in the form "x+yi" or "x+yj". |

## Remarks
- If **inumber** is not a valid complex number, IMSINH returns a #NUM! error.

## Example

| | A | B |
|---|---|---|
| 1 | **Complex** | **Hyperbolic Sine** |
| 2 | 1+i | =IMSINH(A2) |

**Result:** "0.634963914784736+1.29845758141598i" (approximately)

The formula returns the hyperbolic sine of the complex number 1+i.
